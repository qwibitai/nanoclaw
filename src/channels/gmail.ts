import fs from 'fs';
import os from 'os';
import path from 'path';

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface GmailConfig {
  email: string;
  appPassword: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
}

export class GmailChannel implements Channel {
  name = 'gmail';

  private config: GmailConfig | null = null;
  private opts: GmailChannelOpts;
  private imapClient: ImapFlow | null = null;
  private processedIds = new Set<string>();
  private threadMeta = new Map<string, ThreadMeta>();
  private connected = false;

  constructor(opts: GmailChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const configPath = path.join(os.homedir(), '.gmail-mcp', 'config.json');
    if (!fs.existsSync(configPath)) {
      logger.warn(
        'Gmail app-password config not found at ~/.gmail-mcp/config.json. Skipping Gmail channel.',
      );
      return;
    }

    this.config = JSON.parse(
      fs.readFileSync(configPath, 'utf-8'),
    ) as GmailConfig;

    // Verify credentials with a quick connect
    const probe = this.makeImapClient();
    try {
      await probe.connect();
      await probe.logout();
    } catch (err) {
      logger.error({ err }, 'Gmail IMAP connection failed');
      this.config = null;
      return;
    }

    logger.info(
      { email: this.config.email },
      'Gmail channel connected (IMAP IDLE)',
    );
    this.connected = true;
    // Run IDLE loop in background — does not block connect()
    this.runIdleLoop();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.config) {
      logger.warn('Gmail not initialized');
      return;
    }

    const threadId = jid.replace(/^gmail:/, '');
    const meta = this.threadMeta.get(threadId);

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for reply, cannot send');
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const transporter = nodemailer.createTransport({
      host: this.config.smtpHost || 'smtp.gmail.com',
      port: this.config.smtpPort || 587,
      secure: false,
      auth: {
        user: this.config.email,
        pass: this.config.appPassword,
      },
    });

