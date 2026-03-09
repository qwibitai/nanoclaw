import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
} from 'discord.js';

import {
  ASSISTANT_NAME,
  buildTriggerPattern,
  escapeRegex,
  resolveAssistantName,
} from '../config.js';
import { getThreadOrigin, setThreadOrigin } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: ChannelOpts;
  private botToken: string;
  private memberCacheTime = new Map<string, number>();
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  // ── Discord thread state maps ──────────────────────────────────
  //
  // lastUserMessageId: TRANSIENT. Tracks the user message to create a
  //   thread from on first reply. Lives seconds between message receipt
  //   and first response. Lost on restart = harmless (no thread created,
  //   response goes to channel instead).
  //
  // createdThreadJid: TRANSIENT. Redirects subsequent sends for a parent
  //   JID to the thread during a single container run. Not needed after
  //   restart — thread replies arrive with thread JIDs directly.
  //
  // threadOriginMessage: PERSISTED (SQLite-backed with in-memory cache).
  //   Maps threadChannelId → originalMsgId so thread replies resolve to
  //   the same session as the top-level message. Critical for session
  //   continuity across restarts — without it, Discord thread replies
  //   after restart create orphaned sessions.
  // ─────────────────────────────────────────────────────────────────
  private lastUserMessageId = new Map<string, string>();
  private createdThreadJid = new Map<string, string>();
  private threadOriginMessage = new Map<string, string>();
  private static MEMBER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(botToken: string, opts: ChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Thread detection: if the message is in a thread, use the parent channel
      // for group lookup and encode the thread in the JID.
      // Use the original message ID (not thread channel ID) as the thread
      // identifier so the session matches the top-level invocation.
      let chatJid: string;
      let isInThread = false;
      if (message.channel.isThread() && message.channel.parentId) {
        // Read-through: check in-memory cache first, then SQLite
        let originMsgId = this.threadOriginMessage.get(channelId);
        if (!originMsgId) {
          const dbRow = getThreadOrigin(channelId);
          if (dbRow) {
            originMsgId = dbRow.origin_message_id;
            this.threadOriginMessage.set(channelId, originMsgId); // cache
          }
        }
        const effectiveOrigin = originMsgId || channelId; // fallback for pre-migration threads
        chatJid = `dc:${message.channel.parentId}:thread:${effectiveOrigin}`;
        isInThread = true;
      } else {
        chatJid = `dc:${channelId}`;
      }

      // Parent JID for group lookup (threads resolve to their parent channel)
      const parentJid = isInThread
        ? `dc:${(message.channel as ThreadChannel).parentId}`
        : chatJid;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        if (isInThread) {
          const parentChannel = message.channel.isThread()
            ? ((message.channel as ThreadChannel).parent as TextChannel | null)
            : null;
          chatName = `${message.guild.name} #${parentChannel?.name ?? channelId}`;
        } else {
          const textChannel = message.channel as TextChannel;
          chatName = `${message.guild.name} #${textChannel.name}`;
        }
      } else {
        chatName = senderName;
      }

      // Resolve per-group assistant name using parent JID (threads inherit parent config)
      const group = this.opts.registeredGroups()[parentJid];
      const assistantName = resolveAssistantName(group?.containerConfig);
      const triggerPattern = buildTriggerPattern(assistantName);

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Axie\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!triggerPattern.test(content)) {
            content = `@${assistantName} ${content}`;
          }
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

      // Handle reply context — include who the user is replying to.
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

      // Always trigger on Discord messages — no @mention needed.
      if (!triggerPattern.test(content)) {
        content = `@${assistantName} ${content}`;
      }

      // Store chat metadata for discovery (always use parent JID)
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        parentJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      if (!group) {
        logger.debug(
          { chatJid: parentJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Track user message ID for thread creation (top-level messages only)
      if (!isInThread) {
        this.lastUserMessageId.set(parentJid, msgId);
        // Clear any stale thread redirect from a previous conversation
        this.createdThreadJid.delete(parentJid);
      }

      // Store messages with the most specific JID:
      // - Thread messages use thread JID for session isolation
      // - Top-level messages use parent JID (thread created on first reply)
      const storeJid = isInThread ? chatJid : parentJid;
      this.opts.onMessage(storeJid, {
        id: msgId,
        chat_jid: storeJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, parentJid, chatName, sender: senderName, isInThread },
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

  /**
   * Convert @Name mentions in outbound text to Discord <@USER_ID> format.
   * Uses the guild member cache from the target channel.
   */
  private async replaceMentions(
    text: string,
    channel: TextChannel,
  ): Promise<string> {
    if (!channel.guild) return text;
    try {
      // Fetch guild members with TTL cache to avoid API call on every outbound message
      const guildId = channel.guild.id;
      const lastFetch = this.memberCacheTime.get(guildId) || 0;
      if (Date.now() - lastFetch > DiscordChannel.MEMBER_CACHE_TTL) {
        await channel.guild.members.fetch();
        this.memberCacheTime.set(guildId, Date.now());
      }
      const members = channel.guild.members.cache;
      // Build name→id map, longest names first to avoid partial matches
      const nameMap: Array<[string, string]> = [];
      for (const [, member] of members) {
        if (member.user.bot) continue;
        nameMap.push([member.displayName.toLowerCase(), member.id]);
        if (
          member.user.username.toLowerCase() !==
          member.displayName.toLowerCase()
        ) {
          nameMap.push([member.user.username.toLowerCase(), member.id]);
        }
        if (
          member.user.globalName &&
          member.user.globalName.toLowerCase() !==
            member.displayName.toLowerCase()
        ) {
          nameMap.push([member.user.globalName.toLowerCase(), member.id]);
        }
      }
      nameMap.sort((a, b) => b[0].length - a[0].length);
      let result = text;
      for (const [name, userId] of nameMap) {
        const pattern = new RegExp(`@${escapeRegex(name)}\\b`, 'gi');
        result = result.replace(pattern, `<@${userId}>`);
      }
      return result;
    } catch (err) {
      logger.debug({ err }, 'Failed to resolve Discord mentions');
      return text;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      // If we already created a thread for this parent JID, redirect there
      const redirectJid = this.createdThreadJid.get(jid);
      if (redirectJid) {
        return this.sendMessage(redirectJid, text);
      }

      // Parse JID: dc:{channelId} or dc:{parentId}:thread:{threadId}
      const threadMatch = jid.match(/^dc:([^:]+):thread:(.+)$/);
      const isThreadJid = !!threadMatch;
      const channelId = threadMatch ? threadMatch[2] : jid.replace(/^dc:/, '');

      // Thread creation: for top-level JIDs, create a thread from the
      // user's triggering message on first response.
      if (!isThreadJid) {
        const originalMsgId = this.lastUserMessageId.get(jid);
        if (originalMsgId) {
          this.lastUserMessageId.delete(jid);
          const threadId = await this.createThreadAndSend(
            channelId,
            originalMsgId,
            text,
          );
          if (threadId) {
            // Redirect future sends for this parent JID to the thread
            const threadJid = `dc:${channelId}:thread:${threadId}`;
            this.createdThreadJid.set(jid, threadJid);
            // Map threadChannelId → originalMsgId so thread replies
            // resolve to the same session as the top-level message.
            // Write-through: persist to SQLite for restart survival.
            this.threadOriginMessage.set(threadId, originalMsgId);
            try {
              setThreadOrigin(threadId, originalMsgId, jid);
            } catch (err) {
              logger.warn({ threadId, originalMsgId, jid, err }, 'Failed to persist thread origin to SQLite');
            }
            return;
          }
          // Fallback: createThreadAndSend already sent to channel on failure
          return;
        }
      }

      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;
      text = await this.replaceMentions(text, textChannel);

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  /**
   * Create a Discord thread from a message and send the response there.
   * Returns the thread's channel ID, or null if thread creation failed.
   */
  async createThreadAndSend(
    parentChannelId: string,
    originalMessageId: string,
    text: string,
    threadName?: string,
  ): Promise<string | null> {
    if (!this.client) return null;

    try {
      const channel = await this.client.channels.fetch(parentChannelId);
      if (!channel || !('messages' in channel)) return null;

      const textChannel = channel as TextChannel;
      const originalMessage =
        await textChannel.messages.fetch(originalMessageId);

      // Generate thread name from the user's message (first ~40 chars)
      const name =
        threadName ||
        originalMessage.content
          .replace(/@\w+\s*/g, '')
          .trim()
          .slice(0, 40) ||
        'Thread';

      const thread = await originalMessage.startThread({
        name,
        autoArchiveDuration: 1440, // 24h
      });

      text = await this.replaceMentions(text, textChannel);
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await thread.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await thread.send(text.slice(i, i + MAX_LENGTH));
        }
      }

      logger.info(
        { parentChannelId, threadId: thread.id, threadName: name },
        'Discord thread created',
      );
      return thread.id;
    } catch (err) {
      logger.error(
        { parentChannelId, originalMessageId, err },
        'Failed to create Discord thread, falling back to channel',
      );
      // Fallback: send directly in channel
      await this.sendMessage(`dc:${parentChannelId}`, text);
      return null;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  clearThreadState(parentJid: string): void {
    this.createdThreadJid.delete(parentJid);
    this.lastUserMessageId.delete(parentJid);
  }

  async disconnect(): Promise<void> {
    for (const interval of this.typingIntervals.values())
      clearInterval(interval);
    this.typingIntervals.clear();
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!this.client || !isTyping) return;

    // Parse thread JID format
    const threadMatch = jid.match(/^dc:([^:]+):thread:(.+)$/);
    const channelId = threadMatch ? threadMatch[2] : jid.replace(/^dc:/, '');
    const sendTyping = async () => {
      try {
        const channel = await this.client!.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    await sendTyping();
    this.typingIntervals.set(jid, setInterval(sendTyping, 8000));
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
