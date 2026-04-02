import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

// isMain flag is used instead of MAIN_GROUP_FOLDER constant
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// --- Gmail send allowlist config (external JSON with cache) ---

interface GmailSendAllowlistConfig {
  direct_send: string[];
  notify_email: string;
  cc_email: string;
}

const GMAIL_ALLOWLIST_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'gmail-send-allowlist.json',
);

const GMAIL_ALLOWLIST_DEFAULTS: GmailSendAllowlistConfig = {
  direct_send: [
    'eline@bestoftours.co.uk',
    'ahmed@bestoftours.co.uk',
    'yacine@bestoftours.co.uk',
  ],
  notify_email: 'yacine@bestoftours.co.uk',
  cc_email: 'yacine@bestoftours.co.uk',
};

const GMAIL_ALLOWLIST_CACHE_TTL_MS = 60_000;
let _gmailAllowlistCache: GmailSendAllowlistConfig | null = null;
let _gmailAllowlistCacheTs = 0;

function loadGmailSendAllowlist(): GmailSendAllowlistConfig {
  if (
    _gmailAllowlistCache &&
    Date.now() - _gmailAllowlistCacheTs < GMAIL_ALLOWLIST_CACHE_TTL_MS
  ) {
    return _gmailAllowlistCache;
  }

  let config: GmailSendAllowlistConfig;

  try {
    const raw = fs.readFileSync(GMAIL_ALLOWLIST_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    config = {
      direct_send: Array.isArray(parsed.direct_send)
        ? parsed.direct_send.map((e: string) => e.toLowerCase().trim())
        : GMAIL_ALLOWLIST_DEFAULTS.direct_send,
      notify_email: parsed.notify_email || GMAIL_ALLOWLIST_DEFAULTS.notify_email,
      cc_email: parsed.cc_email || GMAIL_ALLOWLIST_DEFAULTS.cc_email,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist — create with defaults
      try {
        const dir = path.dirname(GMAIL_ALLOWLIST_PATH);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          GMAIL_ALLOWLIST_PATH,
          JSON.stringify(GMAIL_ALLOWLIST_DEFAULTS, null, 2) + '\n',
        );
        logger.info(
          { path: GMAIL_ALLOWLIST_PATH },
          'Created default gmail-send-allowlist.json',
        );
      } catch (writeErr) {
        logger.warn(
          { err: writeErr, path: GMAIL_ALLOWLIST_PATH },
          'Failed to create default gmail-send-allowlist.json',
        );
      }
      config = { ...GMAIL_ALLOWLIST_DEFAULTS };
    } else {
      logger.warn(
        { err, path: GMAIL_ALLOWLIST_PATH },
        'Failed to read gmail-send-allowlist.json, using defaults',
      );
      config = { ...GMAIL_ALLOWLIST_DEFAULTS };
    }
  }

  // Env var override still works as fallback
  const envOverride = process.env.GMAIL_DIRECT_SEND_ALLOWLIST;
  if (envOverride) {
    config.direct_send = envOverride
      .toLowerCase()
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
  }
  if (process.env.GMAIL_NOTIFY_EMAIL) {
    config.notify_email = process.env.GMAIL_NOTIFY_EMAIL;
  }
  if (process.env.GMAIL_CC_EMAIL) {
    config.cc_email = process.env.GMAIL_CC_EMAIL;
  }

  _gmailAllowlistCache = config;
  _gmailAllowlistCacheTs = Date.now();
  return config;
}

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
}

export class GmailChannel implements Channel {
  name = 'gmail';

  private oauth2Client: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private opts: GmailChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private threadMeta = new Map<string, ThreadMeta>();
  private consecutiveErrors = 0;
  private userEmail = '';
  private lastDeliveredThreadId = '';

