/**
 * SSE client for real-time email triage notifications from superpilot.
 *
 * Maintains a persistent outbound connection to superpilot's SSE endpoint.
 * When new triaged emails arrive, writes IPC trigger files for the agent.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

import {
  DATA_DIR,
  EMAIL_INTELLIGENCE_ENABLED,
  NANOCLAW_SERVICE_TOKEN,
  SUPERPILOT_API_URL,
} from './config.js';
import { logger } from './logger.js';

const SSE_RECONNECT_MIN_MS = 5_000;
const SSE_RECONNECT_MAX_MS = 300_000; // 5 minutes max backoff
// NANOCLAW_SERVICE_TOKEN imported from config.js (reads .env file)

let reconnectMs = SSE_RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentRequest: ReturnType<typeof https.get> | null = null;
let running = false;

/**
 * Start the SSE connection to superpilot.
 * Call once at startup — reconnects are handled internally.
 */
export function startEmailSSE(): void {
  if (!EMAIL_INTELLIGENCE_ENABLED) {
    logger.debug('Email intelligence disabled, skipping SSE connection');
    return;
  }

  if (!NANOCLAW_SERVICE_TOKEN) {
    logger.warn('NANOCLAW_SERVICE_TOKEN not set, skipping SSE connection');
    return;
  }

  running = true;
  connect();
}

/**
 * Stop the SSE connection.
 */
export function stopEmailSSE(): void {
  running = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (currentRequest) {
    currentRequest.destroy();
    currentRequest = null;
  }
}

function connect(): void {
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
      'x-service-token': NANOCLAW_SERVICE_TOKEN,
      'Cache-Control': 'no-cache',
    },
  };

  logger.info({ url: url.toString() }, 'SSE connecting to superpilot');

  currentRequest = mod.get(options, (res) => {
    if (res.statusCode !== 200) {
      logger.warn({ statusCode: res.statusCode }, 'SSE connection rejected');
      res.destroy();
      scheduleReconnect();
      return;
    }

    // Connected successfully — reset backoff
    reconnectMs = SSE_RECONNECT_MIN_MS;
    logger.info('SSE connected to superpilot');

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
          handleTriagedEmails(data);
        }
      }
    });

    res.on('end', () => {
      logger.info('SSE connection closed by server');
      scheduleReconnect();
    });

    res.on('error', (err) => {
      logger.warn({ err: err.message }, 'SSE connection error');
      scheduleReconnect();
    });
  });

  currentRequest.on('error', (err) => {
    logger.warn({ err: err.message }, 'SSE request error');
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (!running) return;

  currentRequest = null;
  logger.info({ reconnectMs }, 'SSE reconnecting');

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectMs);

  // Exponential backoff
  reconnectMs = Math.min(reconnectMs * 2, SSE_RECONNECT_MAX_MS);
}

function handleTriagedEmails(data: string): void {
  try {
    const parsed = JSON.parse(data);
    const emails = parsed.emails;
    if (!emails || emails.length === 0) return;

    // Write IPC trigger file to whatsapp_main (main group) — the email_trigger
    // handler dispatches to the configured notification channel (Telegram).
    const ipcDir = path.join(DATA_DIR, 'ipc', 'whatsapp_main', 'tasks');
    fs.mkdirSync(ipcDir, { recursive: true });

    const payload = {
      type: 'email_trigger',
      emails: emails.map(
        (e: {
          thread_id: string;
          account: string;
          classified_at?: string;
        }) => ({
          thread_id: e.thread_id,
          account: e.account || 'unknown',
          subject: '',
          sender: '',
        }),
      ),
      triggered_at: new Date().toISOString(),
      source: 'sse',
    };

    const filename = `sse_trigger_${Date.now()}.json`;
    fs.writeFileSync(
      path.join(ipcDir, filename),
      JSON.stringify(payload, null, 2),
    );
    logger.info(
      { count: emails.length, filename },
      'SSE email trigger written',
    );
  } catch (err) {
    logger.warn(
      { err: String(err) },
      'Failed to process SSE triaged_emails event',
    );
  }
}
