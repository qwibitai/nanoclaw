import crypto from 'crypto';
import http from 'http';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  WHATSAPP_WEBHOOK_PORT,
} from '../config.js';
import { logger } from '../logger.js';
import type {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

const GRAPH_API_VERSION = 'v19.0';

// Read credentials lazily so they pick up runtime values (env injected after module load)
const creds = {
  get phoneNumberId() {
    return process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  },
  get accessToken() {
    return process.env.WHATSAPP_ACCESS_TOKEN ?? '';
  },
  get verifyToken() {
    return process.env.WHATSAPP_VERIFY_TOKEN ?? '';
  },
  get appSecret() {
    return process.env.WHATSAPP_APP_SECRET ?? '';
  },
};

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Meta webhook payload types
interface WaContact {
  wa_id: string;
  profile?: { name?: string };
}

interface WaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string };
}

interface WaChangeValue {
  contacts?: WaContact[];
  messages?: WaMessage[];
}

interface WebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{ field: string; value: WaChangeValue }>;
  }>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private server?: http.Server;
  private connected = false;
  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(
          req.url ?? '/',
          `http://localhost:${WHATSAPP_WEBHOOK_PORT}`,
        );
        if (url.pathname !== '/webhook/whatsapp') {
          res.writeHead(404);
          res.end();
          return;
        }
        if (req.method === 'GET') {
          this.handleVerification(url, res);
        } else if (req.method === 'POST') {
          this.handleWebhook(req, res);
        } else {
          res.writeHead(405);
          res.end();
        }
      });

      this.server.on('error', reject);
      this.server.listen(WHATSAPP_WEBHOOK_PORT, () => {
        this.connected = true;
        logger.info(
          { port: WHATSAPP_WEBHOOK_PORT },
          'WhatsApp Cloud API webhook listening',
        );
        resolve();
      });
    });
  }

  private handleVerification(url: URL, res: http.ServerResponse): void {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === creds.verifyToken) {
      logger.info('WhatsApp webhook verified by Meta');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge ?? '');
    } else {
      logger.warn({ mode, token }, 'WhatsApp webhook verification failed');
      res.writeHead(403);
      res.end();
    }
  }

  private handleWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);

      // Verify Meta's HMAC-SHA256 signature when app secret is configured.
      // Header format: X-Hub-Signature-256: sha256=<hex>
      const appSecret = creds.appSecret;
      if (appSecret) {
        const signature = req.headers['x-hub-signature-256'];
        if (!signature || typeof signature !== 'string') {
          logger.warn('Rejected webhook: missing X-Hub-Signature-256 header');
          res.writeHead(401);
          res.end();
          return;
        }
        const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
        // Hash both values so timingSafeEqual always receives equal-length buffers,
        // preventing length-based short-circuit even if the signature is malformed.
        const sigHash = crypto
          .createHmac('sha256', appSecret)
          .update(signature)
          .digest();
        const expHash = crypto
          .createHmac('sha256', appSecret)
          .update(expected)
          .digest();
        if (!crypto.timingSafeEqual(sigHash, expHash)) {
          logger.warn('Rejected webhook: invalid signature');
          res.writeHead(401);
          res.end();
          return;
        }
      }

      // Acknowledge immediately — Meta requires a 200 within 20 seconds
      res.writeHead(200);
      res.end();

      const body = rawBody.toString();
      try {
        this.processPayload(JSON.parse(body) as WebhookPayload);
      } catch (err) {
        logger.error(
          { err, body: body.slice(0, 200) },
          'Failed to parse webhook payload',
        );
      }
    });
  }

  private processPayload(payload: WebhookPayload): void {
    if (payload.object !== 'whatsapp_business_account') return;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;

        const { contacts = [], messages = [] } = change.value;

        const nameByWaId: Record<string, string> = {};
        for (const c of contacts) {
          nameByWaId[c.wa_id] = c.profile?.name ?? c.wa_id;
        }

        for (const msg of messages) {
          this.processMessage(msg, nameByWaId);
        }
      }
    }
  }

  private processMessage(
    msg: WaMessage,
    nameByWaId: Record<string, string>,
  ): void {
    const chatJid = `${msg.from}@s.whatsapp.net`;
    const timestamp = new Date(
      parseInt(msg.timestamp, 10) * 1000,
    ).toISOString();
    const senderName = nameByWaId[msg.from] ?? msg.from;

    this.opts.onChatMetadata(chatJid, timestamp, senderName, 'whatsapp', false);

    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) return;

    const content =
      msg.text?.body ??
      msg.image?.caption ??
      msg.video?.caption ??
      msg.document?.caption ??
      '';

    if (!content) return;

    this.opts.onMessage(chatJid, {
      id: msg.id,
      chat_jid: chatJid,
      sender: chatJid,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const phone = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: { preview_url: false, body: prefixed },
        }),
      },
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`WhatsApp API ${res.status}: ${error}`);
    }

    logger.info({ jid, length: prefixed.length }, 'Message sent via Cloud API');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // WhatsApp Cloud API does not support typing indicators
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => {
  if (!creds.phoneNumberId || !creds.accessToken || !creds.verifyToken) {
    logger.info(
      'WhatsApp Cloud API credentials not set (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_VERIFY_TOKEN) — channel disabled.',
    );
    return null;
  }
  return new WhatsAppChannel(opts);
});