  constructor(opts: GmailChannelOpts, pollIntervalMs = 60000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const credDir =
      process.env.GMAIL_MCP_DIR || path.join(os.homedir(), '.gmail-mcp');
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        'Gmail credentials not found in ~/.gmail-mcp/. Skipping Gmail channel. Run /add-gmail to set up.',
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

  private isDirectSendAllowed(recipientEmail: string): boolean {
    const cfg = loadGmailSendAllowlist();
    return cfg.direct_send.includes(recipientEmail.toLowerCase());
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized');
      return;
    }

    let threadId = jid.replace(/^gmail:/, '');
    let meta = this.threadMeta.get(threadId);

    // Main group aggregation: find the most recent thread to reply to.
    // The agent's response may contain "[Reply to: X]" to target a specific sender,
    // otherwise we reply to the last email received.
    if (!meta && threadId === 'main') {
      // Try to match a sender from the response text
      const replyMatch = text.match(/\[Reply to:\s*(.+?)\]/i);
      if (replyMatch) {
        const target = replyMatch[1].toLowerCase().trim();
        for (const [tid, m] of this.threadMeta) {
          if (
            m.sender.toLowerCase().includes(target) ||
            m.senderName.toLowerCase().includes(target)
          ) {
            threadId = tid;
            meta = m;
            text = text.replace(/\[Reply to:\s*.+?\]\s*/i, '').trim();
            break;
          }
        }
      }
      // Fallback: most recent thread
      if (!meta && this.lastDeliveredThreadId) {
        threadId = this.lastDeliveredThreadId;
        meta = this.threadMeta.get(threadId);
      }
    }

    if (!meta) {
      logger.warn(
        { jid, threadId },
        'No thread metadata for reply, cannot send',
      );
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const allowlistCfg = loadGmailSendAllowlist();

    if (this.isDirectSendAllowed(meta.sender)) {
      // Direct send to allowlisted recipients, CC yacine@
      const headerLines = [
        `To: ${meta.sender}`,
        `From: ${this.userEmail}`,
        `Subject: ${subject}`,
        `In-Reply-To: ${meta.messageId}`,
        `References: ${meta.messageId}`,
      ];
      if (meta.sender.toLowerCase() !== allowlistCfg.cc_email.toLowerCase()) {
        headerLines.push(`Cc: ${allowlistCfg.cc_email}`);
      }
      headerLines.push('Content-Type: text/plain; charset=utf-8', '', text);

      const headers = headerLines.join('\r\n');

      const encodedMessage = Buffer.from(headers)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      try {
        await this.gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: encodedMessage, threadId },
        });
        logger.info({ to: meta.sender, threadId }, 'Gmail reply sent');
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send Gmail reply');
      }
    } else {
      // External recipient: create draft + send notification to yacine@
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
        const draft = await this.gmail.users.drafts.create({
          userId: 'me',
          requestBody: {
            message: { raw: encodedMessage, threadId },
          },
        });
        logger.info(
          { to: meta.sender, threadId, draftId: draft.data.id },
          'Gmail draft created (external recipient)',
        );

        // Notify yacine@ about the pending draft
        const notifyHeaders = [
          `To: ${allowlistCfg.notify_email}`,
          `From: ${this.userEmail}`,
          `Subject: [Draft pending] ${subject} → ${meta.sender}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          `Draft reply created for ${meta.senderName} <${meta.sender}>.\n\n` +
            `Subject: ${subject}\n` +
            `---\n${text}\n---\n\n` +
            `Review and send from ${this.userEmail} drafts.`,
        ].join('\r\n');

        const encodedNotify = Buffer.from(notifyHeaders)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

        await this.gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: encodedNotify },
        });
        logger.info(
          { to: allowlistCfg.notify_email, draftFor: meta.sender },
          'Draft notification sent',
        );
      } catch (err) {
        logger.error({ jid, err }, 'Failed to create Gmail draft');
      }
    }
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
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
    return 'is:unread in:inbox';
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

      // Cap sets to prevent unbounded growth
      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
      }
      if (this.threadMeta.size > 1000) {
        const entries = [...this.threadMeta.entries()];
        this.threadMeta = new Map(entries.slice(entries.length - 500));
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

    const chatJid = `gmail:${threadId}`;

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
    const content = `[Email from ${senderName} <${senderEmail}>]\nSubject: ${subject}\n\n${body}`;

    // Track last thread for reply routing from main group
    this.lastDeliveredThreadId = threadId;

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

  private extractTextBody(
    payload: gmail_v1.Schema$MessagePart | undefined,
  ): string {
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

registerChannel('gmail', (opts: ChannelOpts) => {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  if (
    !fs.existsSync(path.join(credDir, 'gcp-oauth.keys.json')) ||
    !fs.existsSync(path.join(credDir, 'credentials.json'))
  ) {
    logger.warn('Gmail: credentials not found in ~/.gmail-mcp/');
    return null;
  }
  return new GmailChannel(opts);
});
