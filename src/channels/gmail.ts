import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

// isMain flag is used instead of MAIN_GROUP_FOLDER constant
import { logger } from '../logger.js';
import type { EmailMeta } from '../gmail-ops.js';
import { registerChannel, ChannelOpts } from './registry.js';
import type { DraftReplyContext } from '../gmail-ops.js';
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

/** Multi-account Gmail configuration */
interface GmailAccountConfig {
  alias: string; // e.g. 'personal', 'whoisxml', 'attaxion'
  credDir: string; // e.g. '~/.gmail-mcp', '~/.gmail-mcp-attaxion'
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
}

export class GmailChannel implements Channel {
  name: string;

  private oauth2Client: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private opts: GmailChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private threadMeta = new Map<string, ThreadMeta>();
  private consecutiveErrors = 0;
  private userEmail = '';

  get emailAddress(): string {
    return this.userEmail;
  }

  private accountAlias: string;
  private credDir: string;

  constructor(
    opts: GmailChannelOpts,
    accountAlias = 'default',
    credDir?: string,
    pollIntervalMs = 60000,
  ) {
    this.opts = opts;
    this.accountAlias = accountAlias;
    this.credDir = credDir || path.join(os.homedir(), '.gmail-mcp');
    this.name = accountAlias === 'default' ? 'gmail' : `gmail-${accountAlias}`;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const keysPath = path.join(this.credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(this.credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        { alias: this.accountAlias, credDir: this.credDir },
        'Gmail credentials not found. Skipping Gmail channel.',
      );
      return;
    }

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    this.oauth2Client.setCredentials(tokens);

    // Persist refreshed tokens
    this.oauth2Client.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.debug('Gmail OAuth tokens refreshed');
      } catch (err) {
        logger.warn({ err }, 'Failed to persist refreshed Gmail tokens');
      }
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    // Verify connection
    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress || '';
    logger.info({ email: this.userEmail }, 'Gmail channel connected');

