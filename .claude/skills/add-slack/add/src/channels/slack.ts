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
  private botToken: string;
  private appToken: string;
  private opts: SlackChannelOpts;
  private botUserId: string = '';
  private connected = false;

  // Cache for user/channel display names
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();

  // Track the most recent trigger ts per JID (for reply threading)
  private lastTriggerTs = new Map<string, string>();

  // Track threads started by an @mention — only these get auto-replies
  private botThreads = new Set<string>();

  // Dedup: track recently processed message timestamps
  private processedTs = new Set<string>();

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
      logLevel: LogLevel.ERROR,
    });

    // Get bot user ID for mention stripping
    try {
      const authResult = await this.app.client.auth.test({ token: this.botToken });
      this.botUserId = (authResult.user_id as string) || '';
    } catch (err) {
      logger.warn({ err }, 'Failed to get Slack bot user ID via auth.test');
    }

    // Handle @mentions in channels
    this.app.event('app_mention', async ({ event }) => {
      const e = event as any;
      logger.debug(
        { channel: e.channel, user: e.user, text: e.text?.slice(0, 50) },
        'Slack app_mention event received',
      );
      // Only track as bot-initiated thread if the @mention IS the thread parent
      // (i.e. it's a top-level message, not a reply within an existing thread)
      if (!e.thread_ts) {
        this.botThreads.add(e.ts);
      }
      await this.handleMessage(event);
    });

    // Handle DMs and thread replies via the 'message' event type
    this.app.event('message', async ({ event }) => {
      const msg = event as any;
      logger.debug(
        { channel_type: msg.channel_type, subtype: msg.subtype, user: msg.user, channel: msg.channel, thread_ts: msg.thread_ts, text: msg.text?.slice(0, 50) },
        'Slack message event received',
      );
      // Skip bot messages and subtypes (join/leave/etc)
      if (msg.subtype || !msg.user || msg.user === this.botUserId) return;

      const isDM = msg.channel_type === 'im';
      const isThreadReply = !!msg.thread_ts && msg.thread_ts !== msg.ts;
      const isBotThread = isThreadReply && this.botThreads.has(msg.thread_ts);
      const hasBotMention = this.botUserId && new RegExp(`<@${this.botUserId}>`).test(msg.text || '');

      // Handle: DMs (always), thread replies in bot-started threads (auto-respond),
      // or thread replies with explicit @mention (in any thread)
      // Top-level @mentions are handled by app_mention, not here
      if (isDM || isBotThread || (isThreadReply && hasBotMention)) {
        await this.handleMessage(msg);
      }
    });

    await this.app.start();
    this.connected = true;

    logger.info(
      { botUserId: this.botUserId },
      'Slack bot connected (Socket Mode)',
    );
    console.log(`\n  Slack bot: connected (user ${this.botUserId})`);
    console.log(
      `  Invite the bot to channels and @mention it to trigger\n`,
    );
  }

  private async handleMessage(event: {
    user?: string;
    channel?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    files?: Array<{ name?: string; mimetype?: string }>;
    channel_type?: string;
  }): Promise<void> {
    const userId = event.user || '';
    const channelId = event.channel || '';
    const ts = event.ts || '';
    const isDM = event.channel_type === 'im';
    let content = event.text || '';

    // Dedup: skip if we already processed this message
    if (this.processedTs.has(ts)) return;
    this.processedTs.add(ts);
    // Prevent memory leak — clean old entries
    if (this.processedTs.size > 1000) {
      const entries = [...this.processedTs];
      for (let i = 0; i < 500; i++) this.processedTs.delete(entries[i]);
    }
    if (this.botThreads.size > 1000) {
      const entries = [...this.botThreads];
      for (let i = 0; i < 500; i++) this.botThreads.delete(entries[i]);
    }

    // Build JID
    const chatJid = `slack:${channelId}`;

    // Resolve sender name
    const senderName = await this.resolveUserName(userId);

    // Resolve channel/chat name
    let chatName: string;
    if (isDM) {
      chatName = senderName;
    } else {
      chatName = await this.resolveChannelName(channelId);
    }

    // Translate <@BOTID> mentions into trigger format
    if (this.botUserId) {
      const mentionRegex = new RegExp(`<@${this.botUserId}>`, 'g');
      const hasMention = mentionRegex.test(content);

      if (hasMention) {
        // Strip bot mention
        content = content.replace(mentionRegex, '').trim();
        // Prepend trigger if not already present
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }
    }

    // For DMs and bot-thread replies, always prepend trigger if not present
    const isThreadReply = !!event.thread_ts;
    const isBotThread = isThreadReply && this.botThreads.has(event.thread_ts!);
    if ((isDM || isBotThread) && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Handle file attachments
    if (event.files && event.files.length > 0) {
      const attachmentDescriptions = event.files.map((file) => {
        const mime = file.mimetype || '';
        const name = file.name || 'file';
        if (mime.startsWith('image/')) {
          return `[Image: ${name}]`;
        } else if (mime.startsWith('video/')) {
          return `[Video: ${name}]`;
        } else if (mime.startsWith('audio/')) {
          return `[Audio: ${name}]`;
        } else {
          return `[File: ${name}]`;
        }
      });
      if (content) {
        content = `${content}\n${attachmentDescriptions.join('\n')}`;
      } else {
        content = attachmentDescriptions.join('\n');
      }
    }

    const timestamp = new Date(parseFloat(ts) * 1000).toISOString();

    // Store chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'slack', !isDM);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Slack channel',
      );
      return;
    }

    // Track trigger message ts for thread replies
    this.lastTriggerTs.set(chatJid, ts);

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: ts,
      chat_jid: chatJid,
      sender: userId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Slack message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app) {
      logger.warn('Slack app not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^slack:/, '');
      const threadTs = this.lastTriggerTs.get(jid);

      // Slack has a ~4000 character limit per message — split if needed
      const MAX_LENGTH = 3900;
      const chunks: string[] = [];
      if (text.length <= MAX_LENGTH) {
        chunks.push(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          chunks.push(text.slice(i, i + MAX_LENGTH));
        }
      }

      for (const chunk of chunks) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: chunk,
          thread_ts: threadTs,
        });
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

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.app) return;
    const channelId = jid.replace(/^slack:/, '');
    const triggerTs = this.lastTriggerTs.get(jid);
    if (!triggerTs) return;

    try {
      if (isTyping) {
        await this.app.client.reactions.add({
          channel: channelId,
          timestamp: triggerTs,
          name: 'hourglass_flowing_sand',
        });
      } else {
        await this.app.client.reactions.remove({
          channel: channelId,
          timestamp: triggerTs,
          name: 'hourglass_flowing_sand',
        });
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update Slack typing reaction');
    }
  }

  private async resolveUserName(userId: string): Promise<string> {
    if (this.userNameCache.has(userId)) {
      return this.userNameCache.get(userId)!;
    }

    if (!this.app) return userId;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name =
        result.user?.profile?.display_name ||
        result.user?.real_name ||
        result.user?.name ||
        userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  private async resolveChannelName(channelId: string): Promise<string> {
    if (this.channelNameCache.has(channelId)) {
      return this.channelNameCache.get(channelId)!;
    }

    if (!this.app) return channelId;

    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      const name = (result.channel as any)?.name || channelId;
      const fullName = `#${name}`;
      this.channelNameCache.set(channelId, fullName);
      return fullName;
    } catch {
      return channelId;
    }
  }
}
