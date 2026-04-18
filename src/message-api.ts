/**
 * Message API — POST /api/v1/messages endpoint for proactive messaging.
 *
 * Features:
 *   - Template types: alert, digest, notification, custom
 *   - Priority levels: critical, high, normal, low (controls send order)
 *   - Batching: messages with matching batch_key within batch_window are aggregated
 *   - Rate limiting: max N messages per recipient per time window
 *   - Retry logic: exponential backoff, max 3 retries
 *   - Delivery logging to SQLite
 */
import crypto from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import {
  countRecentMessages,
  getBatchedMessages,
  getOutboundMessage,
  insertOutboundMessage,
  updateMessageStatus,
} from './db/index.js';
import type {
  MessagePriority,
  MessageTemplate,
  OutboundMessage,
} from './db/index.js';
import { logger } from './logger.js';
import { Channel } from './types.js';

// --- Config ---

const MESSAGE_API_PORT = parseInt(
  process.env.MESSAGE_API_PORT || '3003',
  10,
);
const RATE_LIMIT_MAX = parseInt(
  process.env.MESSAGE_RATE_LIMIT_MAX || '10',
  10,
);
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.MESSAGE_RATE_LIMIT_WINDOW_MS || '60000',
  10,
);
const MAX_RETRIES = 3;
const DEFAULT_BATCH_WINDOW_MS = 300_000; // 5 minutes

// --- Template rendering ---

const TEMPLATE_RENDERERS: Record<
  MessageTemplate,
  (content: string) => string
> = {
  alert: (content) => `🚨 *Alert*\n\n${content}`,
  digest: (content) => `📋 *Digest*\n\n${content}`,
  notification: (content) => `🔔 ${content}`,
  custom: (content) => content,
};

export function renderTemplate(
  template: MessageTemplate,
  content: string,
): string {
  const renderer = TEMPLATE_RENDERERS[template];
  return renderer ? renderer(content) : content;
}

// --- Request validation ---

const VALID_PRIORITIES: MessagePriority[] = [
  'critical',
  'high',
  'normal',
  'low',
];
const VALID_TEMPLATES: MessageTemplate[] = [
  'alert',
  'digest',
  'notification',
  'custom',
];

interface MessageRequest {
  recipient: string;
  recipient_type?: string;
  template?: MessageTemplate;
  content: string;
  priority?: MessagePriority;
  scheduled_for?: string;
  batch_key?: string;
  batch_window?: number;
}

