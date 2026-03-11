import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  REST,
  Routes,
  TextChannel,
  ThreadChannel,
} from 'discord.js';

import {
  ASSISTANT_NAME,
  buildTriggerPattern,
  escapeRegex,
  parseThreadJid,
  resolveAssistantName,
} from '../config.js';
import { downloadAttachment } from '../attachment-downloader.js';
import { getThreadOrigin, setThreadOrigin } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Attachment, Channel } from '../types.js';

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

      // Handle attachments — download files and add text placeholders
      const downloadedAttachments: Attachment[] = [];
      if (message.attachments.size > 0) {
        const attachmentDescriptions: string[] = [];
        const downloads = await Promise.all(
          [...message.attachments.values()].map(async (att) => {
            const contentType = att.contentType || '';
            const name = att.name || 'file';
            // Text placeholder (always added for context)
            if (contentType.startsWith('image/')) {
              attachmentDescriptions.push(`[Image: ${name}]`);
            } else if (contentType.startsWith('video/')) {
              attachmentDescriptions.push(`[Video: ${name}]`);
            } else if (contentType.startsWith('audio/')) {
              attachmentDescriptions.push(`[Audio: ${name}]`);
            } else {
              attachmentDescriptions.push(`[File: ${name}]`);
            }
            // Download for vision/document support (skips audio internally)
            if (att.url && group) {
              return downloadAttachment({
                messageId: msgId,
                groupFolder: group.folder,
                filename: name,
                mimeType: contentType,
                expectedSize: att.size,
                fetchFn: async () => {
                  const resp = await fetch(att.url);
                  if (!resp.ok)
                    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
                  return Buffer.from(await resp.arrayBuffer());
                },
              });
            }
            return null;
          }),
        );
        for (const dl of downloads) {
          if (dl) downloadedAttachments.push(dl);
        }
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
        attachments:
          downloadedAttachments.length > 0 ? downloadedAttachments : undefined,
      });

      logger.info(
        { chatJid, parentJid, chatName, sender: senderName, isInThread },
        'Discord message stored',
      );
    });

    // Handle button clicks and slash commands
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (interaction.isButton()) {
        if (interaction.customId.startsWith('deploy:')) {
          await this.handleDeployButton(interaction as ButtonInteraction);
        }
      } else if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'deploy') {
          await this.handleDeployCommand(
            interaction as ChatInputCommandInteraction,
          );
        }
      }
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        await this.registerSlashCommands(readyClient.user.id);
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
      const parsed = parseThreadJid(jid);
      const isThreadJid = !!parsed;
      // For thread JIDs, the channel to send to is the thread channel (threadId);
      // for top-level JIDs, strip the dc: prefix to get the channel ID.
      const channelId = parsed ? parsed.threadId : jid.replace(/^dc:/, '');

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
              logger.warn(
                { threadId, originalMsgId, jid, err },
                'Failed to persist thread origin to SQLite',
              );
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
      const components = this.buildDeployButton(text);
      await this.sendChunked(textChannel, text, components);
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
      const components = this.buildDeployButton(text);
      await this.sendChunked(thread, text, components);

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

  private static MAX_MESSAGE_LENGTH = 2000;
  private static PR_URL_RE =
    /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

  /** Build a Deploy button if the text contains a GitHub PR URL. */
  private buildDeployButton(
    text: string,
  ): ActionRowBuilder<ButtonBuilder>[] | undefined {
    const match = text.match(DiscordChannel.PR_URL_RE);
    if (!match) return undefined;
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`deploy:${match[0]}`)
          .setLabel('Deploy')
          .setStyle(ButtonStyle.Primary),
      ),
    ];
  }

  /** Send text in chunks respecting Discord's 2000 char limit. */
  private async sendChunked(
    target: {
      send(options: string | Record<string, unknown>): Promise<unknown>;
    },
    text: string,
    components?: ActionRowBuilder<ButtonBuilder>[],
  ): Promise<void> {
    const max = DiscordChannel.MAX_MESSAGE_LENGTH;
    if (text.length <= max) {
      if (components) {
        await target.send({ content: text, components });
      } else {
        await target.send(text);
      }
    } else {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += max) {
        chunks.push(text.slice(i, i + max));
      }
      for (let i = 0; i < chunks.length - 1; i++) {
        await target.send(chunks[i]);
      }
      // Attach button to the last chunk
      if (components) {
        await target.send({
          content: chunks[chunks.length - 1],
          components,
        });
      } else {
        await target.send(chunks[chunks.length - 1]);
      }
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  clearThreadState(parentJid: string, threadId?: string): void {
    if (threadId) {
      // Per-thread cleanup: only clear state for this specific thread
      const threadJid = `${parentJid}:thread:${threadId}`;
      this.lastUserMessageId.delete(threadJid);
    } else {
      // No thread specified: clear parent-level state and all thread entries
      this.createdThreadJid.delete(parentJid);
      this.lastUserMessageId.delete(parentJid);
    }
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

  private async registerSlashCommands(clientId: string): Promise<void> {
    try {
      const rest = new REST({ version: '10' }).setToken(this.botToken);
      await rest.put(Routes.applicationCommands(clientId), {
        body: [{ name: 'deploy', description: 'Deploy latest main branch' }],
      });
      logger.info('Discord slash commands registered');
    } catch (err) {
      logger.error({ err }, 'Failed to register Discord slash commands');
    }
  }

  private async handleDeployButton(
    interaction: ButtonInteraction,
  ): Promise<void> {
    const prUrl = interaction.customId.replace('deploy:', '');

    await interaction.deferReply();

    try {
      const { execSync } = await import('child_process');
      const result = execSync(`gh pr view "${prUrl}" --json state -q .state`, {
        encoding: 'utf-8',
        timeout: 15000,
      }).trim();

      if (result !== 'MERGED') {
        await interaction.editReply(
          `PR hasn't been merged yet (state: ${result})`,
        );
        return;
      }

      await interaction.editReply('PR is merged. Deploying latest main...');
      this.runDetachedDeploy();
    } catch (err) {
      logger.error({ err, prUrl }, 'Deploy button handler error');
      await interaction.editReply('Deploy failed — check logs').catch(() => {});
    }
  }

  private async handleDeployCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply('Deploying latest main...');
    this.runDetachedDeploy();
  }

  private runDetachedDeploy(): void {
    const scriptPath = path.resolve(process.cwd(), 'scripts/deploy.sh');
    const logPath = path.resolve(process.cwd(), 'logs/deploy.log');

    const logFd = fs.openSync(logPath, 'a');
    const child = spawn('bash', [scriptPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: process.cwd(),
    });
    child.unref();

    logger.info({ pid: child.pid }, 'Detached deploy script spawned');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!this.client || !isTyping) return;

    const parsedJid = parseThreadJid(jid);
    const channelId = parsedJid ? parsedJid.threadId : jid.replace(/^dc:/, '');
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
