import { exec, spawn } from 'child_process';
import { promisify } from 'util';
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
  Webhook,
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
import { transformTablesInText } from '../table-renderer.js';

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: ChannelOpts;
  private botToken: string;
  private memberCacheTime = new Map<string, number>();
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  // ── Discord thread state maps ──────────────────────────────────
  //
  // pendingTopLevelMsgIds: TRANSIENT. FIFO queue of top-level message IDs
  //   per parent channel JID, awaiting thread creation on first reply.
  //   Using a queue (not last-in-wins) prevents a fast second message from
  //   overwriting the first — each response pops the correct trigger ID.
  //   Lost on restart = harmless (no thread created, response goes to channel).
  //
  // createdThreadJid: TRANSIENT. Redirects subsequent sends for a
  //   conversation to the thread. Keyed by "parentJid:triggerMsgId" so
  //   concurrent conversations on the same channel each get their own thread.
  //   Falls back to plain "parentJid" key when no triggerMessageId is provided
  //   (e.g. session command responses).
  //
  // threadOriginMessage: PERSISTED (SQLite-backed with in-memory cache).
  //   Maps threadChannelId → originalMsgId so thread replies resolve to
  //   the same session as the top-level message. Critical for session
  //   continuity across restarts — without it, Discord thread replies
  //   after restart create orphaned sessions.
  // ─────────────────────────────────────────────────────────────────
  private pendingTopLevelMsgIds = new Map<string, string[]>();
  private createdThreadJid = new Map<string, string>();
  private threadOriginMessage = new Map<string, string>();
  private webhookCache = new Map<string, Webhook>();
  private webhookCreating = new Map<string, Promise<Webhook | null>>();
  private pendingThreadTitleValue: string | undefined;
  private static MEMBER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /** Called by index.ts before sendMessage to pass an agent-generated thread title. */
  setPendingThreadTitle(title: string): void {
    this.pendingThreadTitleValue = title;
  }

  /** Resolve the parent channel ID from an interaction (thread → parent, else null). */
  private static getInteractionParentId(interaction: {
    channel: { isThread(): boolean; parentId?: string | null } | null;
  }): string | null {
    const ch = interaction.channel;
    return ch?.isThread() ? (ch.parentId ?? null) : null;
  }

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

      // Queue message ID for thread creation (top-level messages only).
      // Using a FIFO queue prevents a rapid second message from overwriting
      // the first: each response will pop the correct trigger message ID.
      if (!isInThread) {
        const queue = this.pendingTopLevelMsgIds.get(parentJid) ?? [];
        queue.push(msgId);
        this.pendingTopLevelMsgIds.set(parentJid, queue);
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

    // Handle button clicks and slash commands (restricted to #nanoclaw-dev)
    const deployChannelId = '1480411210183610418';
    this.client.on(Events.InteractionCreate, async (interaction) => {
      // Allow interactions from the deploy channel itself OR from threads under it
      const parentId = DiscordChannel.getInteractionParentId(interaction);
      if (
        interaction.channelId !== deployChannelId &&
        parentId !== deployChannelId
      )
        return;
      try {
        if (interaction.isButton()) {
          const btn = interaction as ButtonInteraction;
          if (btn.customId.startsWith('review-merge:')) {
            await this.handleReviewMergeButton(btn);
          } else if (btn.customId.startsWith('simplify-merge:')) {
            await this.handleSimplifyMergeButton(btn);
          } else if (btn.customId.startsWith('merge:')) {
            await this.handleMergeButton(btn);
          }
        } else if (interaction.isChatInputCommand()) {
          if (interaction.commandName === 'deploy') {
            await this.handleDeployCommand(
              interaction as ChatInputCommandInteraction,
            );
          }
        }
      } catch (err) {
        logger.error({ err }, 'Discord interaction handler error');
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
        const guild = readyClient.guilds.cache.first();
        if (guild) {
          await this.registerSlashCommands(readyClient.user.id, guild.id);
        }
        await this.announceDeployStatus(deployChannelId);
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

  async sendMessage(
    jid: string,
    text: string,
    triggerMessageId?: string,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      // Conversation key: per-conversation when triggerMessageId is known,
      // per-channel fallback for session commands that don't supply it.
      const convKey = triggerMessageId ? `${jid}:${triggerMessageId}` : jid;

      // If we already created a thread for this conversation, redirect there.
      const redirectJid = this.createdThreadJid.get(convKey);
      if (redirectJid) {
        return this.sendMessage(redirectJid, text, triggerMessageId);
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
        // Prefer the explicit triggerMessageId supplied by the caller (index.ts
        // passes effectiveThreadId so each conversation threads correctly even
        // when two messages arrive before the first response is sent).
        // Fall back to the FIFO queue for session commands that don't supply one.
        let originalMsgId: string | undefined = triggerMessageId;
        if (!originalMsgId) {
          const queue = this.pendingTopLevelMsgIds.get(jid);
          if (queue && queue.length > 0) {
            originalMsgId = queue.shift();
            if (queue.length === 0) {
              this.pendingTopLevelMsgIds.delete(jid);
            }
          }
        }
        if (originalMsgId) {
          const threadId = await this.createThreadAndSend(
            channelId,
            originalMsgId,
            text,
          );
          if (threadId) {
            // Redirect future sends for this conversation to the thread.
            const threadJid = `dc:${channelId}:thread:${threadId}`;
            this.createdThreadJid.set(convKey, threadJid);
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
      ({ text } = transformTablesInText('discord', text));
      const components = this.buildPrButtons(text);
      await this.sendChunked(textChannel, text, components);
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  /**
   * Get or create a webhook for swarm messaging on a channel.
   * Reuses existing "NanoClaw Swarm" webhooks owned by our bot.
   * Deduplicates concurrent calls via in-flight promise map.
   */
  private async getOrCreateWebhook(channelId: string): Promise<Webhook | null> {
    const cached = this.webhookCache.get(channelId);
    if (cached) return cached;

    // Deduplicate concurrent creation attempts for the same channel
    let inflight = this.webhookCreating.get(channelId);
    if (inflight) return inflight;

    inflight = this.doGetOrCreateWebhook(channelId);
    this.webhookCreating.set(channelId, inflight);
    inflight.finally(() => this.webhookCreating.delete(channelId));
    return inflight;
  }

  private async doGetOrCreateWebhook(
    channelId: string,
  ): Promise<Webhook | null> {
    if (!this.client) return null;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('fetchWebhooks' in channel)) return null;

      const textChannel = channel as TextChannel;
      const existing = await textChannel.fetchWebhooks();
      let webhook = existing.find(
        (w) =>
          w.name === 'NanoClaw Swarm' && w.owner?.id === this.client!.user?.id,
      );

      if (!webhook) {
        webhook = await textChannel.createWebhook({
          name: 'NanoClaw Swarm',
          reason: 'Agent swarm identity support',
        });
      }

      this.webhookCache.set(channelId, webhook);
      return webhook;
    } catch (err) {
      logger.warn({ channelId, err }, 'Failed to get/create webhook for swarm');
      return null;
    }
  }

  /**
   * Send a message via webhook with a custom username (agent swarm).
   * Falls back to prefixed sendMessage if webhook is unavailable.
   */
  async sendSwarmMessage(
    jid: string,
    text: string,
    sender: string,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    // Preserve original text for fallback (sendMessage re-applies transforms)
    const originalText = text;

    try {
      // Check for thread redirect — the lead agent's sendMessage may have
      // already created a thread for this channel. Redirect swarm messages
      // into that thread so they don't land as top-level channel messages.
      const parsed = parseThreadJid(jid);
      if (!parsed) {
        for (const [key, threadJid] of this.createdThreadJid) {
          if (key === jid || key.startsWith(`${jid}:`)) {
            return this.sendSwarmMessage(threadJid, text, sender);
          }
        }
      }

      const parentChannelId = parsed
        ? parsed.parentId
        : jid.replace(/^dc:/, '');
      const threadChannelId = parsed ? parsed.threadId : undefined;

      const webhook = await this.getOrCreateWebhook(parentChannelId);
      if (!webhook) {
        return this.sendMessage(jid, `**[${sender}]** ${originalText}`);
      }

      // Apply text transforms
      const channel = await this.client.channels.fetch(parentChannelId);
      if (channel && 'guild' in channel) {
        text = await this.replaceMentions(text, channel as TextChannel);
      }
      ({ text } = transformTablesInText('discord', text));

      const baseOptions: Record<string, unknown> = {
        username: sender,
        ...(threadChannelId ? { threadId: threadChannelId } : {}),
      };

      const max = DiscordChannel.MAX_MESSAGE_LENGTH;
      if (text.length <= max) {
        await webhook.send({ ...baseOptions, content: text });
      } else {
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > max) {
          const split = DiscordChannel.splitAtBoundary(remaining, max);
          chunks.push(remaining.slice(0, split).trimEnd());
          remaining = remaining.slice(split).trimStart();
        }
        if (remaining.length > 0) chunks.push(remaining);

        for (const chunk of chunks) {
          await webhook.send({ ...baseOptions, content: chunk });
        }
      }

      logger.info(
        { jid, sender, length: text.length },
        'Discord swarm message sent',
      );
    } catch (err) {
      // Evict stale webhook from cache
      const errCode = (err as { code?: number | string })?.code;
      if (errCode === 10015 || errCode === 'Unknown Webhook') {
        const parsed = parseThreadJid(jid);
        const parentChannelId = parsed
          ? parsed.parentId
          : jid.replace(/^dc:/, '');
        this.webhookCache.delete(parentChannelId);
      }
      logger.error(
        { jid, sender, err },
        'Failed to send Discord swarm message',
      );
      try {
        await this.sendMessage(jid, `**[${sender}]** ${originalText}`);
      } catch {
        // Already logged in sendMessage
      }
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

      // Use agent-generated title (set via setPendingThreadTitle) if available
      const agentTitle = this.pendingThreadTitleValue;
      this.pendingThreadTitleValue = undefined;

      const fallbackName =
        threadName ||
        originalMessage.content
          .replace(/@\w+\s*/g, '')
          .trim()
          .slice(0, 40) ||
        'Thread';
      const name = agentTitle || fallbackName;

      const thread = await originalMessage.startThread({
        name,
        autoArchiveDuration: 1440, // 24h
      });

      text = await this.replaceMentions(text, textChannel);
      ({ text } = transformTablesInText('discord', text));
      const components = this.buildPrButtons(text);
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

  /** Build Review & Merge / Merge buttons if the text contains a GitHub PR URL. */
  private buildPrButtons(
    text: string,
  ): ActionRowBuilder<ButtonBuilder>[] | undefined {
    const match = text.match(DiscordChannel.PR_URL_RE);
    if (!match) return undefined;
    // Discord customId max is 100 chars; "review-merge:" prefix is 13 chars
    if (match[0].length > 87) return undefined;
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`review-merge:${match[0]}`)
          .setLabel('Review & Merge')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`simplify-merge:${match[0]}`)
          .setLabel('Simplify & Merge')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`merge:${match[0]}`)
          .setLabel('Merge')
          .setStyle(ButtonStyle.Secondary),
      ),
    ];
  }

  /** Split text at a clean boundary at or before maxLen. */
  private static splitAtBoundary(text: string, maxLen: number): number {
    if (text.length <= maxLen) return text.length;
    const slice = text.slice(0, maxLen);
    // Prefer paragraph break
    let idx = slice.lastIndexOf('\n\n');
    if (idx > 0) return idx + 2;
    // Line break
    idx = slice.lastIndexOf('\n');
    if (idx > 0) return idx + 1;
    // Sentence ending
    for (const sep of ['. ', '! ', '? ']) {
      idx = slice.lastIndexOf(sep);
      if (idx > 0) return idx + sep.length;
    }
    // Word boundary
    idx = slice.lastIndexOf(' ');
    if (idx > 0) return idx + 1;
    // Hard cut fallback
    return maxLen;
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
      let remaining = text;
      while (remaining.length > max) {
        const split = DiscordChannel.splitAtBoundary(remaining, max);
        chunks.push(remaining.slice(0, split).trimEnd());
        remaining = remaining.slice(split).trimStart();
      }
      if (remaining.length > 0) chunks.push(remaining);
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
      // Per-conversation cleanup: clear the keyed redirect for this trigger message.
      const convKey = `${parentJid}:${threadId}`;
      this.createdThreadJid.delete(convKey);
    } else {
      // Full cleanup: remove all redirects whose key starts with this parent JID.
      for (const key of this.createdThreadJid.keys()) {
        if (key === parentJid || key.startsWith(`${parentJid}:`)) {
          this.createdThreadJid.delete(key);
        }
      }
      this.pendingTopLevelMsgIds.delete(parentJid);
    }
  }

  async disconnect(): Promise<void> {
    for (const interval of this.typingIntervals.values())
      clearInterval(interval);
    this.typingIntervals.clear();
    this.webhookCache.clear();
    this.webhookCreating.clear();
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  private async registerSlashCommands(
    clientId: string,
    guildId: string,
  ): Promise<void> {
    try {
      const rest = new REST({ version: '10' }).setToken(this.botToken);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: [
          {
            name: 'deploy',
            description: 'Pull, build, and restart NanoClaw from latest main',
          },
        ],
      });
      logger.info('Discord slash commands registered (guild-only)');
    } catch (err) {
      logger.error({ err }, 'Failed to register Discord slash commands');
    }
  }

  /** Review & Merge: inject a message that triggers /review-swarm + /simplify + merge. */
  private async handleReviewMergeButton(
    interaction: ButtonInteraction,
  ): Promise<void> {
    const prUrl = interaction.customId.replace('review-merge:', '');
    await interaction.deferReply();

    const prompt =
      `Review and merge ${prUrl}:\n` +
      `1. Run /review-swarm on the PR diff — fix any critical findings\n` +
      `2. Run /simplify on changed files — fix any code quality issues\n` +
      `3. If both pass clean, merge with \`gh pr merge ${prUrl} --squash --delete-branch\``;

    this.injectMessage(interaction, prompt);
    await interaction.editReply('Starting review pipeline...');
  }

  /** Simplify & Merge: run /simplify then merge (no review swarm). */
  private async handleSimplifyMergeButton(
    interaction: ButtonInteraction,
  ): Promise<void> {
    const prUrl = interaction.customId.replace('simplify-merge:', '');
    await interaction.deferReply();

    const prompt =
      `Simplify and merge ${prUrl}:\n` +
      `1. Run /simplify on the PR changed files — fix any code quality issues\n` +
      `2. If clean, merge with \`gh pr merge ${prUrl} --squash --delete-branch\``;

    this.injectMessage(interaction, prompt);
    await interaction.editReply('Starting simplify pipeline...');
  }

  /** Merge: merge the PR directly via gh CLI. */
  private async handleMergeButton(
    interaction: ButtonInteraction,
  ): Promise<void> {
    const prUrl = interaction.customId.replace('merge:', '');
    await interaction.deferReply();

    try {
      const execAsync = promisify(exec);
      const { stdout } = await execAsync(
        `gh pr merge "${prUrl}" --squash --delete-branch`,
        { encoding: 'utf-8', timeout: 30000 },
      );

      await interaction.editReply(stdout.trim() || 'PR merged.');
    } catch (err) {
      logger.error({ err, prUrl }, 'Merge button handler error');
      const msg =
        err instanceof Error ? err.message.split('\n')[0] : 'Unknown error';
      await interaction.editReply(`Merge failed: ${msg}`).catch(() => {});
    }
  }

  /** Inject a synthetic message into the inbound pipeline for the agent to process. */
  private injectMessage(interaction: ButtonInteraction, prompt: string): void {
    // Resolve JID: if in a thread, use parent channel for group lookup
    const parentId = DiscordChannel.getInteractionParentId(interaction);
    const jid = parentId ? `dc:${parentId}` : `dc:${interaction.channelId}`;
    const msgId = interaction.id;
    const sender = interaction.user.id;
    const senderName = interaction.user.username;

    this.opts.onMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content: prompt,
      timestamp: new Date().toISOString(),
      is_from_me: false,
    });
  }

  private async handleDeployCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply('Deploying latest main...');
    this.runDetachedDeploy(interaction);
  }

  private runDetachedDeploy(interaction: ChatInputCommandInteraction): void {
    const scriptPath = path.resolve(process.cwd(), 'scripts/deploy.sh');
    const logPath = path.resolve(process.cwd(), 'logs/deploy.log');
    const statusPath = path.resolve(process.cwd(), 'logs/deploy-status.json');

    const logFd = fs.openSync(logPath, 'a');
    const child = spawn('bash', [scriptPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: process.cwd(),
    });
    child.unref();
    fs.closeSync(logFd); // Parent's copy — child inherited its own fd

    logger.info({ pid: child.pid }, 'Detached deploy script spawned');

    // Poll for failure status — if deploy fails before restart, the status
    // file is written but announceDeployStatus (which runs on startup) never
    // fires. We poll here to catch pre-restart failures and report them.
    const startTime = Date.now();
    const stopPolling = () => {
      clearInterval(poll);
      clearTimeout(guard);
    };
    const poll = setInterval(async () => {
      try {
        if (!fs.existsSync(statusPath)) return;
        const stat = fs.statSync(statusPath);
        if (stat.mtimeMs < startTime) return; // stale file from prior deploy

        const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
        if (status.status === 'failed') {
          stopPolling();
          await interaction.followUp(
            `Deploy failed at **${status.step}**: ${status.error}`,
          );
          fs.unlinkSync(statusPath);
        } else if (status.status === 'ok') {
          // Success — announceDeployStatus will handle it after restart
          stopPolling();
        }
      } catch {
        // File mid-write or gone — retry next tick
      }
    }, 2_000);

    // Stop polling after 2 minutes regardless
    const guard = setTimeout(stopPolling, 120_000);
  }

  private async announceDeployStatus(channelId: string): Promise<void> {
    try {
      const statusPath = path.resolve(process.cwd(), 'logs/deploy-status.json');
      if (!fs.existsSync(statusPath)) return;

      const stat = fs.statSync(statusPath);
      // Only announce if status file was written in the last 5 min (covers slow restarts)
      if (Date.now() - stat.mtimeMs > 300_000) return;

      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      const channel = await this.client!.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return;

      const textChannel = channel as TextChannel;
      if (status.status === 'ok') {
        await textChannel.send('Deploy complete — service is up.');
      } else if (status.status === 'failed') {
        await textChannel.send(
          `Deploy failed at **${status.step}**: ${status.error}`,
        );
      }
      // Clear status file after announcing so we don't re-announce on next restart
      fs.unlinkSync(statusPath);
    } catch {
      // No status file or channel not found — skip silently
    }
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
