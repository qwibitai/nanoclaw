import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
  account: string; // Which account received this email
}

interface GmailAccount {
  label: string;
  email: string;
  credDir: string;
  oauth2Client: OAuth2Client;
  gmail: gmail_v1.Gmail;
  processedIds: Set<string>;
  consecutiveErrors: number;
  routeToGroup?: string; // Group folder to route emails to (undefined = main)
}

/**
 * Multi-account Gmail channel.
 * Each account is polled independently. Emails are routed to the
 * project group matching the account, or to the main group as fallback.
 */
export class GmailChannel implements Channel {
  name = 'gmail';

  private accounts: GmailAccount[] = [];
  private opts: ChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private threadMeta = new Map<string, ThreadMeta>();

  constructor(opts: ChannelOpts, pollIntervalMs = 60000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    // Discover all Gmail credential directories
    const homeDir = os.homedir();
    const credDirs = discoverCredentialDirs(homeDir);

    if (credDirs.length === 0) {
      logger.warn(
        'Gmail: no credential directories found (~/.gmail-mcp*). Skipping.',
      );
      return;
    }

    for (const { label, credDir, routeToGroup } of credDirs) {
      try {
        const account = await this.connectAccount(label, credDir, routeToGroup);
        if (account) this.accounts.push(account);
      } catch (err) {
        logger.error(
          { label, credDir, err },
          'Failed to connect Gmail account',
        );
      }
    }

    if (this.accounts.length === 0) {
      logger.warn('Gmail: no accounts connected');
      return;
    }

    logger.info(
      {
        accountCount: this.accounts.length,
        emails: this.accounts.map((a) => a.email),
      },
      'Gmail channel connected',
    );

    // Real-time polling disabled — email recaps run as daily scheduled tasks
    // via Gmail MCP tools in the container agent. The channel stays alive
    // for sending replies via threadMeta cache.
    logger.info('Gmail polling disabled (daily digest mode)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const threadId = jid.replace(/^gmail:/, '');
    const meta = this.threadMeta.get(threadId);

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for reply, cannot send');
      return;
    }

    const account = this.accounts.find((a) => a.email === meta.account);
    if (!account) {
      logger.warn(
        { jid, account: meta.account },
        'Account not found for reply',
      );
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const headers = [
      `To: ${meta.sender}`,
      `From: ${account.email}`,
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
      await account.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });
      logger.info(
        { to: meta.sender, threadId, from: account.email },
        'Gmail reply sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Gmail reply');
    }
  }

  isConnected(): boolean {
    return this.accounts.length > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.accounts = [];
    logger.info('Gmail channel stopped');
  }

  // --- Private ---

  private async connectAccount(
    label: string,
    credDir: string,
    routeToGroup?: string,
  ): Promise<GmailAccount | null> {
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.debug(
        { label, credDir },
        'Gmail credentials incomplete, skipping',
      );
      return null;
    }

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    const oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    oauth2Client.setCredentials(tokens);

    // Persist refreshed tokens
    oauth2Client.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.debug({ label }, 'Gmail OAuth tokens refreshed');
      } catch (err) {
        logger.warn({ label, err }, 'Failed to persist refreshed Gmail tokens');
      }
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Verify connection
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress || '';
    logger.info({ label, email, routeToGroup }, 'Gmail account connected');

    return {
      label,
      email,
      credDir,
      oauth2Client,
      gmail,
      processedIds: new Set(),
      consecutiveErrors: 0,
      routeToGroup,
    };
  }

  private async pollAllAccounts(): Promise<void> {
    await Promise.all(
      this.accounts.map((account) => this.pollAccount(account)),
    );
  }

  private async pollAccount(account: GmailAccount): Promise<void> {
    try {
      const query = 'is:unread category:primary';
      const res = await account.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 10,
      });

      const messages = res.data.messages || [];

      for (const stub of messages) {
        if (!stub.id || account.processedIds.has(stub.id)) continue;
        account.processedIds.add(stub.id);
        await this.processMessage(account, stub.id);
      }

      // Cap processed ID set
      if (account.processedIds.size > 5000) {
        const ids = [...account.processedIds];
        account.processedIds = new Set(ids.slice(ids.length - 2500));
      }

      account.consecutiveErrors = 0;
    } catch (err) {
      account.consecutiveErrors++;
      logger.error(
        {
          account: account.email,
          consecutiveErrors: account.consecutiveErrors,
          err,
        },
        'Gmail poll failed',
      );
    }
  }

  private async processMessage(
    account: GmailAccount,
    messageId: string,
  ): Promise<void> {
    const msg = await account.gmail.users.messages.get({
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
    if (senderEmail === account.email) return;

    // Extract body text
    const body = this.extractTextBody(msg.data.payload);

    if (!body) {
      logger.debug({ messageId, subject }, 'Skipping email with no text body');
      return;
    }

    const chatJid = `gmail:${threadId}`;

    // Cache thread metadata for replies (capped to prevent unbounded growth)
    if (this.threadMeta.size > 5000) {
      const keys = [...this.threadMeta.keys()];
      for (let i = 0; i < keys.length - 2500; i++) {
        this.threadMeta.delete(keys[i]);
      }
    }
    this.threadMeta.set(threadId, {
      sender: senderEmail,
      senderName,
      subject,
      messageId: rfc2822MessageId,
      account: account.email,
    });

    // Store chat metadata for group discovery
    this.opts.onChatMetadata(chatJid, timestamp, subject, 'gmail', false);

    // Route to the right group based on account
    const targetJid = this.findTargetGroup(account);

    if (!targetJid) {
      logger.debug(
        { chatJid, subject, account: account.email },
        'No target group found for email',
      );
      return;
    }

    const content = `[Email from ${senderName} <${senderEmail}> to ${account.email}]\nSubject: ${subject}\n\n${body}`;

    this.opts.onMessage(targetJid, {
      id: messageId,
      chat_jid: targetJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    // Mark as read
    try {
      await account.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to mark email as read');
    }

    logger.info(
      { targetJid, from: senderName, subject, account: account.email },
      'Gmail email delivered',
    );
  }

  /**
   * Find the JID to deliver an email to based on account routing config.
   * Falls back to the first main group.
   */
  private findTargetGroup(account: GmailAccount): string | null {
    const groups = this.opts.registeredGroups();

    // If account has a specific route, find the group with that folder
    if (account.routeToGroup) {
      const entry = Object.entries(groups).find(
        ([, g]) => g.folder === account.routeToGroup,
      );
      if (entry) return entry[0];
    }

    // Fallback to first main group, preferring Discord over other channels
    const mainGroups = Object.entries(groups).filter(
      ([, g]) => g.isMain === true,
    );
    const discordMain = mainGroups.find(([jid]) => jid.startsWith('dc:'));
    if (discordMain) return discordMain[0];
    return mainGroups[0]?.[0] ?? null;
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

/**
 * Account routing configuration.
 * Maps credential directory suffixes to group folders.
 */
const ACCOUNT_ROUTES: Record<string, string> = {
  sunday: 'sunday',
  illysium: 'illysium',
  numberdrinks: 'number-drinks',
  personal2: 'personal',
};

/**
 * Discover all Gmail credential directories.
 * Looks for ~/.gmail-mcp (primary) and ~/.gmail-mcp-* (additional accounts).
 */
function discoverCredentialDirs(
  homeDir: string,
): { label: string; credDir: string; routeToGroup?: string }[] {
  const results: { label: string; credDir: string; routeToGroup?: string }[] =
    [];

  // Primary account
  const primaryDir = path.join(homeDir, '.gmail-mcp');
  if (
    fs.existsSync(path.join(primaryDir, 'gcp-oauth.keys.json')) &&
    fs.existsSync(path.join(primaryDir, 'credentials.json'))
  ) {
    results.push({
      label: 'primary',
      credDir: primaryDir,
      routeToGroup: 'personal',
    });
  }

  // Additional accounts: ~/.gmail-mcp-*
  try {
    const entries = fs.readdirSync(homeDir);
    for (const entry of entries) {
      if (!entry.startsWith('.gmail-mcp-')) continue;
      const suffix = entry.replace('.gmail-mcp-', '');
      const dir = path.join(homeDir, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (
        !fs.existsSync(path.join(dir, 'gcp-oauth.keys.json')) ||
        !fs.existsSync(path.join(dir, 'credentials.json'))
      ) {
        continue;
      }
      results.push({
        label: suffix,
        credDir: dir,
        routeToGroup: ACCOUNT_ROUTES[suffix],
      });
    }
  } catch {
    // ignore readdir errors
  }

  return results;
}

registerChannel('gmail', (opts: ChannelOpts) => {
  const homeDir = os.homedir();
  const dirs = discoverCredentialDirs(homeDir);
  if (dirs.length === 0) {
    logger.warn('Gmail: no credential directories found (~/.gmail-mcp*)');
    return null;
  }
  return new GmailChannel(opts);
});
