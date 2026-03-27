import fs from 'fs';
import os from 'os';
import path from 'path';

import { PublicClientApplication, AccountInfo } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface OutlookChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  conversationId: string;
}

const SCOPES = ['Mail.Read', 'Mail.Send', 'User.Read'];
const CRED_DIR = path.join(os.homedir(), '.outlook-mcp');
const CACHE_PATH = path.join(CRED_DIR, 'msal-cache.json');

export class OutlookChannel implements Channel {
  name = 'outlook';

  private client: Client | null = null;
  private pca: PublicClientApplication | null = null;
  private account: AccountInfo | null = null;
  private opts: OutlookChannelOpts;
  private userEmail: string;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private consecutiveErrors = 0;
  private threadMeta = new Map<string, ThreadMeta>();

  constructor(
    opts: OutlookChannelOpts,
    userEmail: string,
    pollIntervalMs = 60000,
  ) {
    this.opts = opts;
    this.userEmail = userEmail;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    if (!fs.existsSync(CACHE_PATH)) {
      logger.warn(
        'Outlook credentials not found in ~/.outlook-mcp/. Skipping. Run: npx tsx scripts/outlook-login.ts',
      );
      return;
    }

    const secrets = readEnvFile(['MS_TENANT_ID', 'MS_CLIENT_ID']);

    this.pca = new PublicClientApplication({
      auth: {
        clientId: secrets.MS_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${secrets.MS_TENANT_ID}`,
      },
    });

    // Load cached tokens
    const cache = fs.readFileSync(CACHE_PATH, 'utf-8');
    this.pca.getTokenCache().deserialize(cache);

    const accounts = await this.pca.getTokenCache().getAllAccounts();
    if (accounts.length === 0) {
      logger.error(
        'Outlook: no cached accounts. Run: npx tsx scripts/outlook-login.ts',
      );
      return;
    }

    this.account = accounts[0];

    // Acquire token silently (uses refresh token)
    const tokenResult = await this.acquireToken();
    if (!tokenResult) return;

    this.client = Client.init({
      authProvider: async (done) => {
        const result = await this.acquireToken();
        if (result) {
          done(null, result);
        } else {
          done(new Error('Failed to acquire Outlook token'), null);
        }
      },
    });

    // Verify connection
    try {
      const user = await this.client.api('/me').get();
      this.userEmail = user.mail || user.userPrincipalName || this.userEmail;
      logger.info(
        { email: this.userEmail, name: user.displayName },
        'Outlook channel connected',
      );
    } catch (err) {
      logger.error({ err }, 'Outlook: failed to verify connection');
      this.client = null;
      return;
    }

    // Initial poll then schedule
    await this.pollForMessages();

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
          .catch((err) => logger.error({ err }, 'Outlook poll error'))
          .finally(() => {
            if (this.client) schedulePoll();
          });
      }, backoffMs);
    };

    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Outlook not initialized');
      return;
    }

    const conversationId = jid.replace(/^outlook:/, '');
    const meta = this.threadMeta.get(conversationId);

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for Outlook reply, cannot send');
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    try {
      await this.client.api('/me/sendMail').post({
        message: {
          subject,
          body: { contentType: 'text', content: text },
          toRecipients: [
            { emailAddress: { address: meta.sender, name: meta.senderName } },
          ],
          conversationId: meta.conversationId,
        },
      });
      logger.info({ to: meta.sender, conversationId }, 'Outlook reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Outlook reply');
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('outlook:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.client = null;
    logger.info('Outlook channel stopped');
  }

  // --- Private ---

  private async acquireToken(): Promise<string | null> {
    if (!this.pca || !this.account) return null;

    try {
      const result = await this.pca.acquireTokenSilent({
        account: this.account,
        scopes: SCOPES,
      });

      // Persist updated cache (new refresh tokens)
      const cache = this.pca.getTokenCache().serialize();
      fs.writeFileSync(CACHE_PATH, cache);

      return result.accessToken;
    } catch (err) {
      logger.error(
        { err },
        'Outlook: silent token acquisition failed — re-run scripts/outlook-login.ts',
      );
      return null;
    }
  }

  private async pollForMessages(): Promise<void> {
    if (!this.client) return;

    try {
      const res = await this.client
        .api('/me/messages')
        .filter('isRead eq false')
        .orderby('receivedDateTime desc')
        .top(10)
        .select('id,subject,from,receivedDateTime,body,conversationId')
        .get();

      const messages: any[] = res.value || [];

      for (const msg of messages) {
        if (!msg.id || this.processedIds.has(msg.id)) continue;
        this.processedIds.add(msg.id);
        await this.processMessage(msg);
      }

      // Cap set size
      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      logger.error(
        { err, consecutiveErrors: this.consecutiveErrors },
        'Outlook poll failed',
      );
    }
  }

  private async processMessage(msg: any): Promise<void> {
    if (!this.client) return;

    const from = msg.from?.emailAddress;
    const senderEmail = from?.address || 'unknown';
    const senderName = from?.name || senderEmail;

    // Skip self
    if (senderEmail.toLowerCase() === this.userEmail.toLowerCase()) return;

    const subject = msg.subject || '(no subject)';
    const timestamp = msg.receivedDateTime || new Date().toISOString();
    const conversationId = msg.conversationId || msg.id;
    const chatJid = `outlook:${conversationId}`;

    // Extract plain text body
    let body = '';
    if (msg.body?.contentType === 'text') {
      body = msg.body.content || '';
    } else if (msg.body?.content) {
      // Strip HTML tags
      body = msg.body.content
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (!body) {
      logger.debug(
        { msgId: msg.id, subject },
        'Skipping Outlook email with no body',
      );
      return;
    }

    // Cache thread metadata for replies
    this.threadMeta.set(conversationId, {
      sender: senderEmail,
      senderName,
      subject,
      conversationId,
    });

    // Cap thread meta cache
    if (this.threadMeta.size > 2000) {
      const keys = [...this.threadMeta.keys()];
      for (let i = 0; i < keys.length - 1000; i++) {
        this.threadMeta.delete(keys[i]);
      }
    }

    this.opts.onChatMetadata(chatJid, timestamp, subject, 'outlook', false);

    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);

    if (!mainEntry) {
      logger.debug(
        { chatJid, subject },
        'No main group registered, skipping Outlook email',
      );
      return;
    }

    const mainJid = mainEntry[0];
    const content = `[Outlook email from ${senderName} <${senderEmail}>]\nSubject: ${subject}\n\n${body}`;

    this.opts.onMessage(mainJid, {
      id: msg.id,
      chat_jid: mainJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    // Mark as read
    try {
      await this.client.api(`/me/messages/${msg.id}`).patch({ isRead: true });
    } catch (err) {
      logger.warn(
        { msgId: msg.id, err },
        'Failed to mark Outlook email as read',
      );
    }

    logger.info(
      { mainJid, from: senderName, subject },
      'Outlook email delivered to main group',
    );
  }
}

registerChannel('outlook', (opts: ChannelOpts) => {
  const secrets = readEnvFile([
    'MS_TENANT_ID',
    'MS_CLIENT_ID',
    'MS_USER_EMAIL',
  ]);
  if (
    !secrets.MS_TENANT_ID ||
    !secrets.MS_CLIENT_ID ||
    !secrets.MS_USER_EMAIL
  ) {
    logger.warn(
      'Outlook: MS_TENANT_ID, MS_CLIENT_ID, MS_USER_EMAIL required in .env. Skipping.',
    );
    return null;
  }
  if (!fs.existsSync(CACHE_PATH)) {
    logger.warn(
      'Outlook: no cached tokens in ~/.outlook-mcp/. Run: npx tsx scripts/outlook-login.ts',
    );
    return null;
  }
  return new OutlookChannel(opts, secrets.MS_USER_EMAIL);
});
