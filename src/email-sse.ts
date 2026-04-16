/**
 * SSE client for real-time email triage notifications from superpilot.
 *
 * Maintains one persistent SSE connection per configured service token.
 * When new triaged emails arrive, writes IPC trigger files for the agent.
 * Each connection has independent reconnect/backoff state.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

import {
  DATA_DIR,
  EMAIL_INTELLIGENCE_ENABLED,
  SSE_CONNECTIONS,
  SUPERPILOT_API_URL,
} from './config.js';
import { eventBus } from './event-bus.js';
import type { EmailReceivedEvent } from './events.js';
import { logger } from './logger.js';
import type { EmailTriggerDebouncer } from './email-trigger-debouncer.js';

const SSE_RECONNECT_MIN_MS = 5_000;
const SSE_RECONNECT_MAX_MS = 300_000; // 5 minutes max backoff

/** Per-connection state for independent reconnect/backoff. */
interface SSEConnection {
  label: string;
  token: string;
  reconnectMs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  currentRequest: ReturnType<typeof https.get> | null;
}

let running = false;
const connections: SSEConnection[] = [];

let debouncer: EmailTriggerDebouncer | null = null;

export function setEmailTriggerDebouncer(d: EmailTriggerDebouncer): void {
  debouncer = d;
}

export function getEmailTriggerDebouncer(): EmailTriggerDebouncer | null {
  return debouncer;
}

/**
 * Start SSE connections to superpilot.
 * Call once at startup — reconnects are handled internally.
 * Spawns one connection per configured service token.
 */
export function startEmailSSE(): void {
  if (!EMAIL_INTELLIGENCE_ENABLED) {
    logger.debug('Email intelligence disabled, skipping SSE connections');
    return;
  }

  if (SSE_CONNECTIONS.length === 0) {
    logger.warn('No NANOCLAW_SERVICE_TOKEN configured, skipping SSE');
    return;
  }

  running = true;

  for (const { token, label } of SSE_CONNECTIONS) {
    const conn: SSEConnection = {
      label,
      token,
      reconnectMs: SSE_RECONNECT_MIN_MS,
      reconnectTimer: null,
      currentRequest: null,
    };
    connections.push(conn);
    connect(conn);
  }

  logger.info(
    { count: connections.length, labels: connections.map((c) => c.label) },
    'SSE connections started',
  );
}

/**
 * Stop all SSE connections.
 */
export function stopEmailSSE(): void {
  running = false;
  for (const conn of connections) {
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    if (conn.currentRequest) {
      conn.currentRequest.destroy();
      conn.currentRequest = null;
    }
  }
  connections.length = 0;
}

function connect(conn: SSEConnection): void {
  if (!running) return;

  const url = new URL(`${SUPERPILOT_API_URL}/nanoclaw/events`);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      Accept: 'text/event-stream',
      'x-service-token': conn.token,
      'Cache-Control': 'no-cache',
    },
  };

  logger.info(
    { url: url.toString(), label: conn.label },
    'SSE connecting to superpilot',
  );

  conn.currentRequest = mod.get(options, (res) => {
    if (res.statusCode !== 200) {
      logger.warn(
        { statusCode: res.statusCode, label: conn.label },
        'SSE connection rejected',
      );
      res.destroy();
      scheduleReconnect(conn);
      return;
    }

    // Connected successfully — reset backoff
    conn.reconnectMs = SSE_RECONNECT_MIN_MS;
    logger.info({ label: conn.label }, 'SSE connected to superpilot');

    let buffer = '';

    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Parse SSE events from buffer
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || ''; // Keep incomplete event in buffer

      for (const part of parts) {
        if (!part.trim() || part.startsWith(':')) continue; // Skip heartbeats/comments

        const lines = part.split('\n');
        let eventType = '';
        let data = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7);
          } else if (line.startsWith('data: ')) {
            data = line.slice(6);
          }
        }

        if (eventType === 'triaged_emails' && data) {
          handleTriagedEmails(data, conn.label);
        }
      }
    });

    res.on('end', () => {
      logger.info({ label: conn.label }, 'SSE connection closed by server');
      scheduleReconnect(conn);
    });

    res.on('error', (err) => {
      logger.warn(
        { err: err.message, label: conn.label },
        'SSE connection error',
      );
      scheduleReconnect(conn);
    });
  });

  conn.currentRequest.on('error', (err) => {
    logger.warn({ err: err.message, label: conn.label }, 'SSE request error');
    scheduleReconnect(conn);
  });
}

