import os from 'os';
import path from 'path';

import { ImapFlow } from 'imapflow';

import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const ICLOUD_IMAP_HOST = 'imap.mail.me.com';
const ICLOUD_IMAP_PORT = 993;
const ICLOUD_SMTP_HOST = 'smtp.mail.me.com';
const ICLOUD_SMTP_PORT = 587;

export interface ICloudChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class ICloudChannel implements Channel {
  name = 'icloud';

  private client: ImapFlow | null = null;
  private opts: ICloudChannelOpts;
  private email: string;
  private password: string;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedUids = new Set<number>();
  private consecutiveErrors = 0;
  private lastSeenUid = 0;

  constructor(
    opts: ICloudChannelOpts,
    email: string,
    password: string,
    pollIntervalMs = 60000,
  ) {
    this.opts = opts;
    this.email = email;
    this.password = password;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    this.client = new ImapFlow({
      host: ICLOUD_IMAP_HOST,
      port: ICLOUD_IMAP_PORT,
      secure: true,
      auth: { user: this.email, pass: this.password },
      logger: false,
    });

    await this.client.connect();
    logger.info({ email: this.email }, 'iCloud channel connected');

    // Seed processedUids with existing messages to avoid replaying the whole inbox
    await this.seedExistingMessages();

    // Start polling
    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              30 * 60 * 1000,
            )
          : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'iCloud poll error'))
          .finally(() => {
            if (this.client) schedulePoll();
          });
      }, backoffMs);
    };

    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Replies to iCloud emails are handled by the MCP server inside the container.
    // The channel only delivers inbound emails to the main group.
    logger.debug({ jid }, 'iCloud sendMessage is a no-op (replies via MCP)');
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('icloud:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.client) {
      await this.client.logout().catch(() => {});
      this.client = null;
    }
    logger.info('iCloud channel stopped');
  }

  // --- Private ---

  private async seedExistingMessages(): Promise<void> {
    if (!this.client) return;

    const lock = await this.client.getMailboxLock('INBOX');
    try {
      // Mark all current unseen messages as "already processed" so we only
      // trigger on emails that arrive AFTER NanoClaw starts.
      for await (const msg of this.client.fetch('1:*', {
        uid: true,
        flags: true,
      })) {
        this.processedUids.add(msg.uid);
        if (msg.uid > this.lastSeenUid) this.lastSeenUid = msg.uid;
      }

      // Cap set size
      if (this.processedUids.size > 5000) {
        const uids = [...this.processedUids].sort((a, b) => a - b);
        this.processedUids = new Set(uids.slice(uids.length - 2500));
      }

      logger.info(
        { count: this.processedUids.size },
        'iCloud: seeded existing messages',
      );
    } finally {
      lock.release();
    }
  }

  private async pollForMessages(): Promise<void> {
    if (!this.client) return;

    // Reconnect if the connection dropped
    if (this.client.usable === false) {
      logger.info('iCloud: reconnecting...');
      try {
        await this.client.connect();
      } catch (err) {
        this.consecutiveErrors++;
        logger.error({ err }, 'iCloud reconnect failed');
        return;
      }
    }

    const lock = await this.client.getMailboxLock('INBOX');
    try {
      // Fetch unseen messages
      const searchResults = await this.client.search({ seen: false });
      if (!searchResults || searchResults.length === 0) {
        this.consecutiveErrors = 0;
        return;
      }

      for (const seq of searchResults as number[]) {
        const msg = await this.client.fetchOne(String(seq), {
          uid: true,
          envelope: true,
          source: true,
        });

        if (!msg || this.processedUids.has(msg.uid)) continue;
        this.processedUids.add(msg.uid);

        await this.processMessage(msg);

        // Mark as seen
        try {
          await this.client.messageFlagsAdd(String(seq), ['\\Seen']);
        } catch (err) {
          logger.warn(
            { uid: msg.uid, err },
            'Failed to mark iCloud email as read',
          );
        }
      }

      // Cap processed UIDs
      if (this.processedUids.size > 5000) {
        const uids = [...this.processedUids].sort((a, b) => a - b);
        this.processedUids = new Set(uids.slice(uids.length - 2500));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
        30 * 60 * 1000,
      );
      logger.error(
        {
          err,
          consecutiveErrors: this.consecutiveErrors,
          nextPollMs: backoffMs,
        },
        'iCloud poll failed',
      );
    } finally {
      lock.release();
    }
  }

  private async processMessage(msg: {
    uid: number;
    envelope?: {
      from?: Array<{ name?: string; address?: string }>;
      subject?: string;
      messageId?: string;
      date?: Date;
    };
    source?: Buffer;
  }): Promise<void> {
    const envelope = msg.envelope;
    if (!envelope) return;

    const from = envelope.from?.[0];
    const senderEmail = from?.address || 'unknown';
    const senderName = from?.name || senderEmail;
    const subject = envelope.subject || '(no subject)';
    const timestamp = envelope.date
      ? envelope.date.toISOString()
      : new Date().toISOString();

    // Skip emails from self
    if (senderEmail === this.email) return;

    // Extract plain text body from source
    const body = msg.source ? this.extractTextBody(msg.source) : '';
    if (!body) {
      logger.debug(
        { uid: msg.uid, subject },
        'Skipping iCloud email with no text body',
      );
      return;
    }

    const chatJid = `icloud:${msg.uid}`;

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, subject, 'icloud', false);

    // Deliver to main group
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);
    if (!mainEntry) {
      logger.debug(
        { chatJid, subject },
        'No main group registered, skipping iCloud email',
      );
      return;
    }

    const mainJid = mainEntry[0];
    const content = `[iCloud Email from ${senderName} <${senderEmail}>]\nSubject: ${subject}\n\n${body}`;

    this.opts.onMessage(mainJid, {
      id: String(msg.uid),
      chat_jid: mainJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { mainJid, from: senderName, subject },
      'iCloud email delivered to main group',
    );
  }

  private extractTextBody(source: Buffer): string {
    const raw = source.toString('utf-8');

    // Simple extraction: find the text content after headers.
    // For multipart messages, find the first text/plain section.
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd === -1) return '';

    const headers = raw.slice(0, headerEnd).toLowerCase();
    const body = raw.slice(headerEnd + 4);

    // Check if it's multipart
    const boundaryMatch = headers.match(/boundary="?([^\s";]+)"?/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = body.split(`--${boundary}`);
      for (const part of parts) {
        const partHeaderEnd = part.indexOf('\r\n\r\n');
        if (partHeaderEnd === -1) continue;
        const partHeaders = part.slice(0, partHeaderEnd).toLowerCase();
        if (partHeaders.includes('text/plain')) {
          let text = part.slice(partHeaderEnd + 4).trim();
          // Handle base64 encoding
          if (partHeaders.includes('base64')) {
            try {
              text = Buffer.from(text.replace(/\s/g, ''), 'base64').toString(
                'utf-8',
              );
            } catch {
              /* use raw */
            }
          }
          // Handle quoted-printable
          if (partHeaders.includes('quoted-printable')) {
            text = text
              .replace(/=\r?\n/g, '')
              .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
                String.fromCharCode(parseInt(hex, 16)),
              );
          }
          return text.trim();
        }
      }
    }

    // Not multipart — return body directly
    let text = body;
    if (headers.includes('base64')) {
      try {
        text = Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf-8');
      } catch {
        /* use raw */
      }
    }
    if (headers.includes('quoted-printable')) {
      text = text
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
    }

    return text.trim();
  }
}

// --- Channel self-registration ---

registerChannel('icloud', (opts: ChannelOpts) => {
  const env = readEnvFile(['ICLOUD_EMAIL', 'ICLOUD_APP_PASSWORD']);
  const email = process.env.ICLOUD_EMAIL || env.ICLOUD_EMAIL;
  const password = process.env.ICLOUD_APP_PASSWORD || env.ICLOUD_APP_PASSWORD;

  if (!email || !password) {
    logger.warn(
      'iCloud: credentials not found (ICLOUD_EMAIL / ICLOUD_APP_PASSWORD in .env)',
    );
    return null;
  }

  return new ICloudChannel(opts, email, password);
});
