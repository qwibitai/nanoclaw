import { App } from '@slack/bolt';

import { ASSISTANT_NAME, SLACK_APP_TOKEN, SLACK_BOT_TOKEN } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const SLACK_MAX_MESSAGE_LENGTH = 4000;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';
  prefixAssistantName = false;

  private app: App;
  private connected = false;
  private botUserId = '';
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();
  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    this.app = new App({
      token: SLACK_BOT_TOKEN,
      socketMode: true,
      appToken: SLACK_APP_TOKEN,
    });
  }

  async connect(): Promise<void> {
    // Get bot user ID so we can skip our own messages
    const authResult = await this.app.client.auth.test({ token: SLACK_BOT_TOKEN });
    this.botUserId = authResult.user_id as string;
    logger.info({ botUserId: this.botUserId }, 'Slack bot authenticated');

    // Register message listener
    this.app.event('message', async ({ event }) => {
      try {
        await this.handleMessage(event);
      } catch (err) {
        logger.error({ err }, 'Error handling Slack message');
      }
    });

    await this.app.start();
    this.connected = true;
    logger.info('Connected to Slack (Socket Mode)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    // Chunk long messages at SLACK_MAX_MESSAGE_LENGTH
    if (text.length <= SLACK_MAX_MESSAGE_LENGTH) {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text,
      });
    } else {
      let remaining = text;
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, SLACK_MAX_MESSAGE_LENGTH);
        remaining = remaining.slice(SLACK_MAX_MESSAGE_LENGTH);
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: chunk,
        });
      }
    }

    logger.info({ jid, length: text.length }, 'Slack message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
    logger.info('Disconnected from Slack');
  }

  async setTyping(): Promise<void> {
    // Slack doesn't support bot typing indicators in regular channels — no-op
  }

  private async handleMessage(event: Record<string, any>): Promise<void> {
    // Skip bot's own messages
    if (event.bot_id || event.user === this.botUserId) return;

    // Skip subtypes (edits, joins, channel_topic, etc.)
    if (event.subtype) return;

    const channelId = event.channel as string;
    const slackJid = `slack:${channelId}`;
    const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();

    // Resolve channel name for metadata
    const channelName = await this.resolveChannelName(channelId);

    // Notify about chat metadata for all messages (passes channel name inline)
    this.opts.onChatMetadata(slackJid, timestamp, channelName);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[slackJid]) return;

    let content = (event.text as string) || '';

    // Translate <@BOT_ID> mentions into @AssistantName trigger format
    const botMentionPattern = new RegExp(`<@${this.botUserId}>`, 'g');
    content = content.replace(botMentionPattern, `@${ASSISTANT_NAME}`);

    // Resolve sender display name
    const userId = event.user as string;
    const senderName = await this.resolveUserName(userId);

    this.opts.onMessage(slackJid, {
      id: event.ts as string,
      chat_jid: slackJid,
      sender: userId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name =
        result.user?.profile?.display_name ||
        result.user?.real_name ||
        result.user?.name ||
        userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return userId;
    }
  }

  private async resolveChannelName(channelId: string): Promise<string> {
    const cached = this.channelNameCache.get(channelId);
    if (cached) return cached;

    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      const name = result.channel?.name || channelId;
      this.channelNameCache.set(channelId, name);
      return name;
    } catch (err) {
      logger.debug({ channelId, err }, 'Failed to resolve Slack channel name');
      return channelId;
    }
  }
}
