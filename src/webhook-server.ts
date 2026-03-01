import crypto from 'crypto';
import http from 'http';

import { logger } from './logger.js';
import { validateToken } from './webhook-tokens.js';

// Deduplication: prevent processing the same webhook event twice.
// Providers retry failed deliveries with exponential backoff — without this,
// a slow handler or transient error causes duplicate messages.
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const seenEventIds = new Map<string, number>(); // eventId -> timestamp (ms)

function extractEventId(headers: http.IncomingHttpHeaders, body: string): string {
  // Check standard event ID headers across common providers
  for (const h of ['x-github-delivery', 'x-request-id', 'x-webhook-id', 'x-event-id']) {
    const val = headers[h];
    if (val && typeof val === 'string') return val;
  }
  // Fall back to SHA-256 of body — deterministic across retries of the same payload
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
}

function isDuplicate(eventId: string): boolean {
  if (seenEventIds.has(eventId)) return true;

  // Evict stale entries to keep memory bounded
  const now = Date.now();
  if (seenEventIds.size > 10_000) {
    for (const [id, ts] of seenEventIds) {
      if (now - ts > DEDUP_WINDOW_MS) seenEventIds.delete(id);
    }
  }

  seenEventIds.set(eventId, now);
  return false;
}

const MAX_BODY_SIZE = 1_048_576; // 1MB

interface WebhookServerOpts {
  port: number;
  storeMessage: (msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
  }) => void;
}

export function startWebhookServer(opts: WebhookServerOpts): http.Server {
  const { port, storeMessage } = opts;

  const server = http.createServer((req, res) => {
    // Only accept POST /webhook/:token
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const match = req.url?.match(/^\/webhook\/([a-f0-9-]+)$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const token = match[1];
    const tokenInfo = validateToken(token);
    if (!tokenInfo) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid token' }));
      return;
    }

    let body = '';
    let exceeded = false;

    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_SIZE) {
        exceeded = true;
        req.destroy();
      }
    });

    req.on('end', () => {
      if (exceeded) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        return;
      }

      const eventId = extractEventId(req.headers, body);
      if (isDuplicate(eventId)) {
        logger.info({ source: tokenInfo.source, eventId }, 'Duplicate webhook event ignored');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, duplicate: true }));
        return;
      }

      let payload: unknown;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const now = new Date().toISOString();
      const msgId = `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const content = `[WEBHOOK from ${tokenInfo.source}]\n${JSON.stringify(payload, null, 2)}`;

      storeMessage({
        id: msgId,
        chat_jid: tokenInfo.groupJid,
        sender: 'webhook',
        sender_name: tokenInfo.source,
        content,
        timestamp: now,
        is_from_me: false,
      });

      logger.info({ source: tokenInfo.source, groupJid: tokenInfo.groupJid }, 'Webhook received');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Webhook server error');
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'Webhook server listening');
  });

  return server;
}