    // Start polling with error backoff
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
          .catch((err) => logger.error({ err }, 'Gmail poll error'))
          .finally(() => {
            if (this.gmail) schedulePoll();
          });
      }, backoffMs);
    };

    // Initial poll
    await this.pollForMessages();
    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized');
      return;
    }

    const threadId = jid.replace(/^gmail(-\w+)?:/, '');
    const meta = this.threadMeta.get(threadId);

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for reply, cannot send');
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const headers = [
      `To: ${meta.sender}`,
      `From: ${this.userEmail}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${meta.messageId}`,
      `References: ${meta.messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n');

    const encodedMessage = Buffer.from(headers)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });
      logger.info({ to: meta.sender, threadId }, 'Gmail reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Gmail reply');
    }
  }

  async forwardThread(threadId: string, recipient: string): Promise<void> {
    if (!this.gmail) throw new Error('Gmail not connected');

    // Get the latest message in the thread
    const thread = await this.gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const messages = thread.data.messages;
    if (!messages || messages.length === 0) {
      throw new Error(`No messages found in thread ${threadId}`);
    }

    const lastMsg = messages[messages.length - 1];
    const headers = lastMsg.payload?.headers || [];
    const subject =
      headers.find((h) => h.name?.toLowerCase() === 'subject')?.value || '';
    const from =
      headers.find((h) => h.name?.toLowerCase() === 'from')?.value || '';
    const date =
      headers.find((h) => h.name?.toLowerCase() === 'date')?.value || '';

    const body = this.extractTextBody(lastMsg.payload);
    const fwdSubject = subject.startsWith('Fwd:') ? subject : `Fwd: ${subject}`;

    const rawEmail = [
      `To: ${recipient}`,
      `From: ${this.userEmail}`,
      `Subject: ${fwdSubject}`,
      `Content-Type: text/plain; charset=utf-8`,
      '',
      `---------- Forwarded message ---------`,
      `From: ${from}`,
      `Date: ${date}`,
      `Subject: ${subject}`,
      '',
      body || '(no body)',
    ].join('\r\n');

    const encoded = Buffer.from(rawEmail)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded },
    });

    logger.info(
      { threadId, recipient, subject: fwdSubject },
      'Email forwarded',
    );
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  ownsJid(jid: string): boolean {
    const prefix =
      this.accountAlias !== 'default'
        ? `gmail-${this.accountAlias}:`
        : 'gmail:';
    return jid.startsWith(prefix);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.gmail = null;
    this.oauth2Client = null;
    logger.info('Gmail channel stopped');
  }

  // --- Private ---

  private buildQuery(): string {
    return 'is:unread category:primary';
  }

  private async pollForMessages(): Promise<void> {
    if (!this.gmail) return;

    try {
      const query = this.buildQuery();
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 10,
      });

      const messages = res.data.messages || [];

      for (const stub of messages) {
        if (!stub.id || this.processedIds.has(stub.id)) continue;
        this.processedIds.add(stub.id);

        await this.processMessage(stub.id);
      }

      // Cap processed ID set to prevent unbounded growth
      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
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
        'Gmail poll failed',
      );
    }
  }

  private async processMessage(messageId: string): Promise<void> {
    if (!this.gmail) return;

    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const from = getHeader('From');
    const subject = getHeader('Subject');
    const rfc2822MessageId = getHeader('Message-ID');
    const threadId = msg.data.threadId || messageId;
    const timestamp = new Date(
      parseInt(msg.data.internalDate || '0', 10),
    ).toISOString();

    // Extract sender name and email
    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    const senderName = senderMatch ? senderMatch[1].replace(/"/g, '') : from;
    const senderEmail = senderMatch ? senderMatch[2] : from;

    // Skip emails from self (our own replies)
    if (senderEmail === this.userEmail) return;

    // Extract body text
    const body = this.extractTextBody(msg.data.payload);

    if (!body) {
      logger.debug({ messageId, subject }, 'Skipping email with no text body');
      return;
    }

    const jidPrefix =
      this.accountAlias !== 'default' ? `gmail-${this.accountAlias}` : 'gmail';
    const chatJid = `${jidPrefix}:${threadId}`;

    // Cache thread metadata for replies
    this.threadMeta.set(threadId, {
      sender: senderEmail,
      senderName,
      subject,
      messageId: rfc2822MessageId,
    });

    // Store chat metadata for group discovery
    this.opts.onChatMetadata(chatJid, timestamp, subject, 'gmail', false);

    // Find the main group to deliver the email notification
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
    const accountTag =
      this.accountAlias !== 'default' ? ` [${this.accountAlias}]` : '';
    const content = `[Email${accountTag} from ${senderName} <${senderEmail}>]\nSubject: ${subject}\n\n${body}`;

    this.opts.onMessage(mainJid, {
      id: messageId,
      chat_jid: mainJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    // Mark as read
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to mark email as read');
    }

    logger.info(
      { mainJid, from: senderName, subject },
      'Gmail email delivered to main group',
    );
  }

  // --- GmailOps methods (satisfy GmailOpsProvider interface) ---

  async archiveThread(threadId: string): Promise<void> {
    if (!this.gmail) throw new Error('Gmail not connected');
    await this.gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: { removeLabelIds: ['INBOX'] },
    });
    logger.info({ threadId, account: this.accountAlias }, 'Thread archived');
  }

  async listRecentDrafts(): Promise<
    import('../draft-enrichment.js').DraftInfo[]
  > {
    if (!this.gmail) throw new Error('Gmail not connected');
    const res = await this.gmail.users.drafts.list({
      userId: 'me',
      maxResults: 10,
    });
    const stubs = res.data.drafts || [];
    const drafts: import('../draft-enrichment.js').DraftInfo[] = [];

    for (const stub of stubs) {
      if (!stub.id) continue;
      try {
        const full = await this.gmail.users.drafts.get({
          userId: 'me',
          id: stub.id,
        });
        const msg = full.data.message;
        if (!msg) continue;

        const headers = msg.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
            ?.value || '';

        drafts.push({
          draftId: stub.id,
          threadId: msg.threadId || '',
          account: this.accountAlias,
          subject: getHeader('Subject'),
          body: this.extractTextBody(msg.payload),
          createdAt: new Date(
            parseInt(msg.internalDate || '0', 10),
          ).toISOString(),
        });
      } catch (err) {
        logger.warn({ draftId: stub.id, err }, 'Failed to fetch draft details');
      }
    }
    return drafts;
  }

  async updateDraft(draftId: string, newBody: string): Promise<void> {
    if (!this.gmail) throw new Error('Gmail not connected');

    const existing = await this.gmail.users.drafts.get({
      userId: 'me',
      id: draftId,
    });
    const msg = existing.data.message;
    const headers = msg?.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const rawMessage = [
      `To: ${getHeader('To')}`,
      `From: ${getHeader('From')}`,
      `Subject: ${getHeader('Subject')}`,
      getHeader('In-Reply-To')
        ? `In-Reply-To: ${getHeader('In-Reply-To')}`
        : '',
      getHeader('References') ? `References: ${getHeader('References')}` : '',
      'Content-Type: text/plain; charset=utf-8',
      '',
      newBody,
    ]
      .filter(Boolean)
      .join('\r\n');

    const encoded = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await this.gmail.users.drafts.update({
      userId: 'me',
      id: draftId,
      requestBody: {
        message: { raw: encoded, threadId: msg?.threadId || undefined },
      },
    });
    logger.info(
      { draftId, account: this.accountAlias },
      'Draft updated with enriched body',
    );
  }

  async getMessageBody(messageId: string): Promise<string | null> {
    if (!this.gmail) return null;
    try {
      const msg = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const body = this.extractTextBody(msg.data.payload);
      return body || null;
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to fetch message body');
      return null;
    }
  }

  async getMessageMeta(messageId: string): Promise<EmailMeta | null> {
    if (!this.gmail) return null;
    try {
      const msg = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const headers = msg.data.payload?.headers || [];
      const header = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
          ?.value || '';
      const body = this.extractTextBody(msg.data.payload);
      return {
        subject: header('Subject'),
        from: header('From'),
        to: header('To'),
        date: header('Date'),
        cc: header('Cc') || undefined,
        body: body || '',
      };
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to fetch message meta');
      return null;
    }
  }

  async getDraftReplyContext(
    draftId: string,
  ): Promise<DraftReplyContext | null> {
    if (!this.gmail) throw new Error('Gmail not connected');
    try {
      const draft = await this.gmail.users.drafts.get({
        userId: 'me',
        id: draftId,
        format: 'full',
      });
      const msg = draft.data.message;
      if (!msg) return null;
      const body = this.extractTextBody(msg.payload);
      const threadId = msg.threadId;
      if (!threadId) {
        return {
          body,
          incoming: { from: '', to: '', subject: '', date: '' },
        };
      }
      const thread = await this.gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
      });
      const nonDraft = (thread.data.messages || [])
        .slice()
        .reverse()
        .find((m) => !(m.labelIds || []).includes('DRAFT'));
      const headers = nonDraft?.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
          ?.value || '';
      return {
        body,
        incoming: {
          from: getHeader('From'),
          to: getHeader('To'),
          subject: getHeader('Subject'),
          date: getHeader('Date'),
          cc: getHeader('Cc') || undefined,
        },
      };
    } catch (err: unknown) {
      const maybe = err as { code?: number };
      if (maybe && maybe.code === 404) return null;
      logger.warn(
        { draftId, err, account: this.accountAlias },
        'Failed to fetch draft reply context',
      );
      throw err;
    }
  }

  async sendDraft(draftId: string): Promise<void> {
    if (!this.gmail) throw new Error('Gmail not connected');
    const started = Date.now();
    try {
      const res = await this.gmail.users.drafts.send({
        userId: 'me',
        requestBody: { id: draftId },
      });
      logger.info(
        {
          account: this.accountAlias,
          draftId,
          threadId: res.data.threadId,
          elapsedMs: Date.now() - started,
        },
        'Draft sent',
      );
    } catch (err) {
      logger.error(
        { account: this.accountAlias, draftId, err },
        'Draft send failed',
      );
      throw err;
    }
  }

  extractTextBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
    if (!payload) return '';

    // Direct text/plain body
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    // Multipart: search parts recursively
    if (payload.parts) {
      // Prefer text/plain
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      // Recurse into nested multipart
      for (const part of payload.parts) {
        const text = this.extractTextBody(part);
        if (text) return text;
      }
    }

    return '';
  }
}

// Gmail channel DISABLED — email triage is handled by inbox_superpilot.
// The channel code is kept for reference but not registered.
// To re-enable, uncomment the registration block below.
//
// const GMAIL_ACCOUNTS: GmailAccountConfig[] = [
//   { alias: 'personal', credDir: path.join(os.homedir(), '.gmail-mcp') },
//   { alias: 'whoisxml', credDir: path.join(os.homedir(), '.gmail-mcp-jonathan') },
//   { alias: 'attaxion', credDir: path.join(os.homedir(), '.gmail-mcp-attaxion') },
//   { alias: 'dev', credDir: path.join(os.homedir(), '.gmail-mcp-dev') },
// ];
