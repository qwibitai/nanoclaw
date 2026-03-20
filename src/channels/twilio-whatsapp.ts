import fs from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import https from 'https';
import path from 'path';

import twilio from 'twilio';

import { GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { processImage } from '../image.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

interface TwilioWhatsAppConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string; // e.g. "whatsapp:+14155238886"
  port: number;
  webhookUrl: string; // Public URL for signature validation (empty = skip validation)
  ackMessage: string; // Immediate TwiML reply (empty = no ack)
}

interface TwilioWhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/** Max message length for WhatsApp via Twilio */
const MAX_MESSAGE_LENGTH = 1600;

/** Matches [Image: attachments/filename.jpg] references in agent output */
const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]]+)\]/g;

/** Allowed image extensions for media serving */
const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/**
 * Download media from a Twilio media URL using Basic Auth.
 * Twilio media URLs redirect once, so we follow redirects.
 */
function downloadTwilioMedia(
  url: string,
  accountSid: string,
  authToken: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const auth = `${accountSid}:${authToken}`;
    const get = (targetUrl: string) => {
      https.get(targetUrl, { auth }, (res) => {
        // Follow redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} downloading media`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
    };
    get(url);
  });
}

/**
 * Parse URL-encoded form body from Twilio webhook POST.
 */
function parseFormBody(body: Buffer): Record<string, string> {
  const params = new URLSearchParams(body.toString('utf-8'));
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

export class TwilioWhatsAppChannel implements Channel {
  name = 'twilio-whatsapp';

  private server: Server | null = null;
  private client: twilio.Twilio;
  private config: TwilioWhatsAppConfig;
  private opts: TwilioWhatsAppChannelOpts;

  constructor(config: TwilioWhatsAppConfig, opts: TwilioWhatsAppChannelOpts) {
    this.config = config;
    this.opts = opts;
    this.client = twilio(config.accountSid, config.authToken);
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, '0.0.0.0', () => {
        logger.info(
          { port: this.config.port },
          'Twilio WhatsApp webhook listening',
        );
        console.log(
          `\n  Twilio WhatsApp webhook: http://0.0.0.0:${this.config.port}/webhook`,
        );
        console.log(`  Register chats with JID format: whatsapp:+PHONE\n`);
        resolve();
      });

      this.server!.on('error', (err) => {
        logger.error({ err }, 'Twilio webhook server error');
        reject(err);
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      const to = jid;

      // Extract image references and build media URLs
      const mediaUrls: string[] = [];
      let cleanText = text;
      const group = this.findGroupByJid(jid);

      if (group && this.config.webhookUrl) {
        const baseUrl = this.config.webhookUrl.replace(/\/webhook\/?$/, '');
        IMAGE_REF_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = IMAGE_REF_PATTERN.exec(text)) !== null) {
          const relativePath = match[1]; // e.g. "attachments/img-123.jpg"
          const filePath = path.join(GROUPS_DIR, group.folder, relativePath);
          const ext = path.extname(relativePath).toLowerCase();
          if (fs.existsSync(filePath) && ALLOWED_IMAGE_EXTS.has(ext)) {
            mediaUrls.push(
              `${baseUrl}/media/${encodeURIComponent(group.folder)}/${relativePath}`,
            );
          }
        }
        // Strip image references from text
        if (mediaUrls.length > 0) {
          cleanText = text.replace(IMAGE_REF_PATTERN, '').trim();
        }
      }

      // Twilio supports up to 10 mediaUrl per message
      const msgOpts: {
        from: string;
        to: string;
        body: string;
        mediaUrl?: string[];
      } = {
        from: this.config.fromNumber,
        to,
        body: cleanText || '📷',
      };
      if (mediaUrls.length > 0) {
        msgOpts.mediaUrl = mediaUrls.slice(0, 10);
      }

      if (cleanText.length <= MAX_MESSAGE_LENGTH) {
        await this.client.messages.create(msgOpts);
      } else {
        // Send images with first chunk, text-only for the rest
        const firstChunk = cleanText.slice(0, MAX_MESSAGE_LENGTH);
        await this.client.messages.create({ ...msgOpts, body: firstChunk });
        for (
          let i = MAX_MESSAGE_LENGTH;
          i < cleanText.length;
          i += MAX_MESSAGE_LENGTH
        ) {
          await this.client.messages.create({
            from: this.config.fromNumber,
            to,
            body: cleanText.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }

      logger.info(
        { jid, length: text.length, mediaCount: mediaUrls.length },
        'Twilio WhatsApp message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Twilio WhatsApp message');
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('whatsapp:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.server = null;
          logger.info('Twilio WhatsApp webhook server stopped');
          resolve();
        });
      });
    }
  }

  // --- Private ---

  private findGroupByJid(jid: string): RegisteredGroup | undefined {
    return this.opts.registeredGroups()[jid];
  }

  private serveMedia(url: string, res: ServerResponse): void {
    // URL format: /media/<group>/attachments/<filename>
    const parts = url.replace(/^\/media\//, '').split('/');
    if (parts.length < 2) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const groupFolder = decodeURIComponent(parts[0]);
    const relativePath = parts.slice(1).join('/');

    // Security: only serve from attachments/ with allowed image extensions
    if (!relativePath.startsWith('attachments/')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const ext = path.extname(relativePath).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Prevent path traversal
    const filePath = path.resolve(GROUPS_DIR, groupFolder, relativePath);
    if (!filePath.startsWith(path.resolve(GROUPS_DIR))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'image/jpeg' });
    fs.createReadStream(filePath).pipe(res);
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', channel: 'twilio-whatsapp' }));
      return;
    }

    if (method === 'POST' && url === '/webhook') {
      this.handleWebhook(req, res);
      return;
    }

    // Serve images for Twilio mediaUrl: GET /media/<group>/attachments/<file>
    if (method === 'GET' && url.startsWith('/media/')) {
      this.serveMedia(url, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  private handleWebhook(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const params = parseFormBody(body);

        // Validate Twilio signature if webhook URL is configured
        if (this.config.webhookUrl) {
          const signature = req.headers['x-twilio-signature'] as string;
          const valid = twilio.validateRequest(
            this.config.authToken,
            signature || '',
            this.config.webhookUrl,
            params,
          );
          if (!valid) {
            logger.warn('Twilio webhook: invalid signature');
            res.writeHead(403);
            res.end('Invalid signature');
            return;
          }
        }

        // Fire and forget — respond immediately, process in background
        this.processInboundMessage(params).catch((err) => {
          logger.error({ err }, 'Error in Twilio message processing');
        });

        res.writeHead(200, { 'Content-Type': 'text/xml' });
        if (this.config.ackMessage) {
          res.end(
            `<Response><Message>${this.config.ackMessage}</Message></Response>`,
          );
        } else {
          res.end('<Response/>');
        }
      } catch (err) {
        logger.error({ err }, 'Error processing Twilio webhook');
        res.writeHead(500);
        res.end('Internal error');
      }
    });
  }

  private async processInboundMessage(
    params: Record<string, string>,
  ): Promise<void> {
    const from = params.From || '';
    const body = params.Body || '';
    const profileName = params.ProfileName || '';
    const messageSid = params.MessageSid || '';
    const numMedia = parseInt(params.NumMedia || '0', 10);

    if (!from) {
      logger.warn('Twilio webhook: missing From field');
      return;
    }

    const chatJid = from;
    const phone = from.replace(/^whatsapp:/, '');
    const timestamp = new Date().toISOString();

    // Store chat metadata for discovery
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      profileName || phone,
      'twilio-whatsapp',
      false, // Twilio WhatsApp is always 1:1
    );

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, profileName },
        'Message from unregistered Twilio WhatsApp chat',
      );
      return;
    }

    // Process media attachments
    let content = body;
    if (numMedia > 0) {
      const groupDir = path.join(GROUPS_DIR, group.folder);
      const mediaParts: string[] = [];

      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = params[`MediaUrl${i}`];
        const contentType = params[`MediaContentType${i}`] || 'unknown';

        if (mediaUrl && contentType.startsWith('image/')) {
          try {
            const buffer = await downloadTwilioMedia(
              mediaUrl,
              this.config.accountSid,
              this.config.authToken,
            );
            const result = await processImage(buffer, groupDir, body);
            if (result) {
              // processImage includes caption in content, so use it directly
              content = result.content;
            }
            logger.info({ chatJid, contentType }, 'Twilio image processed');
          } catch (err) {
            logger.warn({ err, chatJid }, 'Twilio image download failed');
            mediaParts.push(`[Media: ${contentType}]`);
          }
        } else {
          mediaParts.push(`[Media: ${contentType}]`);
        }
      }

      // Append non-image media placeholders
      if (mediaParts.length > 0) {
        const mediaText = mediaParts.join(' ');
        content = content ? `${content}\n${mediaText}` : mediaText;
      }
    }

    if (!content) {
      logger.debug({ chatJid }, 'Twilio webhook: empty message, skipping');
      return;
    }

    logger.info(
      { chatJid, profileName, numMedia, length: content.length },
      'Twilio WhatsApp message received',
    );

    this.opts.onMessage(chatJid, {
      id: messageSid,
      chat_jid: chatJid,
      sender: phone,
      sender_name: profileName || phone,
      content,
      timestamp,
      is_from_me: false,
    });
  }
}

