/**
 * Slack channel for Sovereign — Socket Mode (no public URL needed).
 * Mirrors the Discord channel interface: connect, sendMessage, disconnect.
 */
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
  private botUserId: string | null = null;

  constructor(botToken: string, appToken: string, opts: SlackChannelOpts) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // Get bot's own user ID so we can detect mentions
    try {
      const authResult = await this.app.client.auth.test({ token: this.botToken });
      this.botUserId = (authResult.user_id as string) || null;
    } catch (err) {
      logger.warn({ err }, 'Failed to get Slack bot user ID');
    }

    // Listen for all messages (channels, DMs, threads)
    this.app.message(async ({ message, say }) => {
      // Skip bot messages, message_changed events, etc.
      if (!('text' in message) || !('user' in message)) return;
      if (message.subtype) return; // edited, deleted, etc.

      const channelId = message.channel;
      const chatJid = `slack:${channelId}`;
      let content = message.text || '';
      const timestamp = message.ts;
      const sender = message.user;
      const msgId = message.ts; // Slack uses ts as message ID

      // Resolve sender name
      let senderName = sender;
      try {
        const userInfo = await this.app!.client.users.info({
          token: this.botToken,
          user: sender,
        });
        senderName = userInfo.user?.real_name || userInfo.user?.name || sender;
      } catch {
        // Fall back to user ID
      }

      // Resolve channel name for metadata
      let chatName = channelId;
      try {
        const channelInfo = await this.app!.client.conversations.info({
          token: this.botToken,
          channel: channelId,
        });
        chatName = channelInfo.channel?.name || channelId;
      } catch {
        // Fall back to channel ID (DMs don't have names)
        chatName = `DM:${senderName}`;
      }

      // Translate @bot mentions into trigger format
      if (this.botUserId && content.includes(`<@${this.botUserId}>`)) {
        content = content.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Handle thread context
      const threadTs = message.thread_ts;
      if (threadTs && threadTs !== message.ts) {
        content = `[Thread reply] ${content}`;
      }

      // Store chat metadata
      const isoTimestamp = new Date(parseFloat(timestamp) * 1000).toISOString();
      this.opts.onChatMetadata(chatJid, isoTimestamp, chatName, 'slack', true);

      // Only deliver for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, chatName }, 'Message from unregistered Slack channel');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp: isoTimestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, chatName, sender: senderName }, 'Slack message stored');
    });

    await this.app.start();
    logger.info('Slack bot connected (Socket Mode)');
    console.log(`\n  Slack bot connected via Socket Mode\n`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app) {
      logger.warn('Slack app not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^slack:/, '');

      // Slack has a 4000 char limit (40000 for blocks, but we use text)
      const MAX_LENGTH = 4000;
      if (text.length <= MAX_LENGTH) {
        await this.app.client.chat.postMessage({
          token: this.botToken,
          channel: channelId,
          text,
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.app.client.chat.postMessage({
            token: this.botToken,
            channel: channelId,
            text: text.slice(i, i + MAX_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  isConnected(): boolean {
    return this.app !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      logger.info('Slack bot stopped');
    }
  }
}