function validateRequest(
  body: unknown,
): { ok: true; data: MessageRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  if (!obj.recipient || typeof obj.recipient !== 'string') {
    return { ok: false, error: 'recipient is required and must be a string' };
  }
  if (!obj.content || typeof obj.content !== 'string') {
    return { ok: false, error: 'content is required and must be a string' };
  }

  if (
    obj.template !== undefined &&
    !VALID_TEMPLATES.includes(obj.template as MessageTemplate)
  ) {
    return {
      ok: false,
      error: `template must be one of: ${VALID_TEMPLATES.join(', ')}`,
    };
  }

  if (
    obj.priority !== undefined &&
    !VALID_PRIORITIES.includes(obj.priority as MessagePriority)
  ) {
    return {
      ok: false,
      error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}`,
    };
  }

  if (obj.scheduled_for !== undefined) {
    if (typeof obj.scheduled_for !== 'string' || isNaN(Date.parse(obj.scheduled_for))) {
      return {
        ok: false,
        error: 'scheduled_for must be a valid ISO 8601 date string',
      };
    }
  }

  if (obj.batch_window !== undefined) {
    if (typeof obj.batch_window !== 'number' || obj.batch_window < 0) {
      return {
        ok: false,
        error: 'batch_window must be a non-negative number (milliseconds)',
      };
    }
  }

  return {
    ok: true,
    data: {
      recipient: obj.recipient as string,
      recipient_type: (obj.recipient_type as string) || 'channel_jid',
      template: (obj.template as MessageTemplate) || 'custom',
      content: obj.content as string,
      priority: (obj.priority as MessagePriority) || 'normal',
      scheduled_for: obj.scheduled_for as string | undefined,
      batch_key: obj.batch_key as string | undefined,
      batch_window: obj.batch_window as number | undefined,
    },
  };
}

// --- Batching ---

const batchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleBatchFlush(
  batchKey: string,
  windowMs: number,
  sendFn: (jid: string, text: string) => Promise<void>,
): void {
  // Don't reschedule if timer already exists
  if (batchTimers.has(batchKey)) return;

  const timer = setTimeout(async () => {
    batchTimers.delete(batchKey);
    await flushBatch(batchKey, sendFn);
  }, windowMs);

  batchTimers.set(batchKey, timer);
}

async function flushBatch(
  batchKey: string,
  sendFn: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  const messages = getBatchedMessages(batchKey);
  if (messages.length === 0) return;

  // Group by recipient
  const byRecipient = new Map<string, OutboundMessage[]>();
  for (const msg of messages) {
    const list = byRecipient.get(msg.recipient_id) ?? [];
    list.push(msg);
    byRecipient.set(msg.recipient_id, list);
  }

  for (const [recipientId, msgs] of byRecipient) {
    const rendered = msgs.map((m) => renderTemplate(m.template as MessageTemplate, m.content));
    const combined =
      rendered.length === 1
        ? rendered[0]
        : `📦 *Batched messages (${rendered.length})*\n\n${rendered.map((r, i) => `${i + 1}. ${r}`).join('\n\n')}`;

    try {
      await sendFn(recipientId, combined);
      for (const m of msgs) updateMessageStatus(m.id, 'sent');
      logger.info(
        { batchKey, recipientId, count: msgs.length },
        'Batch flushed',
      );
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Unknown delivery error';
      for (const m of msgs) updateMessageStatus(m.id, 'failed', errMsg);
      logger.error(
        { batchKey, recipientId, err },
        'Batch delivery failed',
      );
    }
  }
}

// --- Retry logic ---

function retryDelay(retryCount: number): number {
  // Exponential backoff: 1s, 2s, 4s
  return Math.min(1000 * Math.pow(2, retryCount), 8000);
}

async function deliverWithRetry(
  msg: OutboundMessage,
  sendFn: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  const text = renderTemplate(
    msg.template as MessageTemplate,
    msg.content,
  );

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      updateMessageStatus(msg.id, 'sending');
      await sendFn(msg.recipient_id, text);
      updateMessageStatus(msg.id, 'sent');
      logger.info(
        { messageId: msg.id, recipient: msg.recipient_id, attempt },
        'Message delivered',
      );
      return;
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Unknown delivery error';

      if (attempt < MAX_RETRIES) {
        logger.warn(
          { messageId: msg.id, attempt, err },
          'Delivery failed, retrying',
        );
        updateMessageStatus(msg.id, 'failed', errMsg);
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelay(attempt)),
        );
        // Reset to pending for next attempt
        updateMessageStatus(msg.id, 'pending');
      } else {
        updateMessageStatus(msg.id, 'failed', errMsg);
        logger.error(
          { messageId: msg.id, recipient: msg.recipient_id, err },
          'Message delivery failed after max retries',
        );
      }
    }
  }
}

// --- Channel send function ---

export type ChannelProvider = () => Channel[];

function createSendFn(
  channelProvider: ChannelProvider,
): (jid: string, text: string) => Promise<void> {
  return async (jid: string, text: string) => {
    const channels = channelProvider();
    const channel = channels.find(
      (c) => c.ownsJid(jid) && c.isConnected(),
    );
    if (!channel) {
      throw new Error(`No connected channel for recipient: ${jid}`);
    }
    await channel.sendMessage(jid, text);
  };
}

// --- HTTP request parsing ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1_048_576; // 1MB

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function jsonResponse(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// --- Route handler ---

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  sendFn: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const validation = validateRequest(body);
  if (!validation.ok) {
    jsonResponse(res, 400, { error: validation.error });
    return;
  }

  const data = validation.data;

  // Rate limiting
  const recentCount = countRecentMessages(
    data.recipient,
    RATE_LIMIT_WINDOW_MS,
  );
  if (recentCount >= RATE_LIMIT_MAX) {
    jsonResponse(res, 429, {
      error: `Rate limit exceeded: max ${RATE_LIMIT_MAX} messages per ${RATE_LIMIT_WINDOW_MS / 1000}s for this recipient`,
    });
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const isBatched = !!data.batch_key;
  const batchWindow = data.batch_window ?? DEFAULT_BATCH_WINDOW_MS;

  insertOutboundMessage({
    id,
    recipient_id: data.recipient,
    recipient_type: data.recipient_type || 'channel_jid',
    template: data.template || 'custom',
    content: data.content,
    priority: data.priority || 'normal',
    status: isBatched ? 'batched' : 'pending',
    scheduled_for: data.scheduled_for || null,
    batch_key: data.batch_key || null,
    batch_window: batchWindow,
    created_at: now,
  });

  if (isBatched) {
    scheduleBatchFlush(data.batch_key!, batchWindow, sendFn);
    jsonResponse(res, 201, {
      id,
      status: 'batched',
      batch_key: data.batch_key,
    });
    return;
  }

  // Scheduled messages — store as pending for later processing
  if (data.scheduled_for) {
    jsonResponse(res, 201, {
      id,
      status: 'pending',
      scheduled_for: data.scheduled_for,
    });
    return;
  }

  // Immediate delivery with retry
  const msg = getOutboundMessage(id);
  if (msg) {
    // Fire and forget — respond immediately, deliver async
    deliverWithRetry(msg, sendFn).catch((err) =>
      logger.error({ messageId: id, err }, 'Async delivery error'),
    );
  }

  jsonResponse(res, 201, { id, status: 'pending' });
}

// --- Server ---

let httpServer: Server | null = null;

export function startMessageApi(
  channelProvider: ChannelProvider,
  port: number = MESSAGE_API_PORT,
  host: string = '127.0.0.1',
): Promise<Server> {
  const sendFn = createSendFn(channelProvider);

  return new Promise((resolve, reject) => {
    httpServer = createServer(async (req, res) => {
      // POST /api/v1/messages
      if (req.method === 'POST' && req.url === '/api/v1/messages') {
        try {
          await handlePostMessage(req, res, sendFn);
        } catch (err) {
          logger.error({ err }, 'Unhandled error in message API');
          jsonResponse(res, 500, { error: 'Internal server error' });
        }
        return;
      }

      // GET /api/v1/messages/:id — check message status
      if (
        req.method === 'GET' &&
        req.url?.startsWith('/api/v1/messages/')
      ) {
        const id = req.url.slice('/api/v1/messages/'.length);
        if (!id) {
          jsonResponse(res, 400, { error: 'Message ID required' });
          return;
        }
        const msg = getOutboundMessage(id);
        if (!msg) {
          jsonResponse(res, 404, { error: 'Message not found' });
          return;
        }
        jsonResponse(res, 200, {
          id: msg.id,
          recipient_id: msg.recipient_id,
          template: msg.template,
          priority: msg.priority,
          status: msg.status,
          created_at: msg.created_at,
          sent_at: msg.sent_at,
          error_message: msg.error_message,
          retry_count: msg.retry_count,
        });
        return;
      }

      jsonResponse(res, 404, { error: 'Not found' });
    });

    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      logger.info({ port, host }, 'Message API server started');
      resolve(httpServer!);
    });
  });
}

export function stopMessageApi(): Promise<void> {
  return new Promise((resolve) => {
    // Clear any pending batch timers
    for (const timer of batchTimers.values()) {
      clearTimeout(timer);
    }
    batchTimers.clear();

    if (httpServer) {
      const server = httpServer;
      httpServer = null;
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}

/** @internal — exported for testing */
export {
  validateRequest as _validateRequest,
  handlePostMessage as _handlePostMessage,
  deliverWithRetry as _deliverWithRetry,
  flushBatch as _flushBatch,
  RATE_LIMIT_MAX as _RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS as _RATE_LIMIT_WINDOW_MS,
};
