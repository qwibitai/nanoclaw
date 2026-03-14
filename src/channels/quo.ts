/**
 * Quo Phone (OpenPhone) SMS Channel
 * Receives inbound SMS via webhook + polling fallback, sends outbound via OpenPhone API.
 * JID format: quo:+1XXXXXXXXXX (the business phone number)
 */
import crypto from 'crypto';
import http from 'http';

import { z } from 'zod/v4';

import { CircuitBreaker } from '../circuit-breaker.js';
import {
  ASSISTANT_NAME,
  QUO_API_KEY,
  QUO_SNAK_NUMBER,
  QUO_SNAK_PHONE_ID,
  QUO_SHERIDAN_NUMBER,
  QUO_SHERIDAN_PHONE_ID,
  QUO_WEBHOOK_PORT,
} from '../config.js';
import { readEnvFile } from '../env.js';
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
const QUO_WEBHOOK_SECRET =
  readEnvFile(['QUO_WEBHOOK_SECRET']).QUO_WEBHOOK_SECRET || '';

function verifyWebhookSignature(
  signature: string | undefined,
  body: string,
): boolean {
  if (!QUO_WEBHOOK_SECRET) {
    // No secret configured — reject all webhook requests
    logger.error(
      'QUO_WEBHOOK_SECRET not configured, rejecting webhook request',
    );
    return false;
  }
  if (!signature) return false;

  // Format: hmac;1;timestamp;base64digest
  const parts = signature.split(';');
  if (parts.length !== 4 || parts[0] !== 'hmac') return false;

  const [, , timestamp, digest] = parts;
  const signedData = `${timestamp}.${body}`;
  const key = Buffer.from(QUO_WEBHOOK_SECRET, 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(signedData)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Zod Webhook Payload Schema ─────────────────────────────────────
const WebhookMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.union([z.string(), z.array(z.string())]),
  direction: z.string(),
  text: z.string().optional(),
  body: z.string().optional(),
  phoneNumberId: z.string().optional(),
  createdAt: z.string().optional(),
});

const WebhookPayloadSchema = z.object({
  type: z.string(),
  data: z
    .object({
      object: WebhookMessageSchema,
    })
    .optional(),
});

const QUO_API_BASE = 'https://api.openphone.com/v1';
const POLL_INTERVAL_MS = 15_000; // Poll every 15 seconds

export interface QuoChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  shouldProcess?: (msg: { id: string; sender: string; content: string; channel: string }) => boolean;
}

/** Map business number → OpenPhone phoneNumberId for outbound sending. */
interface PhoneLine {
  phoneId: string;
  number: string;
}

export class QuoChannel implements Channel {
  name = 'quo';

  private server: http.Server | null = null;
  private connected = false;
  private opts: QuoChannelOpts;
  private apiBreaker = new CircuitBreaker('openphone-api');
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Track last inbound sender per JID so we know who to reply to.
   * Key: quo:+1XXXX (business line JID), Value: customer phone number (+1YYYY)
   */
  private lastSenderByJid = new Map<string, string>();

  /** Track last seen activity ID per conversation to detect new messages. */
  private lastActivityByConversation = new Map<string, string>();

  /** Map business number → phoneId for outbound routing. */
  private phoneLines: PhoneLine[] = [];

  constructor(opts: QuoChannelOpts) {
    this.opts = opts;

    // Register configured phone lines
    if (QUO_SNAK_PHONE_ID && QUO_SNAK_NUMBER) {
      this.phoneLines.push({
        phoneId: QUO_SNAK_PHONE_ID,
        number: QUO_SNAK_NUMBER,
      });
    }
    if (QUO_SHERIDAN_PHONE_ID && QUO_SHERIDAN_NUMBER) {
      this.phoneLines.push({
        phoneId: QUO_SHERIDAN_PHONE_ID,
        number: QUO_SHERIDAN_NUMBER,
      });
    }
  }