    try {
      await transporter.sendMail({
        from: this.config.email,
        to: meta.sender,
        subject,
        text,
        headers: {
          'In-Reply-To': meta.messageId,
          References: meta.messageId,
        },
      });
      logger.info({ to: meta.sender, threadId }, 'Gmail reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Gmail reply');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.imapClient) {
      try {
        await this.imapClient.logout();
      } catch {
        /* ignore */
      }
      this.imapClient = null;
    }
    logger.info('Gmail channel stopped');
  }

  // --- Private ---

  private makeImapClient(): ImapFlow {
    return new ImapFlow({
      host: this.config!.imapHost || 'imap.gmail.com',
      port: this.config!.imapPort || 993,
      secure: true,
      auth: {
        user: this.config!.email,
        pass: this.config!.appPassword,
      },
      logger: false,
    });
  }

  private async runIdleLoop(): Promise<void> {
    let consecutiveErrors = 0;
    while (this.connected) {
      const client = this.makeImapClient();
      this.imapClient = client;
      try {
        await client.connect();
        await client.mailboxOpen('INBOX');
        logger.debug('Gmail IDLE: connected, fetching unseen');

        // Fetch any unseen messages that arrived before we entered IDLE
        await this.fetchUnseen(client);
        consecutiveErrors = 0;

        // IDLE: resolves when the server signals new mail (or ~29-min server timeout)
        while (this.connected) {
          await client.idle();
          if (!this.connected) break;
          await this.fetchUnseen(client);
        }
      } catch (err) {
        if (!this.connected) break; // normal shutdown
        consecutiveErrors++;
        const backoffMs = Math.min(
          5000 * Math.pow(2, consecutiveErrors - 1),
          5 * 60 * 1000,
        );
        logger.error(
          { err, consecutiveErrors, retryMs: backoffMs },
          'Gmail IDLE error, reconnecting',
        );
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
        this.imapClient = null;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    this.imapClient = null;
  }

  private async fetchUnseen(client: ImapFlow): Promise<void> {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids) {
      const uidStr = String(uid);
      if (this.processedIds.has(uidStr)) continue;
      this.processedIds.add(uidStr);
      await this.processMessage(client, uid);
    }
    // Cap processed ID set
    if (this.processedIds.size > 5000) {
      const ids = [...this.processedIds];
      this.processedIds = new Set(ids.slice(ids.length - 2500));
    }
  }

  private async processMessage(client: ImapFlow, uid: number): Promise<void> {
    const msg = await client.fetchOne(
      String(uid),
      { envelope: true, source: true },
      { uid: true },
    );

    if (!msg) return;

    const envelope = msg.envelope;
    if (!envelope) return;

    const from = envelope.from?.[0];
    if (!from) return;

    const senderEmail = from.address || '';
    const senderName = from.name || senderEmail;

    // Skip emails from self
    if (senderEmail === this.config!.email) return;

    const subject = envelope.subject || '(no subject)';
    const timestamp = (
      envelope.date ? new Date(envelope.date) : new Date()
    ).toISOString();

    // Parse raw source for Message-ID and body
    const rawSource = msg.source?.toString('utf-8') || '';
    const rfc2822MessageId =
      this.extractHeader(rawSource, 'Message-ID') || `<${uid}@gmail>`;
    const body = this.extractTextBody(rawSource);

    if (!body) {
      logger.debug({ uid, subject }, 'Skipping email with no text body');
      // Still mark as seen
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      return;
    }

    // Use Message-ID as thread key (or In-Reply-To chain root — simplified here)
    const threadId = rfc2822MessageId.replace(/[<>]/g, '');

    const chatJid = `gmail:${threadId}`;

    this.threadMeta.set(threadId, {
      sender: senderEmail,
      senderName,
      subject,
      messageId: rfc2822MessageId,
    });

    this.opts.onChatMetadata(chatJid, timestamp, subject, 'gmail', false);

    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);

    if (!mainEntry) {
      logger.debug(
        { chatJid, subject },
        'No main group registered, skipping email',
      );
      return;
    }

    const mainJid = mainEntry[0];
    const content = `[Email from ${senderName} <${senderEmail}>]\nSubject: ${subject}\n\n${body}`;

    this.opts.onMessage(mainJid, {
      id: String(uid),
      chat_jid: mainJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    // Mark as read
    try {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } catch (err) {
      logger.warn({ uid, err }, 'Failed to mark email as read');
    }

    logger.info(
      { mainJid, from: senderName, subject },
      'Gmail email delivered to main group',
    );
  }

  private extractHeader(raw: string, name: string): string {
    const match = raw.match(new RegExp(`^${name}:\\s*(.+)`, 'im'));
    return match ? match[1].trim() : '';
  }

  private extractTextBody(raw: string, depth = 0): string {
    if (depth > 10) return '';

    // Split headers from body at the first blank line
    const sep = raw.search(/\r?\n\r?\n/);
    const headerPart = sep >= 0 ? raw.slice(0, sep) : raw;
    const bodyPart = sep >= 0 ? raw.slice(sep).replace(/^\r?\n\r?\n/, '') : '';

    const contentType = this.extractHeader(headerPart, 'Content-Type');
    const encoding = this.extractHeader(
      headerPart,
      'Content-Transfer-Encoding',
    );

    if (contentType === '' || contentType.includes('text/plain')) {
      return this.decodeBody(bodyPart, encoding).trim();
    }

    if (contentType.includes('multipart/')) {
      const boundaryMatch = contentType.match(/boundary="?([^";\r\n]+)"?/i);
      if (!boundaryMatch) return '';
      const boundary = boundaryMatch[1].trim();
      // Split only the body part by boundary markers
      const parts = bodyPart.split(
        new RegExp(
          `\r?\n--${this.escapeRegex(boundary)}(?:--)?(?:\r?\n|$)`,
          'g',
        ),
      );
      for (const part of parts) {
        if (!part.trim()) continue;
        const text = this.extractTextBody(part, depth + 1);
        if (text) return text;
      }
    }

    return '';
  }

  private decodeBody(body: string, encoding: string): string {
    const enc = encoding.toLowerCase().trim();
    if (enc === 'base64') {
      return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
    }
    if (enc === 'quoted-printable') {
      return body
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        );
    }
    return body;
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

registerChannel('gmail', (opts: ChannelOpts) => {
  const configPath = path.join(os.homedir(), '.gmail-mcp', 'config.json');
  if (!fs.existsSync(configPath)) {
    logger.warn('Gmail: config.json not found in ~/.gmail-mcp/');
    return null;
  }
  return new GmailChannel(opts);
});
