import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface SlackChannelOpts {
  botToken: string;
  appToken: string;
  signingSecret: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onAbort: (chatJid: string) => Promise<boolean>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

type SlackIncomingMessage = {
  text?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  ts?: string;
  channel_type?: 'channel' | 'group' | 'im' | 'mpim';
};

export function shouldIgnoreSlackMessageSubtype(subtype?: string): boolean {
  if (!subtype) return false;
  return subtype !== 'file_share';
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App | null = null;
  private connected = false;
  private opts: SlackChannelOpts;
  private botUserId = '';
  private lastUserByChannel = new Map<string, string>();
  private lastEphemeralAtByChannel = new Map<string, number>();

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    if (!opts.botToken || !opts.appToken || !opts.signingSecret) {
      throw new Error(
        'Missing Slack credentials. Set SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET.',
      );
    }
  }

  async connect(): Promise<void> {
    this.app = new App({
      token: this.opts.botToken,
      appToken: this.opts.appToken,
      signingSecret: this.opts.signingSecret,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    this.app.command('/abort', async ({ ack, command }) => {
      const cancelled = await this.opts.onAbort(command.channel_id);
      await ack(cancelled ? 'Abort requested.' : 'No active run to abort in this channel.');
    });

    this.app.message(async ({ message, client }) => {
      const m = message as SlackIncomingMessage;
      if (shouldIgnoreSlackMessageSubtype(m.subtype)) return;

      const chatJid = m.channel;
      const sender = m.user;
      if (!chatJid || !sender) return;

      this.lastUserByChannel.set(chatJid, sender);

      let content = m.text || '';
      if (!content.trim()) return;

      if (this.isAbortCommand(content)) {
        const cancelled = await this.opts.onAbort(chatJid);
        await this.postEphemeralStatus(
          chatJid,
          sender,
          cancelled ? 'Abort requested.' : 'No active run to abort in this channel.',
        );
        return;
      }

      const timestamp = new Date().toISOString();
      const isDm = m.channel_type === 'im' || chatJid.startsWith('D');
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', !isDm);

      const existing = this.opts.registeredGroups()[chatJid];
      if (!existing) {
        const mentioned = this.botUserId
          ? new RegExp(`<@${this.botUserId}>`).test(content)
          : false;
        if (!isDm && !mentioned) return;

        const channelName = await this.resolveChannelName(chatJid, client);
        const folderBase = slugify(channelName) || `slack-${chatJid.toLowerCase()}`;
        const folder = `${folderBase}-${chatJid.toLowerCase().slice(-6)}`;

        this.opts.registerGroup(chatJid, {
          name: channelName,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });

        logger.info({ chatJid, channelName, folder }, 'Auto-registered Slack channel as group');
      }

      if (this.botUserId && content.includes(`<@${this.botUserId}>`)) {
        content = content.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(chatJid, {
        id: m.ts || `${chatJid}-${Date.now()}`,
        chat_jid: chatJid,
        sender,
        sender_name: sender,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    await this.app.start();
    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id || '';
    this.connected = true;

    logger.info({ botUserId: this.botUserId }, 'Connected to Slack (Socket Mode)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app) return;
    await this.app.client.chat.postMessage({ channel: jid, text });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return /^[CDG][A-Z0-9]+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.app || !isTyping) return;

    const user = this.lastUserByChannel.get(jid);
    if (!user) return;

    const now = Date.now();
    const lastAt = this.lastEphemeralAtByChannel.get(jid) || 0;
    if (now - lastAt < 4000) return;

    await this.postEphemeralStatus(jid, user, 'NanoClaw is processing your request...');
    this.lastEphemeralAtByChannel.set(jid, now);
  }

  async syncGroupMetadata(): Promise<void> {
    // Not needed for MVP.
  }

  private isAbortCommand(text: string): boolean {
    const cleaned = text.trim().toLowerCase();
    if (cleaned === '/abort' || cleaned === 'abort') return true;
    if (this.botUserId) {
      const mentionAbort = new RegExp(`^<@${this.botUserId}>\\s+abort$`, 'i');
      if (mentionAbort.test(text.trim())) return true;
    }
    return false;
  }

  private async resolveChannelName(chatJid: string, client: App['client']): Promise<string> {
    try {
      const info = await client.conversations.info({ channel: chatJid });
      const c = info.channel as { name?: string; user?: string } | undefined;
      if (c?.name) return c.name;
      if (c?.user) return `dm-${c.user.toLowerCase()}`;
    } catch (err) {
      logger.warn({ err, chatJid }, 'Could not fetch Slack channel name, using ID fallback');
    }
    return `slack-${chatJid.toLowerCase()}`;
  }

  private async postEphemeralStatus(chatJid: string, userId: string, text: string): Promise<void> {
    if (!this.app) return;
    try {
      await this.app.client.chat.postEphemeral({
        channel: chatJid,
        user: userId,
        text,
      });
    } catch (err) {
      logger.debug({ err, chatJid, userId }, 'Failed to post Slack ephemeral status');
    }
  }
}
