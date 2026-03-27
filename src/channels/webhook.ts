import http from 'http';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export interface WebhookChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface WebhookRoute {
  /** URL path to match (e.g., '/paperclip') */
  path: string;
  /** Parse the request body and return a message + sender, or null to silently ack */
  handle: (data: Record<string, unknown>) => { message: string; sender: string } | null;
}

const DEFAULT_PORT = 3200;

export class WebhookChannel implements Channel {
  name = 'webhook';

  private server: http.Server | null = null;
  private opts: WebhookChannelOpts;
  private port: number;
  /** JID of a linked channel where outbound messages are forwarded. */
  private linkedJid: string;
  /** Reference to sendMessage of a sibling channel — set after connect. */
  private siblingChannels: Channel[] = [];
  /** Plugin routes registered by skills */
  private routes: WebhookRoute[] = [];

  constructor(port: number, linkedJid: string, opts: WebhookChannelOpts) {
    this.port = port;
    this.linkedJid = linkedJid;
    this.opts = opts;
  }

  /** Injected by index.ts after all channels connect so we can forward outbound. */
  setSiblingChannels(channels: Channel[]): void {
    this.siblingChannels = channels;
  }

  /** Register a plugin route (called by skill modules at startup) */
  addRoute(route: WebhookRoute): void {
    this.routes.push(route);
    logger.info({ path: route.path }, 'Webhook route registered');
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // Check plugin routes first, then fall back to generic /webhook
      const matchedRoute = this.routes.find((r) => req.url === r.path);
      if (req.method === 'POST' && (req.url === '/webhook' || matchedRoute)) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1_000_000) {
            res.writeHead(413);
            res.end('Payload too large');
            req.destroy();
          }
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);

            let message: string | undefined;
            let senderName: string;

            if (matchedRoute) {
              const result = matchedRoute.handle(data);
              if (!result) {
                // Plugin filtered this event — silent ack
                res.writeHead(202, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'accepted', filtered: true }));
                return;
              }
              message = result.message;
              senderName = result.sender;
            } else {
              message = data.message || data.text || data.prompt;
              senderName = data.sender || 'webhook';
            }

            if (!message || typeof message !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing "message" field' }));
              return;
            }

            const jid = 'webhook:default';
            const timestamp = new Date().toISOString();
            const msgId = `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

            this.opts.onChatMetadata(jid, timestamp, 'Webhook', 'webhook', false);
            this.opts.onMessage(jid, {
              id: msgId,
              chat_jid: jid,
              sender: 'webhook',
              sender_name: senderName,
              content: message,
              timestamp,
              is_from_me: false,
            });

            logger.info({ sender: senderName, length: message.length }, 'Webhook message received');
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'accepted', id: msgId }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        logger.info({ port: this.port }, 'Webhook server listening');
        const routePaths = this.routes.map((r) => r.path).join(', ');
        console.log(`\n  Webhook: http://localhost:${this.port}/webhook`);
        if (routePaths) console.log(`  Routes: ${routePaths}`);
        console.log();
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Webhook has no native send — forward to the linked channel
    if (!this.linkedJid) {
      logger.warn('Webhook: no linked JID configured for outbound messages');
      return;
    }
    const target = this.siblingChannels.find((ch) => ch.ownsJid(this.linkedJid));
    if (target) {
      await target.sendMessage(this.linkedJid, text);
    } else {
      logger.warn({ linkedJid: this.linkedJid }, 'Webhook: no channel owns linked JID');
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('webhook:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('Webhook server stopped');
    }
  }
}

/** Singleton reference so plugins can register routes after channel creation */
let webhookInstance: WebhookChannel | null = null;

export function getWebhookChannel(): WebhookChannel | null {
  return webhookInstance;
}

registerChannel('webhook', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['WEBHOOK_PORT', 'WEBHOOK_LINKED_JID']);
  const port = parseInt(
    process.env.WEBHOOK_PORT || envVars.WEBHOOK_PORT || String(DEFAULT_PORT),
    10,
  );
  const linkedJid =
    process.env.WEBHOOK_LINKED_JID || envVars.WEBHOOK_LINKED_JID || '';
  if (!linkedJid) {
    logger.warn('Webhook: WEBHOOK_LINKED_JID not set — skipping');
    return null;
  }
  webhookInstance = new WebhookChannel(port, linkedJid, opts);
  return webhookInstance;
});
