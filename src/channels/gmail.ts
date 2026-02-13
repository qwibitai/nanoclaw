import fs from 'fs';
import path from 'path';
import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { GMAIL_LABEL, GMAIL_POLL_INTERVAL } from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage } from '../types.js';

const GMAIL_JID = 'gmail:inbox';
const CREDENTIALS_DIR = path.join(process.env.HOME || '/home/user', '.gmail-mcp');
const OAUTH_KEYS_PATH = path.join(CREDENTIALS_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, 'credentials.json');

interface PendingReply {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  references: string;
}

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class GmailChannel implements Channel {
  name = 'gmail';
  prefixAssistantName = true;

  private opts: GmailChannelOpts;
  private auth: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private labelId: string | null = null;
  private pendingReplies: PendingReply[] = [];

  constructor(opts: GmailChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Load OAuth keys
    if (!fs.existsSync(OAUTH_KEYS_PATH)) {
      throw new Error(`Gmail OAuth keys not found at ${OAUTH_KEYS_PATH}`);
    }
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      throw new Error(`Gmail credentials not found at ${CREDENTIALS_PATH}`);
    }

    const keys = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf-8'));
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));

    const { client_id, client_secret, redirect_uris } = keys.installed || keys.web;
    this.auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    this.auth.setCredentials({
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
      token_type: creds.token_type,
      expiry_date: creds.expiry_date,
    });

    // Auto-save refreshed tokens
    this.auth.on('tokens', (tokens) => {
      const existing = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
      if (tokens.access_token) existing.access_token = tokens.access_token;
      if (tokens.refresh_token) existing.refresh_token = tokens.refresh_token;
      if (tokens.expiry_date) existing.expiry_date = tokens.expiry_date;
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(existing));
      logger.debug('Gmail tokens refreshed and saved');
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.auth });

    // Resolve label ID
    const labels = await this.gmail.users.labels.list({ userId: 'me' });
    const label = labels.data.labels?.find(
      (l) => l.name?.toLowerCase() === GMAIL_LABEL.toLowerCase(),
    );
    if (!label?.id) {
      throw new Error(`Gmail label "${GMAIL_LABEL}" not found`);
    }
    this.labelId = label.id;

    this.connected = true;
    logger.info(
      { label: GMAIL_LABEL, labelId: this.labelId },
      'Gmail channel connected',
    );
    console.log(`\n  Gmail: polling label "${GMAIL_LABEL}" every ${GMAIL_POLL_INTERVAL / 1000}s\n`);

    // Start polling
    await this.poll();
    this.pollTimer = setInterval(() => this.poll(), GMAIL_POLL_INTERVAL);
  }

  private async poll(): Promise<void> {
    if (!this.gmail || !this.labelId) return;

    try {
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: `label:${GMAIL_LABEL} is:unread`,
        maxResults: 10,
      });

      const messageIds = res.data.messages || [];
      if (messageIds.length === 0) return;

      logger.info({ count: messageIds.length }, 'Gmail: new unread messages');

      for (const msg of messageIds) {
        if (!msg.id) continue;
        try {
          await this.processMessage(msg.id);
        } catch (err) {
          logger.error({ messageId: msg.id, err }, 'Gmail: failed to process message');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Gmail: poll error');
    }
  }

  private async processMessage(messageId: string): Promise<void> {
    if (!this.gmail) return;

    const full = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = full.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    const subject = getHeader('Subject');
    const from = getHeader('From');
    const msgIdHeader = getHeader('Message-ID');
    const references = getHeader('References');
    const threadId = full.data.threadId || '';
    const internalDate = full.data.internalDate
      ? new Date(parseInt(full.data.internalDate, 10)).toISOString()
      : new Date().toISOString();

    // Extract body
    const body = this.extractBody(full.data.payload);

    // Mark as read
    await this.gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });

    // Extract sender name from "Name <email>" format
    const senderName = from.includes('<')
      ? from.split('<')[0].trim().replace(/^"|"$/g, '')
      : from.split('@')[0];

    // Queue reply metadata
    this.pendingReplies.push({
      messageId: msgIdHeader,
      threadId,
      subject,
      from,
      references: references ? `${references} ${msgIdHeader}` : msgIdHeader,
    });

    // Deliver to message pipeline
    const content = `[Email] Subject: ${subject}\n\n${body}`;

    this.opts.onChatMetadata(GMAIL_JID, internalDate, 'Gmail');
    this.opts.onMessage(GMAIL_JID, {
      id: messageId,
      chat_jid: GMAIL_JID,
      sender: from,
      sender_name: senderName,
      content,
      timestamp: internalDate,
      is_from_me: false,
    });

    logger.info(
      { messageId, subject, from: senderName },
      'Gmail: message processed',
    );
  }

  private extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
    if (!payload) return '';

    // Simple body (no parts)
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    }

    // Multipart: prefer text/plain, fallback to text/html stripped
    if (payload.parts) {
      const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
      }

      const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
      if (htmlPart?.body?.data) {
        const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
        return this.stripHtml(html);
      }

      // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
      for (const part of payload.parts) {
        if (part.parts) {
          const nested = this.extractBody(part);
          if (nested) return nested;
        }
      }
    }

    return '';
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized, cannot send');
      return;
    }

    const reply = this.pendingReplies.shift();
    if (!reply) {
      logger.warn('Gmail: no pending reply context, cannot send');
      return;
    }

    try {
      // Build reply email
      const replySubject = reply.subject.startsWith('Re:')
        ? reply.subject
        : `Re: ${reply.subject}`;

      const rawMessage = [
        `To: ${reply.from}`,
        `Subject: ${replySubject}`,
        `In-Reply-To: ${reply.messageId}`,
        `References: ${reply.references}`,
        `Content-Type: text/plain; charset=UTF-8`,
        '',
        text,
      ].join('\r\n');

      const encoded = Buffer.from(rawMessage).toString('base64url');

      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encoded,
          threadId: reply.threadId,
        },
      });

      logger.info(
        { to: reply.from, subject: replySubject },
        'Gmail: reply sent',
      );
    } catch (err) {
      logger.error({ err, to: reply.from }, 'Gmail: failed to send reply');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    logger.info('Gmail channel disconnected');
  }
}