// --- Self-registration ---

registerChannel('twilio-whatsapp', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WHATSAPP_FROM',
    'TWILIO_WEBHOOK_PORT',
    'TWILIO_WEBHOOK_URL',
    'TWILIO_ACK_MESSAGE',
  ]);

  const accountSid =
    process.env.TWILIO_ACCOUNT_SID || envVars.TWILIO_ACCOUNT_SID || '';
  const authToken =
    process.env.TWILIO_AUTH_TOKEN || envVars.TWILIO_AUTH_TOKEN || '';
  const fromNumber =
    process.env.TWILIO_WHATSAPP_FROM || envVars.TWILIO_WHATSAPP_FROM || '';
  const port = parseInt(
    process.env.TWILIO_WEBHOOK_PORT || envVars.TWILIO_WEBHOOK_PORT || '3002',
    10,
  );
  const webhookUrl =
    process.env.TWILIO_WEBHOOK_URL || envVars.TWILIO_WEBHOOK_URL || '';
  const ackMessage =
    process.env.TWILIO_ACK_MESSAGE || envVars.TWILIO_ACK_MESSAGE || '';

  if (!accountSid || !authToken || !fromNumber) {
    logger.warn('Twilio WhatsApp: credentials not set, skipping');
    return null;
  }

  if (!webhookUrl) {
    logger.warn(
      'Twilio WhatsApp: TWILIO_WEBHOOK_URL not set, signature validation disabled',
    );
  }

  return new TwilioWhatsAppChannel(
    { accountSid, authToken, fromNumber, port, webhookUrl, ackMessage },
    opts,
  );
});