function scheduleReconnect(conn: SSEConnection): void {
  if (!running) return;

  conn.currentRequest = null;
  logger.info(
    { reconnectMs: conn.reconnectMs, label: conn.label },
    'SSE reconnecting',
  );

  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null;
    connect(conn);
  }, conn.reconnectMs);

  // Exponential backoff
  conn.reconnectMs = Math.min(conn.reconnectMs * 2, SSE_RECONNECT_MAX_MS);
}

export function writeIpcTrigger(
  emails: Array<{ thread_id: string; account: string; subject?: string; sender?: string }>,
  label: string,
): void {
  const ipcDir = path.join(DATA_DIR, 'ipc', 'whatsapp_main', 'tasks');
  fs.mkdirSync(ipcDir, { recursive: true });

  const payload = {
    type: 'email_trigger',
    emails: emails.map((e) => ({
      thread_id: e.thread_id,
      account: e.account || 'unknown',
      subject: e.subject || '',
      sender: e.sender || '',
    })),
    triggered_at: new Date().toISOString(),
    source: 'sse',
    connection: label,
  };

  const filename = `sse_trigger_${Date.now()}.json`;
  fs.writeFileSync(
    path.join(ipcDir, filename),
    JSON.stringify(payload, null, 2),
  );
  logger.info(
    { count: emails.length, filename, label },
    'SSE email trigger written',
  );
}

function handleTriagedEmails(data: string, label: string): void {
  try {
    const parsed = JSON.parse(data);
    const rawEmails = parsed.emails;
    if (!rawEmails || rawEmails.length === 0) return;

    // Drop test-fixture triggers at the edge. Dev harnesses and QA scripts
    // fire thread_ids like `test-approval-v2`, `test-approval-verify`, etc.
    // that aren't real Gmail threads — processing them wakes the agent for
    // work it can't complete and produces misleading Telegram output.
    const emails = rawEmails.filter(
      (e: { thread_id?: string }) =>
        !!e.thread_id && !/^test-approval[-_]/i.test(e.thread_id),
    );
    if (emails.length === 0) {
      logger.info(
        { skipped: rawEmails.length, label },
        'Skipped SSE trigger — all emails matched test-fixture pattern',
      );
      return;
    }
    if (emails.length < rawEmails.length) {
      logger.info(
        {
          dropped: rawEmails.length - emails.length,
          kept: emails.length,
          label,
        },
        'Filtered test-fixture emails from SSE trigger',
      );
    }

    // Buffer emails in debouncer (merges rapid-fire triggers into one IPC file)
    // or write IPC directly if no debouncer is configured
    if (debouncer) {
      debouncer.add(
        emails.map(
          (e: {
            thread_id: string;
            account: string;
            subject?: string;
            sender?: string;
          }) => ({
            thread_id: e.thread_id,
            account: e.account || 'unknown',
            subject: e.subject || '',
            sender: e.sender || '',
          }),
        ),
        label,
      );
    } else {
      writeIpcTrigger(emails, label);
    }

    // Emit structured event for the event router / proactive monitor
    const emailEvent: EmailReceivedEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: {
        count: emails.length,
        emails: emails.map(
          (e: {
            thread_id: string;
            account: string;
            subject?: string;
            sender?: string;
          }) => ({
            thread_id: e.thread_id,
            account: e.account || 'unknown',
            subject: e.subject || '',
            sender: e.sender || '',
          }),
        ),
        connection: label,
      },
    };
    eventBus.emit('email.received', emailEvent);
  } catch (err) {
    logger.warn(
      { err: String(err), label },
      'Failed to process SSE triaged_emails event',
    );
  }
}
