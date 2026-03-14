/**
 * Facebook Messenger Channel
 * Receives inbound messages via webhook, sends outbound via Facebook Send API.
 * Marketplace inquiries ("Is this still available?") arrive as standard Messenger messages.
 * JID format: messenger:sheridan
 */
import crypto from 'crypto';
import http from 'http';

import { CircuitBreaker } from '../circuit-breaker.js';
import {
  ASSISTANT_NAME,
  FB_APP_SECRET,
  FB_MESSENGER_PORT,
  FB_PAGE_ACCESS_TOKEN,
  FB_PAGE_ID,
  FB_VERIFY_TOKEN,
} from '../config.js';
import { getLastSender, upsertContactFromPhone } from '../db.js';
import { audit, logger } from '../logger.js';
import { isWebhookRateLimited } from '../pipeline/stages/webhook-guard.js';
import {
  Channel,
  HealthInfo,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// ── Webhook Signature Verification ─────────────────────────────────

function verifySignature(
  signature: string | undefined,
  body: string,
): boolean {
  if (!FB_APP_SECRET) {
    logger.error(
      'FB_APP_SECRET not configured, rejecting webhook request',
    );
    return false;
  }
  if (!signature) return false;

  // Facebook sends: sha256=<hex digest>
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', FB_APP_SECRET).update(body).digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// ── Facebook Graph API ─────────────────────────────────────────────

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

async function sendFacebookMessage(
  recipientId: string,
  text: string,
): Promise<void> {
  const response = await fetch(`${GRAPH_API_BASE}/me/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FB_PAGE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'RESPONSE',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Facebook Send API error ${response.status}: ${body}`);
  }
}

async function sendTypingAction(
  recipientId: string,
  action: 'typing_on' | 'typing_off',
): Promise<void> {
  try {
    await fetch(`${GRAPH_API_BASE}/me/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FB_PAGE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        sender_action: action,
      }),
    });
  } catch (err) {
    logger.debug({ err }, 'Failed to send typing indicator');
  }
}

// ── Channel Implementation ─────────────────────────────────────────

export interface MessengerChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  shouldProcess?: (msg: { id: string; sender: string; content: string; channel: string }) => boolean;
}

export class MessengerChannel implements Channel {
  name = 'messenger';

  private server: http.Server | null = null;
  private connected = false;
  private opts: MessengerChannelOpts;
  private graphBreaker = new CircuitBreaker('messenger-graph-api');

  /** Track last sender per JID for reply routing. */
  private lastSenderByJid = new Map<string, string>();

  constructor(opts: MessengerChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server = http.createServer((req, res) => {
        const ip =
          req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
          req.socket.remoteAddress ||
          'unknown';

        if (isWebhookRateLimited(ip)) {
          logger.warn({ ip }, 'Messenger webhook rate limited');
          audit('webhook_rate_limited', { ip, channel: 'messenger' });
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          });
          res.end('{"error":"rate limited"}');
          return;
        }

        // Facebook webhook verification (GET)
        if (req.method === 'GET' && req.url?.startsWith('/webhook/messenger')) {
          this.handleVerification(req, res);
          return;
        }

        // Facebook webhook events (POST)
        if (req.method === 'POST' && req.url === '/webhook/messenger') {
          this.handleWebhook(req, res);
          return;
        }

        // Health check
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', channel: 'messenger' }));
          return;
        }

        res.writeHead(200);
        res.end('ok');
      });

      this.server.listen(FB_MESSENGER_PORT, () => {
        this.connected = true;
        logger.info(
          { port: FB_MESSENGER_PORT },
          'Messenger webhook server listening',
        );
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Find the recipient PSID to reply to (in-memory first, then DB fallback)
    let recipientId = this.lastSenderByJid.get(jid);
    if (!recipientId) {
      recipientId = getLastSender(jid)?.replace(/^fb:/, '') ?? undefined;
      if (recipientId) {
        this.lastSenderByJid.set(jid, recipientId);
      }
    }
    if (!recipientId) {
      logger.warn({ jid }, 'No recipient known for Messenger reply');
      return;
    }

    // Prefix with assistant name for consistency (same as quo.ts)
    const prefixed = `${ASSISTANT_NAME}: ${text}`;

    // Facebook has a 2000-char limit per message — split if needed
    const chunks = this.splitMessage(prefixed, 2000);

    if (this.graphBreaker.state === 'open') {
      logger.warn({ jid }, 'Messenger Graph API circuit breaker open — skipping send');
      return;
    }

    for (const chunk of chunks) {
      try {
        await this.graphBreaker.call(() => sendFacebookMessage(recipientId!, chunk));
        logger.info(
          { jid, to: recipientId, length: chunk.length },
          'Messenger message sent',
        );
      } catch (err) {
        logger.error({ jid, err }, 'Messenger send error');
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getHealthInfo(): HealthInfo {
    return {
      connected: this.connected,
      lastConnectedAt: null,
      recentDisconnects: [],
      protocolErrorCount: 0,
    };
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('messenger:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) =>
        this.server!.close(() => resolve()),
      );
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const recipientId = this.lastSenderByJid.get(jid);
    if (!recipientId) return;

    await sendTypingAction(
      recipientId,
      isTyping ? 'typing_on' : 'typing_off',
    );
  }

  // ── Webhook Verification ─────────────────────────────────────────

  private handleVerification(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
      logger.info('Messenger webhook verification successful');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge);
    } else {
      logger.warn({ mode, hasToken: !!token }, 'Messenger webhook verification failed');
      res.writeHead(403);
      res.end('Forbidden');
    }
  }

  // ── Webhook Handler ──────────────────────────────────────────────

  private handleWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    let bodySize = 0;
    const MAX_BODY_SIZE = 1_048_576; // 1MB

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end('{"error":"payload too large"}');
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      // Verify webhook signature
      const signature = req.headers['x-hub-signature-256'] as
        | string
        | undefined;
      if (!verifySignature(signature, body)) {
        logger.warn(
          { hasSignature: !!signature },
          'Messenger webhook signature verification failed',
        );
        audit('webhook_signature_failed', {
          hasSignature: !!signature,
          channel: 'messenger',
        });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid signature"}');
        return;
      }

      // Always respond 200 quickly to Facebook (they retry on non-2xx)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');

      // Parse and process
      let payload: any;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        logger.warn({ err }, 'Messenger webhook: invalid JSON');
        return;
      }

      this.processWebhookPayload(payload);
    });
  }

  private processWebhookPayload(payload: any): void {
    // Facebook sends: { object: "page", entry: [...] }
    if (payload.object !== 'page') return;

    const entries = payload.entry;
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      const messaging = entry.messaging;
      if (!Array.isArray(messaging)) continue;

      for (const event of messaging) {
        this.processMessagingEvent(event);
      }
    }
  }

  private processMessagingEvent(event: any): void {
    // Only handle text messages (ignore deliveries, reads, postbacks for now)
    if (!event.message?.text) return;

    // Ignore echo messages (messages sent by the page itself)
    if (event.message.is_echo) return;

    const senderId = event.sender?.id;
    const messageId = event.message.mid;
    const text = event.message.text;
    const timestamp = event.timestamp;

    if (!senderId || !messageId || !text) return;

    // Ignore messages from our own page
    if (senderId === FB_PAGE_ID) return;

    // Route to the messenger JID
    const jid = 'messenger:sheridan';

    logger.info(
      { from: senderId, jid, messageId },
      'Messenger inbound message',
    );

    // Track sender for reply routing
    this.lastSenderByJid.set(jid, senderId);

    const isoTimestamp = timestamp
      ? new Date(timestamp).toISOString()
      : new Date().toISOString();

    // Update chat metadata
    this.opts.onChatMetadata(jid, isoTimestamp, 'Facebook Messenger');

    // Only deliver to registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) {
      logger.warn({ jid }, 'Messenger JID not registered, message dropped');
      return;
    }

    const newMsg: NewMessage = {
      id: messageId,
      chat_jid: jid,
      sender: `fb:${senderId}`,
      sender_name: 'Facebook User',
      content: text,
      timestamp: isoTimestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    // Let the pipeline decide whether to process this message
    if (this.opts.shouldProcess && !this.opts.shouldProcess({
      id: newMsg.id,
      sender: newMsg.sender,
      content: newMsg.content,
      channel: 'messenger',
    })) {
      return;
    }

    this.opts.onMessage(jid, newMsg);

    // Auto-create CRM contact
    try {
      upsertContactFromPhone(
        `fb:${senderId}`,
        'facebook_messenger',
        ['facebook', 'messenger'],
      );
    } catch (err) {
      logger.debug(
        { err, senderId },
        'CRM auto-create from Messenger failed',
      );
    }
  }

  // ── Message Splitting ────────────────────────────────────────────

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a newline or space near the limit
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt < maxLength * 0.5) {
        splitAt = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitAt < maxLength * 0.5) {
        splitAt = maxLength; // Hard split if no good break point
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }
}
