import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';
  private app: App | null = null;
  private opts: SlackChannelOpts;
  private botToken: string;
  private appToken: string;
  private signingSecret: string;
  private connected = false;
  private botUserId: string | null = null;

  constructor(botToken: string, appToken: string, signingSecret: string, opts: SlackChannelOpts) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.signingSecret = signingSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      signingSecret: this.signingSecret,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = (authResult.user_id as string) || null;
      logger.info({ botUserId: this.botUserId }, 'Slack bot user ID resolved');
    } catch (err) {
      logger.warn({ err }, 'Could not resolve Slack bot user ID');
    }

    // Channel @mentions
    this.app.event('app_mention', async ({ event }) => {
      const chatJid = `slack:${event.channel}`;
      const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();
      let content = (event.text || '').replace(/<@[A-Z0-9]+>/g, `@${ASSISTANT_NAME}`).trim();
      if (!TRIGGER_PATTERN.test(content)) content = `@${ASSISTANT_NAME} ${content}`;

      this.opts.onChatMetadata(chatJid, timestamp, event.channel, 'slack', true);
      if (!this.opts.registeredGroups()[chatJid]) return;

      this.opts.onMessage(chatJid, {
        id: event.ts,
        chat_jid: chatJid,
        sender: event.user ?? 'unknown',
        sender_name: event.user ?? 'unknown',
        content,
        timestamp,
        is_from_me: false,
      });
      logger.info({ chatJid, sender: event.user }, 'Slack mention stored');
    });

    // DMs only
    this.app.message(async ({ message }) => {
      const msg = message as GenericMessageEvent;
      if (msg.subtype !== undefined || msg.bot_id) return;
      if (this.botUserId && msg.user === this.botUserId) return;
      if (msg.channel_type !== 'im') return;

      const chatJid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      let content = msg.text || '';
      if (!TRIGGER_PATTERN.test(content)) content = `@${ASSISTANT_NAME} ${content}`;

      this.opts.onChatMetadata(chatJid, timestamp, msg.user, 'slack', false);
      if (!this.opts.registeredGroups()[chatJid]) return;

      this.opts.onMessage(chatJid, {
        id: msg.ts,
        chat_jid: chatJid,
        sender: msg.user,
        sender_name: msg.user,
        content,
        timestamp,
        is_from_me: false,
      });
      logger.info({ chatJid, sender: msg.user }, 'Slack DM stored');
    });

    await this.app.start();
    this.connected = true;
    logger.info('Slack bot connected (Socket Mode)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app) return;
    const channelId = jid.replace(/^slack:/, '');
    const MAX = 3000;
    try {
      for (let i = 0; i < text.length; i += MAX) {
        await this.app.client.chat.postMessage({ channel: channelId, text: text.slice(i, i + MAX) });
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      this.connected = false;
      logger.info('Slack bot stopped');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // No-op: conversations.typing is not available in the modern Slack Web API
  }
}