  async connect(): Promise<void> {
    // Start webhook server
    await new Promise<void>((resolve) => {
      this.server = http.createServer((req, res) => {
        // Rate limiting on all requests
        const ip =
          req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
          req.socket.remoteAddress ||
          'unknown';
        if (isWebhookRateLimited(ip)) {
          logger.warn({ ip }, 'Quo webhook rate limited');
          audit('webhook_rate_limited', { ip });
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          });
          res.end('{"error":"rate limited"}');
          return;
        }

        if (req.method === 'POST' && req.url === '/webhook/quo') {
          this.handleWebhook(req, res);
        } else {
          res.writeHead(200);
          res.end('ok');
        }
      });

      this.server.listen(QUO_WEBHOOK_PORT, () => {
        this.connected = true;
        logger.info({ port: QUO_WEBHOOK_PORT }, 'Quo webhook server listening');
        resolve();
      });
    });

    // Start polling fallback (webhooks are unreliable)
    this.startPolling();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Find the phone line for this JID
    const businessNumber = jid.replace('quo:', '');
    const line = this.phoneLines.find((l) => l.number === businessNumber);
    if (!line) {
      logger.warn({ jid }, 'No Quo phone line configured for JID');
      return;
    }

    // Find the customer number to reply to (in-memory first, then DB fallback)
    let customerNumber = this.lastSenderByJid.get(jid);
    if (!customerNumber) {
      customerNumber = getLastSender(jid) ?? undefined;
      if (customerNumber) {
        this.lastSenderByJid.set(jid, customerNumber);
      }
    }
    if (!customerNumber) {
      logger.warn({ jid }, 'No customer number known for Quo reply');
      return;
    }

    // Prefix with assistant name for consistency
    const prefixed = `${ASSISTANT_NAME}: ${text}`;

    if (this.apiBreaker.state === 'open') {
      logger.error({ jid, breaker: 'openphone-api' }, 'Quo API circuit breaker open, dropping message');
      return;
    }

    try {
      await this.apiBreaker.call(async () => {
        const response = await fetch(`${QUO_API_BASE}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: QUO_API_KEY,
          },
          body: JSON.stringify({
            content: prefixed,
            from: line.phoneId,
            to: [customerNumber],
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Quo send failed ${response.status}: ${body}`);
        }

        logger.info(
          { jid, to: customerNumber, length: prefixed.length },
          'Quo message sent',
        );
      });
    } catch (err) {
      logger.error({ jid, err }, 'Quo send error');
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
    return jid.startsWith('quo:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  // SMS does not support typing indicators
  // setTyping is intentionally not implemented

  // ── Webhook handler ──────────────────────────────────────────────

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
      const signature = req.headers['openphone-signature'] as
        | string
        | undefined;
      if (!verifyWebhookSignature(signature, body)) {
        logger.warn(
          { hasSignature: !!signature },
          'Quo webhook signature verification failed',
        );
        audit('webhook_signature_failed', { hasSignature: !!signature });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid signature"}');
        return;
      }

      // Parse and validate JSON
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        logger.warn({ err }, 'Quo webhook: invalid JSON');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid JSON"}');
        return;
      }

      // Accept validation/ping payloads that don't match the message schema
      const result = WebhookPayloadSchema.safeParse(payload);
      if (!result.success) {
        // Respond 200 anyway — this may be a validation ping from Quo
        logger.info(
          { payload },
          'Quo webhook: non-message payload (validation ping?), accepting',
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');

      this.processWebhookPayload(result.data);
    });
  }

  private processWebhookPayload(
    payload: z.infer<typeof WebhookPayloadSchema>,
  ): void {
    if (payload.type !== 'message.received') return;

    const msg = payload.data?.object;
    if (!msg || msg.direction !== 'incoming') return;

    this.processMessage(msg, 'webhook');
  }

  // ── Polling ──────────────────────────────────────────────────────

  private startPolling(): void {
    logger.info(
      { intervalMs: POLL_INTERVAL_MS, lines: this.phoneLines.length },
      'Quo polling started',
    );

    // Initial poll after a short delay
    setTimeout(() => this.pollAllLines(), 3000);

    this.pollTimer = setInterval(() => this.pollAllLines(), POLL_INTERVAL_MS);
  }

  private async pollAllLines(): Promise<void> {
    for (const line of this.phoneLines) {
      try {
        await this.pollLine(line);
      } catch (err) {
        logger.warn({ err, phone: line.number }, 'Quo poll error');
      }
    }
  }

  private async pollLine(line: PhoneLine): Promise<void> {
    // Fetch recent conversations for this phone line
    const url = new URL(`${QUO_API_BASE}/conversations`);
    url.searchParams.set('phoneNumberId', line.phoneId);
    url.searchParams.set('maxResults', '10');

    const convRes = await fetch(url.toString(), {
      headers: { Authorization: QUO_API_KEY },
    });

    if (!convRes.ok) return;

    const convData = (await convRes.json()) as {
      data?: Array<{
        id: string;
        lastActivityId: string;
        phoneNumberId?: string;
        participants?: string[];
      }>;
    };
    if (!convData.data) return;

    // Filter to conversations belonging to this phone line
    const lineConvs = convData.data.filter(
      (c) => c.phoneNumberId === line.phoneId,
    );

    for (const conv of lineConvs) {
      const lastActivityId = conv.lastActivityId;
      const prevActivityId = this.lastActivityByConversation.get(conv.id);

      // On first run, just record the current state without fetching messages
      if (!prevActivityId) {
        this.lastActivityByConversation.set(conv.id, lastActivityId);
        continue;
      }

      // If activity hasn't changed, skip
      if (lastActivityId === prevActivityId) continue;

      // New activity detected — fetch recent messages
      logger.info(
        {
          convId: conv.id,
          phone: line.number,
          participants: conv.participants,
        },
        'Quo poll: new activity detected',
      );
      this.lastActivityByConversation.set(conv.id, lastActivityId);

      const participants: string[] = conv.participants || [];
      if (participants.length === 0) continue;

      await this.fetchNewMessages(line, participants);
    }
  }

  private async fetchNewMessages(
    line: PhoneLine,
    participants: string[],
  ): Promise<void> {
    const url = new URL(`${QUO_API_BASE}/messages`);
    url.searchParams.set('phoneNumberId', line.phoneId);
    participants.forEach((p: string, i: number) => {
      url.searchParams.set(`participants[${i}]`, p);
    });
    url.searchParams.set('maxResults', '5');

    const msgRes = await fetch(url.toString(), {
      headers: { Authorization: QUO_API_KEY },
    });

    if (!msgRes.ok) return;

    const msgData = (await msgRes.json()) as {
      data?: Array<{
        id?: string;
        from?: string;
        to?: string | string[];
        text?: string;
        body?: string;
        phoneNumberId?: string;
        direction?: string;
        createdAt?: string;
      }>;
    };
    if (!msgData.data) return;

    // Process messages in chronological order (API returns newest first)
    for (const msg of msgData.data.reverse()) {
      if (msg.direction !== 'incoming') continue;
      this.processMessage(msg, 'poll');
    }
  }

  // ── Shared message processing ────────────────────────────────────

  private processMessage(
    msg: {
      id?: string;
      from?: string;
      to?: string | string[];
      text?: string;
      body?: string;
      phoneNumberId?: string;
      direction?: string;
      createdAt?: string;
    },
    source: 'webhook' | 'poll',
  ): void {
    const msgId = msg.id;
    if (!msgId) return;

    const customerNumber = msg.from;
    const businessNumber = Array.isArray(msg.to) ? msg.to[0] : msg.to;
    const text = msg.text || msg.body || '';

    if (!customerNumber || !businessNumber || !text) return;

    // Determine which business line received this
    const line = this.phoneLines.find((l) => l.phoneId === msg.phoneNumberId);
    const jid = line ? `quo:${line.number}` : `quo:${businessNumber}`;

    logger.info(
      { source, from: customerNumber, jid, msgId },
      'Quo inbound SMS',
    );

    // Track the customer number for reply routing
    this.lastSenderByJid.set(jid, customerNumber);

    const timestamp = msg.createdAt || new Date().toISOString();

    // Update chat metadata
    this.opts.onChatMetadata(
      jid,
      timestamp,
      `Quo ${line?.number || businessNumber}`,
    );

    // Only deliver to registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const newMsg: NewMessage = {
      id: msgId,
      chat_jid: jid,
      sender: customerNumber,
      sender_name: customerNumber,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    if (this.opts.shouldProcess && !this.opts.shouldProcess({
      id: msgId,
      sender: customerNumber,
      content: text,
      channel: 'quo',
    })) {
      return;
    }

    this.opts.onMessage(jid, newMsg);

    // Auto-create CRM contact from inbound SMS
    try {
      upsertContactFromPhone(
        customerNumber,
        `quo:${line?.number || businessNumber}`,
        [],
      );
    } catch (err) {
      logger.debug({ err, phone: customerNumber }, 'CRM auto-create failed');
    }
  }
}
