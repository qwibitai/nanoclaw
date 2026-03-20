import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import {
  createThreadContext,
  getThreadContextByThreadId,
  getThreadContextByOriginMessage,
  updateThreadContext,
  touchThreadContext,
  ThreadContext,
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

/**
 * Find the best split point for a chunk of text within maxLength.
 * Prefers newline boundaries, then spaces, then hard cut. Avoids splitting UTF-16 surrogate pairs.
 */
function findSplitPoint(text: string, maxLength: number): number {
  if (text.length <= maxLength) return text.length;
  let splitAt = text.lastIndexOf('\n', maxLength);
  if (splitAt <= 0) splitAt = text.lastIndexOf(' ', maxLength);
  if (splitAt <= 0) splitAt = maxLength;
  // Don't split a UTF-16 surrogate pair
  const code = text.charCodeAt(splitAt - 1);
  if (code >= 0xd800 && code <= 0xdbff) splitAt--;
  return splitAt;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  // Pending triggers: chatJid → { message, contextId } for creating Discord thread on first response
  private pendingTrigger = new Map<
    string,
    { message: Message; contextId: number }
  >();
  // JIDs with an active user-triggered conversation (not persisted — clears on restart)
  private activeConversation = new Set<string>();
  // Current send target: `{jid}:{threadId}` → ThreadContext (set by index.ts before streaming)
  private currentSendTarget = new Map<string, ThreadContext>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  setCurrentThreadContext(
    jid: string,
    threadId: string,
    context: ThreadContext | null,
  ): void {
    const key = `${jid}:${threadId}`;
    if (context) {
      this.currentSendTarget.set(key, context);
    } else {
      this.currentSendTarget.delete(key);
    }
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
      try {
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

        // Fetch replied-to message early — used for trigger detection and reply context
        let repliedToMessage: Message | null = null;
        if (message.reference?.messageId) {
          try {
            repliedToMessage = await message.channel.messages.fetch(
              message.reference.messageId,
            );
          } catch {
            // Replied-to message may have been deleted
          }
        }

        // Replies in a bot-created thread are implicitly directed at the bot
        // Check by looking up whether this Discord thread has a thread context
        const isInBotThread =
          isThread && !!getThreadContextByThreadId(message.channelId);
        if (isInBotThread && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
          this.activeConversation.add(chatJid);
        }

        // Translate Discord @bot mentions into TRIGGER_PATTERN format.
        // Discord mentions look like <@botUserId> — these won't match
        // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
        // when the bot is @mentioned.
        let isBotMentioned = false;
        if (!isInBotThread && this.client?.user) {
          const botId = this.client.user.id;
          // Check for role mentions that reference the bot's managed role
          const botRoleId = message.guild?.members?.me?.roles?.botRole?.id;
          isBotMentioned =
            message.mentions.users.has(botId) ||
            content.includes(`<@${botId}>`) ||
            content.includes(`<@!${botId}>`) ||
            !!(botRoleId && content.includes(`<@&${botRoleId}>`));

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
            this.activeConversation.add(chatJid);
          }
        }

        // If already in bot thread and message explicitly mentions bot, ensure activeConversation is set
        if (isInBotThread && TRIGGER_PATTERN.test(content)) {
          this.activeConversation.add(chatJid);
        }

        // Direct reply to a bot message outside a thread — treat as directed at the bot
        if (
          !isInBotThread &&
          repliedToMessage &&
          this.client?.user &&
          repliedToMessage.author.id === this.client.user.id &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
          this.activeConversation.add(chatJid);
        }

        // --- Thread context tracking ---
        let threadContextId: number | undefined;

        if (isBotMentioned) {
          // New @mention → new thread context
          const ctx = createThreadContext({
            chatJid,
            threadId: null,
            sessionId: null,
            originMessageId: msgId,
            source: 'mention',
          });
          this.pendingTrigger.set(chatJid, { message, contextId: ctx.id });
          threadContextId = ctx.id;
        } else if (isInBotThread) {
          // Message in existing bot thread — look up by Discord thread channel ID
          const ctx = getThreadContextByThreadId(message.channelId);
          if (ctx) {
            touchThreadContext(ctx.id);
            threadContextId = ctx.id;
          }
        } else if (
          repliedToMessage &&
          repliedToMessage.author.id === this.client?.user?.id
        ) {
          // Reply to bot message in channel
          let ctx = getThreadContextByOriginMessage(repliedToMessage.id);
          if (!ctx) {
            ctx = createThreadContext({
              chatJid,
              threadId: null,
              sessionId: null,
              originMessageId: repliedToMessage.id,
              source: 'reply',
            });
          }
          this.pendingTrigger.set(chatJid, { message, contextId: ctx.id });
          threadContextId = ctx.id;
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
        if (repliedToMessage) {
          const replyAuthor =
            repliedToMessage.member?.displayName ||
            repliedToMessage.author.displayName ||
            repliedToMessage.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
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
          thread_context_id: threadContextId,
        });

        logger.info(
          { chatJid, chatName, sender: senderName },
          'Discord message stored',
        );
      } catch (err) {
        logger.error(
          { err, messageId: message.id },
          'Unhandled error in Discord message handler',
        );
      }
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
    while (text.length > 0) {
      const splitAt = findSplitPoint(text, MAX_LENGTH);
      await target.send(text.slice(0, splitAt));
      text = text.slice(splitAt).replace(/^\n/, '');
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

      // Step 1: If there's a pending trigger → create a new thread
      const triggerInfo = this.pendingTrigger.get(jid);
      if (triggerInfo) {
        this.pendingTrigger.delete(jid);
        try {
          const thread = await triggerInfo.message.startThread({
            name: text.slice(0, 100).replace(/\n/g, ' ') || 'Response',
          });
          // Update the thread context with the actual Discord thread ID
          updateThreadContext(triggerInfo.contextId, { threadId: thread.id });
          // Update in-memory send target so subsequent streaming outputs go to this thread
          for (const [key, ctx] of this.currentSendTarget) {
            if (key.startsWith(`${jid}:`)) {
              ctx.thread_id = thread.id;
              break;
            }
          }
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
          // Fall through to channel send
        }
      }

      // Step 2: If there's a currentSendTarget for this jid → send to that thread
      for (const [key, ctx] of this.currentSendTarget) {
        if (key.startsWith(`${jid}:`)) {
          if (ctx.thread_id) {
            try {
              const thread = await textChannel.threads.fetch(ctx.thread_id);
              if (thread) {
                await this.sendChunked(thread, text);
                logger.info(
                  { jid, threadId: ctx.thread_id, length: text.length },
                  'Discord message sent to existing thread',
                );
                return;
              }
            } catch {
              // Thread deleted, fall through
            }
          }
          break;
        }
      }

      // Step 3: No trigger context (scheduled task, IPC, etc.) — send to main channel
      await this.sendChunked(textChannel, text);
      // Clear conversation flag so future scheduled tasks go to main channel, not stale threads
      this.activeConversation.delete(jid);
      logger.info(
        { jid, length: text.length },
        'Discord message sent to channel',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  async sendChannelMessage(
    jid: string,
    text: string,
  ): Promise<string | undefined> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return undefined;
    }
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return undefined;
      }
      const textChannel = channel as TextChannel;
      // Send first chunk directly to capture the message ID
      const splitAt = findSplitPoint(text, 2000);
      const firstChunk = text.slice(0, splitAt);
      const sentMessage = await textChannel.send(firstChunk);
      // Send remaining chunks
      const remaining = text.slice(splitAt).replace(/^\n/, '');
      if (remaining) {
        await this.sendChunked(textChannel, remaining);
      }
      logger.info(
        { jid, length: text.length },
        'Discord scheduled message sent to channel',
      );
      return sentMessage.id;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord channel message');
      return undefined;
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

      // Send to active thread from currentSendTarget if one exists, otherwise to channel
      let target: { send: (options: object) => Promise<unknown> } = textChannel;
      for (const [key, ctx] of this.currentSendTarget) {
        if (key.startsWith(`${jid}:`)) {
          if (ctx.thread_id) {
            try {
              const thread = await textChannel.threads.fetch(ctx.thread_id);
              if (thread) target = thread;
            } catch {
              // Thread deleted, fall through to channel
            }
          }
          break;
        }
      }

      await target.send({
        content: caption || undefined,
        files: files.map((f) => ({ attachment: f.path, name: f.name })),
      });

      logger.info({ jid, fileCount: files.length }, 'Discord files sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord file');
    }
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
