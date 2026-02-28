import { ImapFlow } from 'imapflow';
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
import type { Channel, OnChatMetadata, OnInboundMessage } from '../types.js';

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

// --- EmailChannel ---

export class EmailChannel implements Channel {
  readonly name = 'email';

  private imap: ImapFlow | null = null;
  private transporter: Transporter | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private threads = new Map<string, EmailMetadata>();

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
