import http from 'node:http';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const log = logger.child({ channel: 'whatsapp-cloud' });

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

export class WhatsAppCloudChannel implements Channel {
  name = 'whatsapp-cloud';
  private server: http.Server | null = null;
  private connected = false;
  private seenMessages = new Set<string>();

  private phoneNumberId: string;
  private accessToken: string;
  private verifyToken: string;
  private port: number;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;

  constructor(opts: {
    phoneNumberId: string;
    accessToken: string;
    verifyToken: string;
    port: number;
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
  }) {
    this.phoneNumberId = opts.phoneNumberId;
    this.accessToken = opts.accessToken;
    this.verifyToken = opts.verifyToken;
    this.port = opts.port;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://localhost:${this.port}`);

        if (url.pathname !== '/webhook') {
          res.writeHead(404);
          res.end();
          return;
        }

        if (req.method === 'GET') {
          const mode = url.searchParams.get('hub.mode');
          const token = url.searchParams.get('hub.verify_token');
          const challenge = url.searchParams.get('hub.challenge');

          if (mode === 'subscribe' && token === this.verifyToken) {
            log.info('Webhook verified');
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(challenge ?? '');
          } else {
            log.warn('Webhook verification failed');
            res.writeHead(403);
            res.end();
          }
          return;
        }

        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk;
          });
          req.on('end', () => {
            res.writeHead(200);
            res.end();
            this.handleWebhookPayload(body).catch((err) =>
              log.error({ err }, 'Error handling webhook payload'),
            );
          });
          return;
        }

        res.writeHead(405);
        res.end();
      });

      this.server.listen(this.port, () => {
        this.connected = true;
        log.info({ port: this.port }, 'WhatsApp Cloud webhook server listening');
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  private async handleWebhookPayload(body: string): Promise<void> {
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      log.warn('Failed to parse webhook payload');
      return;
    }

    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (!value) continue;

        const messages = value.messages ?? [];
        for (const msg of messages) {
          if (this.seenMessages.has(msg.id)) continue;
          this.seenMessages.add(msg.id);

          if (msg.type !== 'text') {
            log.debug({ type: msg.type }, 'Skipping non-text message');
            continue;
          }

          const from = msg.from as string;
          const jid = `wa:${from}`;
          const text = msg.text?.body as string;

          if (!text) continue;

          const contacts = value.contacts ?? [];
          const contact = contacts.find((c: any) => c.wa_id === from);
          const senderName = contact?.profile?.name ?? from;
          const timestamp = new Date(Number(msg.timestamp) * 1000).toISOString();

          // Report chat metadata for discovery
          this.onChatMetadata(jid, timestamp, senderName, 'whatsapp-cloud', false);

          // Only deliver to registered groups
          const group = this.registeredGroups()[jid];
          if (!group) {
            log.debug({ jid, senderName }, 'Message from unregistered WhatsApp chat');
            return;
          }

          const newMessage: NewMessage = {
            id: msg.id,
            chat_jid: jid,
            sender: from,
            sender_name: senderName,
            content: text,
            timestamp,
          };

          this.onMessage(jid, newMessage);
        }
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const phone = jid.replace(/^wa:/, '');
    const url = `${GRAPH_API_BASE}/${this.phoneNumberId}/messages`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: text },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`WhatsApp Cloud API send failed: ${res.status} ${err}`);
    }

    log.info({ jid, length: text.length }, 'WhatsApp message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wa:');
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.connected = false;
        log.info('WhatsApp Cloud webhook server stopped');
        resolve();
      });
    });
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // WhatsApp Cloud API doesn't support typing indicators via the API
  }
}

registerChannel('whatsapp-cloud', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
    'WHATSAPP_WEBHOOK_PORT',
  ]);

  const phoneNumberId =
    process.env.WHATSAPP_PHONE_NUMBER_ID || envVars.WHATSAPP_PHONE_NUMBER_ID || '';
  const accessToken =
    process.env.WHATSAPP_ACCESS_TOKEN || envVars.WHATSAPP_ACCESS_TOKEN || '';
  const verifyToken =
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || envVars.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';
  const port = Number(
    process.env.WHATSAPP_WEBHOOK_PORT || envVars.WHATSAPP_WEBHOOK_PORT || '3001',
  );

  if (!phoneNumberId || !accessToken || !verifyToken) {
    log.warn('WhatsApp Cloud API credentials not configured — skipping');
    return null;
  }

  return new WhatsAppCloudChannel({
    phoneNumberId,
    accessToken,
    verifyToken,
    port,
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
    registeredGroups: opts.registeredGroups,
  });
});
