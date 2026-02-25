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

    // Get bot user ID for mention detection
    const authResult = await this.app.client.auth.test();
    this.botUserId = authResult.user_id as string;

    // Handle all message events
    this.app.event('message', async ({ event, client }) => {
      // Type guard for message events with text
      if (!('text' in event) || !event.text) return;
      // Skip bot messages
      if ('bot_id' in event && event.bot_id) return;
      // Skip message subtypes (edits, deletes, etc.)
      if ('subtype' in event && event.subtype) return;

      const channelId = event.channel;
      const chatJid = `slack:${channelId}`;
      let content = event.text;
      const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();
      const sender = event.user || '';
      const msgId = event.ts;

      // Get sender display name
      let senderName = sender;
      try {
        const userInfo = await client.users.info({ user: sender });
        senderName =
          userInfo.user?.profile?.display_name ||
          userInfo.user?.profile?.real_name ||
          userInfo.user?.name ||
          sender;
      } catch {
        // Fall back to user ID
      }

      // Determine channel name and type
      let chatName = chatJid;
      let isGroup = true;
      try {
        const channelInfo = await client.conversations.info({
          channel: channelId,
        });
        chatName = channelInfo.channel?.name || chatJid;
        // DMs and MPIMs are "is_im" or "is_mpim"
        isGroup = !(
          channelInfo.channel?.is_im || channelInfo.channel?.is_mpim
        );
      } catch {
        // Fall back to JID as name
      }

      // Translate <@botUserId> mentions into TRIGGER_PATTERN format.
      // Slack @mentions (e.g., <@U123ABC>) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      if (this.botUserId) {
        const botMentionPattern = new RegExp(`<@${this.botUserId}>`, 'g');
        if (botMentionPattern.test(content) && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'slack', isGroup);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, chatName }, 'Message from unregistered Slack channel');
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Slack message stored',
      );
    });

    // Handle app_mention events (when bot is @mentioned)
    this.app.event('app_mention', async ({ event, client }) => {
      const channelId = event.channel;
      const chatJid = `slack:${channelId}`;
      let content = event.text;
      const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();
      const sender = event.user || '';
      const msgId = event.ts;

      // Get sender display name
      let senderName = sender;
      try {
        const userInfo = await client.users.info({ user: sender });
        senderName =
          userInfo.user?.profile?.display_name ||
          userInfo.user?.profile?.real_name ||
          userInfo.user?.name ||
          sender;
      } catch {
        // Fall back to user ID
      }

      // Determine channel name
      let chatName = chatJid;
      let isGroup = true;
      try {
        const channelInfo = await client.conversations.info({
          channel: channelId,
        });
        chatName = channelInfo.channel?.name || chatJid;
        isGroup = !(
          channelInfo.channel?.is_im || channelInfo.channel?.is_mpim
        );
      } catch {
        // Fall back to JID as name
      }

      // Translate mention to trigger format
      if (this.botUserId && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Store chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'slack', isGroup);

      // Only deliver for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid }, 'app_mention from unregistered Slack channel');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, sender: senderName }, 'Slack app_mention stored');
    });

    // Handle file shared events
    this.app.event('file_shared', async ({ event, client }) => {
      const channelId = event.channel_id;
      const chatJid = `slack:${channelId}`;

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      try {
        const fileInfo = await client.files.info({ file: event.file_id });
        const file = fileInfo.file;
        if (!file) return;

        const timestamp = new Date(
          parseFloat(event.event_ts) * 1000,
        ).toISOString();
        const sender = file.user || '';
        const msgId = event.event_ts;

        // Get sender name
        let senderName = sender;
        try {
          const userInfo = await client.users.info({ user: sender });
          senderName =
            userInfo.user?.profile?.display_name ||
            userInfo.user?.profile?.real_name ||
            userInfo.user?.name ||
            sender;
        } catch {
          // Fall back to user ID
        }

        // Determine file type placeholder
        let placeholder: string;
        const mimetype = file.mimetype || '';
        const filename = file.name || 'file';

        if (mimetype.startsWith('image/')) {
          placeholder = `[Image: ${filename}]`;
        } else if (mimetype.startsWith('video/')) {
          placeholder = `[Video: ${filename}]`;
        } else if (mimetype.startsWith('audio/')) {
          placeholder = `[Audio: ${filename}]`;
        } else {
          placeholder = `[File: ${filename}]`;
        }

        // Include initial comment if present
        const comment = file.initial_comment?.comment
          ? ` ${file.initial_comment.comment}`
          : '';

        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'slack',
          true,
        );
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content: `${placeholder}${comment}`,
          timestamp,
          is_from_me: false,
        });
      } catch (err) {
        logger.debug({ chatJid, err }, 'Failed to process file_shared event');
      }
    });

    // Start Socket Mode connection
    await this.app.start();

    logger.info(
      { botUserId: this.botUserId },
      'Slack bot connected via Socket Mode',
    );
    console.log(`\n  Slack bot connected (Socket Mode)`);
    console.log(`  Bot user ID: ${this.botUserId}`);
    console.log(
      `  Get channel ID from Slack channel settings (right-click channel > View channel details)\n`,
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app) {
      logger.warn('Slack app not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^slack:/, '');

      // Slack has a 4000 character limit per message — split if needed
      const MAX_LENGTH = 4000;
      if (text.length <= MAX_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.app.client.chat.postMessage({
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
      this.botUserId = null;
      logger.info('Slack bot stopped');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Slack doesn't support bot typing indicators — no-op
  }
}
