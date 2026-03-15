import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import {
  deleteActiveThread,
  getAllActiveThreads,
  getActiveThread,
  setActiveThread,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  FileAttachment,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  // Track the triggering @mention message per channel so responses go into a thread
  private pendingTrigger = new Map<string, Message>();
  // Track active thread per channel — persisted in DB, cached in memory
  private activeThread = new Map<string, string>();
  private activeThreadLoaded = false;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private ensureThreadsLoaded(): void {
    if (!this.activeThreadLoaded) {
      this.activeThread = getAllActiveThreads();
      this.activeThreadLoaded = true;
    }
  }

  private setThread(chatJid: string, threadId: string): void {
    this.ensureThreadsLoaded();
    this.activeThread.set(chatJid, threadId);
    setActiveThread(chatJid, threadId);
  }

  private deleteThread(chatJid: string): void {
    this.ensureThreadsLoaded();
    this.activeThread.delete(chatJid);
    deleteActiveThread(chatJid);
  }

  private getThread(chatJid: string): string | undefined {
    this.ensureThreadsLoaded();
    return this.activeThread.get(chatJid);
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      // Map thread messages back to parent channel so they route to the correct group
      const isThread = message.channel.isThread();
      const channelId =
        isThread && message.channel.parentId
          ? message.channel.parentId
          : message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Replies in a bot-created thread are implicitly directed at the bot
      const isInBotThread =
        isThread && this.getThread(chatJid) === message.channelId;
      if (isInBotThread && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (!isInBotThread && this.client?.user) {
        const botId = this.client.user.id;
        // Check for role mentions that reference the bot's managed role
        const botRoleId = message.guild?.members?.me?.roles?.botRole?.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`) ||
          (botRoleId && content.includes(`<@&${botRoleId}>`));

        if (isBotMentioned) {
          // Strip the <@botId> or <@&roleId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .replace(
              botRoleId ? new RegExp(`<@&${botRoleId}>`, 'g') : /(?!)/g,
              '',
            )
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
          // Store this message so the response is sent as a thread
          this.pendingTrigger.set(chatJid, message);
          this.deleteThread(chatJid);
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
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
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  private async sendChunked(
    target: { send: (text: string) => Promise<unknown> },
    text: string,
  ): Promise<void> {
    const MAX_LENGTH = 2000;
    if (text.length <= MAX_LENGTH) {
      await target.send(text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await target.send(text.slice(i, i + MAX_LENGTH));
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;
      const triggerMsg = this.pendingTrigger.get(jid);
      const existingThreadId = this.getThread(jid);

      if (existingThreadId) {
        // Streaming continuation — send to the already-created thread
        try {
          const thread = await textChannel.threads.fetch(existingThreadId);
          if (thread) {
            await this.sendChunked(thread, text);
            logger.info(
              { jid, threadId: existingThreadId, length: text.length },
              'Discord message sent to existing thread',
            );
            return;
          }
        } catch {
          // Thread may have been deleted; fall through to create new one or send to channel
          this.deleteThread(jid);
        }
      }

      if (triggerMsg) {
        // Create a new thread on the triggering @mention message
        this.pendingTrigger.delete(jid);
        try {
          const thread = await triggerMsg.startThread({
            name: text.slice(0, 100).replace(/\n/g, ' ') || 'Response',
          });
          this.setThread(jid, thread.id);
          await this.sendChunked(thread, text);
          logger.info(
            { jid, threadId: thread.id, length: text.length },
            'Discord message sent to new thread',
          );
          return;
        } catch (err) {
          logger.warn(
            { jid, err },
            'Failed to create thread, falling back to channel',
          );
        }
      }

      // No trigger context (scheduled task, IPC, etc.) — send to main channel
      await this.sendChunked(textChannel, text);
      logger.info(
        { jid, length: text.length },
        'Discord message sent to channel',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async sendFile(
    jid: string,
    files: FileAttachment[],
    caption?: string,
  ): Promise<void> {
    if (!this.client) throw new Error('Discord client not connected');

    const channelId = jid.replace(/^dc:/, '');
    const channel = await this.client.channels.fetch(channelId);

    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Discord channel not found or not text-based');
      return;
    }

    const textChannel = channel as TextChannel;

    // Send to active thread if one exists, otherwise to channel
    const threadId = this.getThread(jid);
    let target: { send: (options: object) => Promise<unknown> } = textChannel;
    if (threadId) {
      try {
        const thread = await textChannel.threads.fetch(threadId);
        if (thread) target = thread;
      } catch {
        // Thread deleted, fall through to channel
      }
    }

    await target.send({
      content: caption || undefined,
      files: files.map((f) => ({ attachment: f.path, name: f.name })),
    });

    logger.info(
      { jid, fileCount: files.length },
      'Discord files sent',
    );
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
