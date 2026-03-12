import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import {
  ASSISTANT_NAME,
  buildTriggerPattern,
  escapeRegex,
  parseThreadJid,
  resolveAssistantName,
} from '../config.js';
import { downloadAttachment } from '../attachment-downloader.js';
import { getRouterState, setRouterState, updateChatName } from '../db.js';
import { ContainerConfig, Attachment } from '../types.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

/** Auto-register config: maps workspace team_id to registration template. */
interface AutoRegisterTemplate {
  folder: string;
  containerConfig: ContainerConfig;
  requiresTrigger: boolean;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botToken: string;
  private botUserId: string | undefined;
  private teamId: string | undefined;
  private autoRegisterConfig: Record<string, AutoRegisterTemplate> = {};
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private userIdByName = new Map<string, string>();

  // Track the thread_ts of the last triggering message per channel,
  // so replies go into the correct thread. For top-level messages, the
  // thread_ts is the message's own ts (starts a new thread).
  private replyThreadTs = new Map<string, string>();

  // Track the ts of the last user message per channel for reaction emoji.
  private lastUserMessageTs = new Map<string, string>();
  // Snapshot of the message ts that received the 👀 emoji, so the ✅ swap
  // targets the correct message even if new messages arrive while processing.
  private typingMessageTs = new Map<string, string>();

  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.botToken = botToken;
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Auto-register when the bot is invited to a new channel
    this.app.event('member_joined_channel', async ({ event }) => {
      // Only handle the bot itself joining
      if (event.user !== this.botUserId) return;

      const jid = `slack:${event.channel}`;
      const groups = this.opts.registeredGroups();
      if (groups[jid]) return; // Already registered

      const teamId = (event as { team?: string }).team;
      if (!teamId) return;

      const template = this.autoRegisterConfig[teamId];
      if (!template || !this.opts.registerGroup) return;

      // Get channel name from API
      let channelName = event.channel;
      try {
        const info = await this.app.client.conversations.info({
          channel: event.channel,
        });
        channelName = info.channel?.name || event.channel;
      } catch {
        // Use channel ID as fallback
      }

      const assistantName = resolveAssistantName(template.containerConfig);
      this.opts.registerGroup(jid, {
        name: channelName,
        folder: template.folder,
        trigger: `@${assistantName}`,
        added_at: new Date().toISOString(),
        containerConfig: { ...template.containerConfig },
        requiresTrigger: template.requiresTrigger,
      });

      // Store metadata so the channel shows up in discovery
      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        channelName,
        'slack',
        true,
      );

      logger.info(
        { jid, channelName, teamId, folder: template.folder },
        'Auto-registered Slack channel',
      );

      // Send greeting
      try {
        await this.app.client.chat.postMessage({
          channel: event.channel,
          text: `Hey! I'm ${assistantName} — tag me with @${assistantName} to get started.`,
        });
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to send auto-register greeting');
      }
    });

    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;
      const msgAny = msg as any; // eslint-disable-line @typescript-eslint/no-explicit-any

      // Skip messages with no content at all (no text, attachments, or blocks)
      if (!msg.text && !msgAny.attachments?.length && !msgAny.blocks?.length)
        return;

      const baseJid = `slack:${msg.channel}`;
      // thread_ts is present when the message is inside a thread.
      // For top-level messages it's undefined — we use msg.ts to start a new thread.
      const threadTs = (msg as { thread_ts?: string }).thread_ts;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery (use base JID)
      this.opts.onChatMetadata(baseJid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[baseJid]) return;

      // Resolve per-group assistant name (falls back to global default)
      const group = groups[baseJid];
      const assistantName = resolveAssistantName(group.containerConfig);
      const triggerPattern = buildTriggerPattern(assistantName);
      // Thread sessions default on for Slack; explicit false to disable
      const threadSessionsEnabled =
        group.containerConfig?.enableThreadSessions !== false;

      // Distinguish our bot from external bots (dbt Cloud, GitHub, etc.)
      const isOurBot = msg.user === this.botUserId;
      const isAnyBot = !!msg.bot_id || isOurBot;

      let senderName: string;
      if (isOurBot) {
        senderName = assistantName;
      } else if (isAnyBot) {
        senderName =
          (msg as any).username ||
          (msg as any).bot_profile?.name ||
          msg.bot_id ||
          'bot'; // eslint-disable-line @typescript-eslint/no-explicit-any
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Extract content — fall back to attachments/blocks for integration messages
      let content = msg.text || this.extractFallbackText(msgAny);

      // Check for bot mention in the raw message BEFORE wrapping with thread
      // context, so old @mentions in the thread history don't false-trigger.
      const hasBotMention =
        !!this.botUserId &&
        !isAnyBot &&
        content.includes(`<@${this.botUserId}>`);

      // Track which thread to reply in and which message gets the emoji.
      // Only update when the message mentions the bot — unrelated messages
      // (even in threads) should not steal the thread anchor or emoji target.
      // Slack channels are shared workspaces where teammates talk to each other;
      // the bot only responds when explicitly tagged.
      if (!isAnyBot && hasBotMention) {
        this.replyThreadTs.set(baseJid, threadTs || msg.ts);
        this.lastUserMessageTs.set(baseJid, msg.ts);
        // For thread messages, also key by the thread JID so setTyping
        // can find the correct message when called with a thread JID.
        if (threadTs) {
          const threadJid = `slack:${msg.channel}:thread:${threadTs}`;
          this.lastUserMessageTs.set(threadJid, msg.ts);
        }
      }

      // If the message is inside a thread and thread sessions are NOT enabled,
      // fetch thread history so the agent has full context of the conversation.
      // When thread sessions ARE enabled, the session already has context —
      // skip the expensive history fetch.
      if (threadTs && !isAnyBot && !threadSessionsEnabled) {
        const threadContext = await this.fetchThreadHistory(
          msg.channel,
          threadTs,
          msg.ts,
          assistantName,
        );
        if (threadContext) {
          content = `[Thread context]\n${threadContext}\n[Latest message]\n${content}`;
        }
      }

      // Resolve Slack <@USERID> mentions to readable names so the agent
      // knows who is being referenced (e.g. "<@U0AJE0VK802>" → "@Hive").
      // Done AFTER hasBotMention check which needs the raw <@BOTID> format.
      content = await this.resolveUserMentions(content);

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Prepend @AssistantName so the trigger pattern matches.
      // Uses the pre-wrapping bot mention check to avoid false positives
      // from old mentions in thread context.
      if (hasBotMention && !triggerPattern.test(content)) {
        content = `@${assistantName} ${content}`;
      }

      // Download attached files (images, documents)
      const downloadedAttachments: Attachment[] = [];
      const files = (msg as any).files as
        | Array<{
            id: string;
            name?: string;
            mimetype?: string;
            url_private_download?: string;
            size?: number;
          }>
        | undefined;
      if (files && files.length > 0 && !isAnyBot) {
        const slackBotToken = this.botToken;
        const downloads = await Promise.all(
          files.map(async (file) => {
            if (!file.url_private_download) return null;
            const mimeType = file.mimetype || 'application/octet-stream';
            const filename = file.name || 'file';
            return downloadAttachment({
              messageId: msg.ts,
              groupFolder: group.folder,
              filename,
              mimeType,
              expectedSize: file.size,
              fetchFn: async () => {
                const resp = await fetch(file.url_private_download!, {
                  headers: { Authorization: `Bearer ${slackBotToken}` },
                });
                if (!resp.ok)
                  throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
                return Buffer.from(await resp.arrayBuffer());
              },
            });
          }),
        );
        for (const dl of downloads) {
          if (dl) downloadedAttachments.push(dl);
        }
      }

      // When thread sessions are enabled and the message is inside a thread,
      // emit a thread-scoped JID so the orchestrator creates an isolated session.
      // Top-level messages always use baseJid — the thread is created on reply.
      const storeJid =
        threadSessionsEnabled && threadTs
          ? `slack:${msg.channel}:thread:${threadTs}`
          : baseJid;
      this.opts.onMessage(storeJid, {
        id: msg.ts,
        chat_jid: storeJid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isOurBot,
        is_bot_message: isOurBot,
        attachments:
          downloadedAttachments.length > 0 ? downloadedAttachments : undefined,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      this.teamId = auth.team_id as string;
      logger.info(
        { botUserId: this.botUserId, teamId: this.teamId },
        'Connected to Slack',
      );
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    // Load or auto-discover auto-register config for workspace-wide registration
    this.loadAutoRegisterConfig();

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const parsed = parseThreadJid(jid);
    const channelId = parsed ? parsed.parentId : jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Thread ts from JID takes priority (thread-session mode),
      // then fall back to replyThreadTs map (legacy mode)
      const threadTs = parsed ? parsed.threadId : this.replyThreadTs.get(jid);
      text = this.replaceMentions(text);

      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          thread_ts: threadTs,
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            thread_ts: threadTs,
          });
        }
      }
      logger.info({ jid, length: text.length, threadTs }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
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
  }

  clearThreadState(parentJid: string, threadId?: string): void {
    if (threadId) {
      // Per-thread cleanup: only clear state for this specific thread
      const threadJid = `${parentJid}:thread:${threadId}`;
      this.lastUserMessageTs.delete(threadJid);
      this.typingMessageTs.delete(threadJid);
    } else {
      // No thread specified: clear parent-level state and all thread entries
      this.replyThreadTs.delete(parentJid);
      this.lastUserMessageTs.delete(parentJid);
      this.typingMessageTs.delete(parentJid);
      const threadPrefix = `${parentJid}:thread:`;
      for (const key of this.lastUserMessageTs.keys()) {
        if (key.startsWith(threadPrefix)) this.lastUserMessageTs.delete(key);
      }
      for (const key of this.typingMessageTs.keys()) {
        if (key.startsWith(threadPrefix)) this.typingMessageTs.delete(key);
      }
    }
  }

  // Slack doesn't have a typing indicator API for bots.
  // Instead, add/remove a reaction emoji on the triggering message
  // so the user knows the bot is processing.
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const parsedJid = parseThreadJid(jid);
    const channelId = parsedJid
      ? parsedJid.parentId
      : jid.replace(/^slack:/, '');
    const baseJid = parsedJid ? `slack:${parsedJid.parentId}` : jid;

    // On start: snapshot the current user message ts so the ✅ swap
    // targets the same message even if new messages arrive while processing.
    // On stop: use the snapshot (fall back to latest if no snapshot).
    // Check thread JID first (for thread messages), then baseJid.
    const lookupKey = parsedJid ? jid : baseJid;
    let messageTs: string | undefined;
    if (isTyping) {
      messageTs =
        this.lastUserMessageTs.get(lookupKey) ||
        this.lastUserMessageTs.get(baseJid);
      if (messageTs) this.typingMessageTs.set(lookupKey, messageTs);
    } else {
      // Only clear if we have an active typing indicator (idempotent stop).
      // Without this check, repeated setTyping(false) calls would make
      // redundant Slack API calls on every streaming output chunk.
      if (!this.typingMessageTs.has(lookupKey)) return;
      messageTs = this.typingMessageTs.get(lookupKey);
      this.typingMessageTs.delete(lookupKey);
    }

    if (!messageTs) {
      logger.debug({ jid, isTyping }, 'No lastUserMessageTs for reaction');
      return;
    }

    const safeReaction = async (method: 'add' | 'remove', name: string) => {
      try {
        await this.app.client.reactions[method]({
          channel: channelId,
          timestamp: messageTs,
          name,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already_reacted') && !msg.includes('no_reaction')) {
          logger.warn({ jid, isTyping, err: msg }, 'Slack reaction failed');
        }
      }
    };

    if (isTyping) {
      await safeReaction('add', 'eyes');
    } else {
      // Swap 👀 → ✅ to signal completion
      await safeReaction('remove', 'eyes');
      await safeReaction('add', 'white_check_mark');
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');

      // Pre-populate user name cache for registered channels
      const groups = this.opts.registeredGroups();
      for (const jid of Object.keys(groups)) {
        if (!jid.startsWith('slack:')) continue;
        const channelId = jid.replace(/^slack:/, '');
        try {
          const members = await this.app.client.conversations.members({
            channel: channelId,
            limit: 200,
          });
          for (const userId of members.members || []) {
            await this.resolveUserName(userId);
          }
        } catch {
          // ignore — channel may not be accessible
        }
      }
      logger.info(
        { userCount: this.userIdByName.size },
        'Slack user name cache populated',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  async fetchMessage(
    jid: string,
    messageId: string,
  ): Promise<import('../types.js').NewMessage | undefined> {
    const parsed = parseThreadJid(jid);
    const channelId = parsed ? parsed.parentId : jid.replace(/^slack:/, '');
    try {
      const result = await this.app.client.conversations.history({
        channel: channelId,
        latest: messageId,
        inclusive: true,
        limit: 1,
      });
      const msg = result.messages?.[0];
      if (!msg || msg.ts !== messageId) return undefined;

      const isBotMsg = !!msg.bot_id || msg.user === this.botUserId;
      const isOurBot = msg.user === this.botUserId;
      const senderName = isBotMsg
        ? isOurBot
          ? resolveAssistantName()
          : msg.username || msg.bot_id || 'bot'
        : msg.user
          ? (await this.resolveUserName(msg.user)) || msg.user
          : 'unknown';
      const rawContent = msg.text || this.extractFallbackText(msg);
      const content = await this.resolveUserMentions(rawContent);

      return {
        id: msg.ts!,
        chat_jid: `slack:${channelId}`,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
        is_from_me: isOurBot,
        is_bot_message: isOurBot,
      };
    } catch (err) {
      logger.warn({ jid, messageId, err }, 'Failed to fetch Slack message');
      return undefined;
    }
  }

  /**
   * Fetch thread history for context when a message arrives inside a thread.
   * Returns formatted thread messages excluding the current message.
   */
  private async fetchThreadHistory(
    channel: string,
    threadTs: string,
    currentTs: string,
    assistantName?: string,
  ): Promise<string | undefined> {
    try {
      const result = await this.app.client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 50,
      });

      const messages = (result.messages || []).filter(
        (m) =>
          m.ts !== currentTs &&
          (m.text || m.attachments?.length || m.blocks?.length),
      );

      if (messages.length === 0) return undefined;

      const botName = assistantName || ASSISTANT_NAME;
      const lines = await Promise.all(
        messages.map(async (m) => {
          const isBotMsg = !!m.bot_id || m.user === this.botUserId;
          const name = isBotMsg
            ? botName
            : m.user
              ? (await this.resolveUserName(m.user)) || m.user
              : 'unknown';
          const raw = m.text || this.extractFallbackText(m);
          const text = await this.resolveUserMentions(raw);
          return `${name}: ${text}`;
        }),
      );

      return lines.join('\n');
    } catch (err) {
      logger.warn({ channel, threadTs, err }, 'Failed to fetch thread history');
      return undefined;
    }
  }

  /**
   * Extract readable text from attachments/blocks when m.text is empty.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractFallbackText(m: any): string {
    // Try attachments first (common for bot/integration messages)
    if (m.attachments?.length) {
      const parts = m.attachments
        .map((a: any) => a.text || a.fallback || a.pretext)
        .filter(Boolean);
      if (parts.length) return parts.join('\n');
    }

    // Try blocks (rich_text, section, etc.)
    if (m.blocks?.length) {
      const parts: string[] = [];
      for (const block of m.blocks) {
        if (block.text?.text) {
          parts.push(block.text.text);
        } else if (block.elements) {
          for (const el of block.elements) {
            if (el.text) {
              parts.push(el.text);
            } else if (el.elements) {
              const inner = el.elements
                .map((e: any) => e.text)
                .filter(Boolean)
                .join('');
              if (inner) parts.push(inner);
            }
          }
        }
      }
      if (parts.length) return parts.join('\n');
    }

    return '(non-text message)';
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) {
        this.userNameCache.set(userId, name);
        this.userIdByName.set(name.toLowerCase(), userId);
        // Also cache display_name for matching
        const displayName = result.user?.profile?.display_name;
        if (displayName) {
          this.userIdByName.set(displayName.toLowerCase(), userId);
        }
      }
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  /**
   * Replace all <@USERID> mentions in text with @DisplayName.
   * Falls back to the raw ID if the user can't be resolved.
   */
  private async resolveUserMentions(text: string): Promise<string> {
    const mentionRe = /<@([A-Z0-9]+)>/g;
    const matches = [...text.matchAll(mentionRe)];
    if (matches.length === 0) return text;

    // Resolve unique IDs concurrently, then do a single-pass replace.
    const uniqueIds = [...new Set(matches.map((m) => m[1]))];
    const nameMap = new Map<string, string>();
    await Promise.all(
      uniqueIds.map(async (id) => {
        const name = await this.resolveUserName(id);
        if (name) nameMap.set(id, name);
      }),
    );

    return text.replace(mentionRe, (full, userId) => {
      const name = nameMap.get(userId);
      return name ? `@${name}` : full;
    });
  }

  /**
   * Convert name mentions in outbound text to Slack <@USER_ID> format.
   * Matches both "@Name" and plain "Name" against cached real_name and
   * display_name (case-insensitive). Only matches at word boundaries
   * and skips the bot's own name and already-converted mentions.
   */
  private replaceMentions(text: string): string {
    if (this.userIdByName.size === 0) return text;
    // Sort names by length (longest first) to avoid partial matches
    const names = [...this.userIdByName.entries()].sort(
      (a, b) => b[0].length - a[0].length,
    );
    let result = text;
    for (const [name, userId] of names) {
      if (userId === this.botUserId) continue;
      const escaped = escapeRegex(name);
      // Match @Name or plain Name with word boundaries on both sides.
      // Negative lookbehind prevents matching inside <@U...> slack mentions.
      const pattern = new RegExp(`(?<!<)@?\\b${escaped}\\b`, 'gi');
      result = result.replace(pattern, `<@${userId}>`);
    }
    return result;
  }

  /**
   * Load auto-register config from DB, or auto-discover from existing
   * registered Slack channels that have a per-group assistantName set.
   */
  private loadAutoRegisterConfig(): void {
    if (!this.teamId) return;

    // Try loading existing config
    const stored = getRouterState('slack_auto_register');
    if (stored) {
      try {
        this.autoRegisterConfig = JSON.parse(stored);
        if (this.autoRegisterConfig[this.teamId]) {
          logger.info(
            { teamId: this.teamId },
            'Slack auto-register config loaded',
          );
        }
        return;
      } catch {
        // Corrupted — fall through to auto-discover
      }
    }

    // Auto-discover: find existing Slack channels with assistantName override
    const groups = this.opts.registeredGroups();
    for (const [jid, group] of Object.entries(groups)) {
      if (!jid.startsWith('slack:') || !group.containerConfig?.assistantName)
        continue;
      // Use this channel's config as the template
      this.autoRegisterConfig = {
        [this.teamId]: {
          folder: group.folder,
          containerConfig: { ...group.containerConfig },
          requiresTrigger: group.requiresTrigger !== false,
        },
      };
      setRouterState(
        'slack_auto_register',
        JSON.stringify(this.autoRegisterConfig),
      );
      logger.info(
        {
          teamId: this.teamId,
          folder: group.folder,
          templateJid: jid,
        },
        'Slack auto-register config created from existing channel',
      );
      return;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        const threadTs = this.replyThreadTs.get(item.jid);
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          thread_ts: threadTs,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  try {
    return new SlackChannel(opts);
  } catch {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
});
