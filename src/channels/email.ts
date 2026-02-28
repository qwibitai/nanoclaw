import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import {
  IMAP_HOST,
  IMAP_PORT,
  IMAP_USER,
  IMAP_PASS,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
} from '../config.js';
import { logger } from '../logger.js';
import type {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';

// --- Types ---

export interface EmailMetadata {
  messageId: string;
  from: string;
  fromName: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
}

export interface EmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onEmail?: (jid: string, meta: EmailMetadata, body: string) => void;
}

const MAX_BODY_LENGTH = 4000;
const MAX_PROCESSED_IDS = 5000;
const ATTACHMENTS_DIR = join(process.cwd(), 'groups', 'main', 'attachments');

// --- EmailChannel ---

export class EmailChannel implements Channel {
  readonly name = 'email';

  private imap: ImapFlow | null = null;
  private transporter: Transporter | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private threads = new Map<string, EmailMetadata>();

  private processedIds = new Set<string>();
  private readonly opts: EmailChannelOpts;

  constructor(opts: EmailChannelOpts) {
    this.opts = opts;
  }

  // --- Channel interface ---

  async connect(): Promise<void> {
    // IMAP client
    this.imap = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: IMAP_PORT === 993,
      auth: { user: IMAP_USER, pass: IMAP_PASS },
      logger: false,
    });

    this.imap.on('error', (err: Error) => {
      logger.error({ err }, 'IMAP connection error');
    });

    await this.imap.connect();
    logger.info('Email IMAP connected to %s', IMAP_HOST);

    // SMTP transporter
    this.transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    await this.transporter.verify();
    logger.info('Email SMTP verified on %s', SMTP_HOST);

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.imap) {
      try {
        await this.imap.logout();
      } catch {
        // ignore logout errors
      }
      this.imap = null;
    }

    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }

    this.connected = false;
    logger.info('Email channel disconnected');
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // No-op: email replies are sent via IPC tools, not through sendMessage.
    logger.debug('sendMessage called on email channel (no-op)');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  // --- Polling ---

  async pollOnce(): Promise<void> {
    if (!this.imap) return;

    let lock: { release: () => void } | undefined;
    try {
      lock = await this.imap.getMailboxLock('INBOX');

      const uids = await this.imap.search({ seen: false });
      if (!uids.length) return;

      for (const uid of uids) {
        try {
          const fetched = await this.imap.fetchOne(uid, {
            source: true,
            uid: true,
          });

          const parsed = await simpleParser(fetched.source);

          const messageId = parsed.messageId ?? `uid:${uid}`;

          // Skip already-processed
          if (this.processedIds.has(messageId)) continue;

          // Extract from info
          const fromEntry = parsed.from?.value?.[0];
          const fromAddr = fromEntry?.address ?? 'unknown';
          const fromName = fromEntry?.name ?? fromAddr;

          // Skip own emails
          if (fromAddr === IMAP_USER) continue;

          const subject = parsed.subject ?? '(kein Betreff)';

          // Body: prefer text, fallback to html
          let body = parsed.text ?? parsed.html ?? '';
          if (typeof body === 'string' && body.length > MAX_BODY_LENGTH) {
            body = body.slice(0, MAX_BODY_LENGTH);
          }

          // Handle attachments
          const attachmentLines: string[] = [];
          if (parsed.attachments?.length) {
            mkdirSync(ATTACHMENTS_DIR, { recursive: true });
            for (const att of parsed.attachments) {
              const ts = Date.now();
              const filename = att.filename ?? `attachment-${ts}`;
              const safeName = `${ts}-${filename}`;
              const filePath = join(ATTACHMENTS_DIR, safeName);
              writeFileSync(filePath, att.content);
              attachmentLines.push(`[Anhang: ${filename} (${filePath})]`);
            }
          }

          // Build chat JID from message ID
          const chatJid = `email:${messageId}`;

          // Thread metadata
          const meta: EmailMetadata = {
            messageId,
            from: fromAddr,
            fromName,
            subject,
            inReplyTo: parsed.inReplyTo as string | undefined,
            references: Array.isArray(parsed.references)
              ? parsed.references.join(' ')
              : (parsed.references as string | undefined),
          };
          this.threads.set(chatJid, meta);

          // Format inbound message
          const parts = [
            `[Email von ${fromName} <${fromAddr}>]`,
            `Betreff: ${subject}`,
            '',
            body,
          ];
          if (attachmentLines.length) {
            parts.push(...attachmentLines);
          }

          const message: NewMessage = {
            id: messageId,
            chat_jid: chatJid,
            sender: fromAddr,
            sender_name: fromName,
            content: parts.join('\n'),
            timestamp: new Date().toISOString(),
          };

          // Deliver callbacks
          if (this.opts.onEmail) {
            this.opts.onEmail(chatJid, meta, body);
          }
          this.opts.onMessage(chatJid, message);

          // Mark as read
          await this.imap.messageFlagsAdd([uid], ['\\Seen'], { uid: true });

          // Track processed ID (cap at MAX_PROCESSED_IDS)
          this.processedIds.add(messageId);
          if (this.processedIds.size > MAX_PROCESSED_IDS) {
            const oldest = this.processedIds.values().next().value!;
            this.processedIds.delete(oldest);
          }
        } catch (msgErr) {
          logger.error({ err: msgErr, uid }, 'Failed to process email UID');
        }
      }
    } catch (err) {
      logger.error({ err }, 'IMAP poll error');
    } finally {
      lock?.release();
    }
  }

  startPolling(intervalMs: number): void {
    logger.info('Email polling started (interval: %dms)', intervalMs);
    // Poll immediately
    void this.pollOnce();
    // Then on interval
    this.pollTimer = setInterval(() => void this.pollOnce(), intervalMs);
  }

  // --- Email-specific accessors ---

  getThreadMetadata(jid: string): EmailMetadata | undefined {
    return this.threads.get(jid);
  }

  setThreadMetadata(jid: string, meta: EmailMetadata): void {
    this.threads.set(jid, meta);
  }

  getTransporter(): Transporter | undefined {
    return this.transporter ?? undefined;
  }
}
