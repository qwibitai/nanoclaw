/**
 * Slack channel for NanoClaw.
 * Uses Socket Mode via @slack/bolt for real-time messaging.
 */
import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME } from '../config.js';
import { storeMessageDirect } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const USER_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEDUP_TTL_MS = 2 * 60 * 1000; // 2 minutes
const DEDUP_MAX_SIZE = 2000;
const MAX_CHUNK_SIZE = 3900; // Slack's limit is ~4000 for chat.postMessage

// Subtypes we allow through (most subtypes are noise: channel_join, etc.)
const ALLOWED_SUBTYPES = new Set([
  'thread_broadcast',
  'file_share',
  'me_message',
]);

export interface SlackChannelOpts {
  botToken: string;
  appToken: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private connected = false;
  private botUserId: string | null = null;
  private botBotId: string | null = null;

  // User display name cache
  private userCache = new Map<string, { name: string; ts: number }>();

  // Event dedup
  private seenEvents = new Map<string, number>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
  }

  async connect(): Promise<void> {
    // Identify ourselves
    try {
      const authResult = await this.app.client.auth.test({
        token: this.opts.botToken,
      });
      this.botUserId = authResult.user_id as string;
      this.botBotId = (authResult.bot_id as string | undefined) ?? null;
      logger.info(
        { botUserId: this.botUserId, botBotId: this.botBotId },
        'Slack bot identity resolved',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to resolve Slack bot identity');
    }

    // Listen for messages
    this.app.event('message', async ({ event }) => {
      const ev = event as unknown as Record<string, unknown>;

      // Dedup
      const eventId = (ev.client_msg_id as string) || (ev.ts as string);
      if (!eventId) return;
      if (this.isDuplicate(eventId)) return;

      // Filter subtypes
      const subtype = ev.subtype as string | undefined;
      if (subtype && !ALLOWED_SUBTYPES.has(subtype)) return;

      // Filter bot's own messages
      const userId = ev.user as string | undefined;
      const botId = ev.bot_id as string | undefined;
      if (userId === this.botUserId) return;
      if (botId && botId === this.botBotId) return;

      const channelId = ev.channel as string;
      if (!channelId) return;

      const text = ev.text as string;
      if (!text) return;

      const chatJid = `${channelId}@slack`;
      const threadTs = (ev.thread_ts as string) || undefined;
      const timestamp = new Date(
        parseFloat(ev.ts as string) * 1000,
      ).toISOString();

      // Resolve sender name
      const senderName = userId
        ? await this.resolveUserName(userId)
        : 'unknown';

      // Notify about chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', true);

      // Normalize Slack mentions (<@U123> → @DisplayName)
      const normalizedText = await this.normalizeMentions(text);

      const groups = this.opts.registeredGroups();
      if (groups[chatJid]) {
        const msg = {
          id: eventId,
          chat_jid: chatJid,
          sender: userId || 'unknown',
          sender_name: senderName,
          content: normalizedText,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
          thread_ts: threadTs,
        };

        storeMessageDirect(msg);
        this.opts.onMessage(chatJid, msg);
      }
    });

    await this.app.start();
    this.connected = true;
    logger.info('Slack channel connected (Socket Mode)');

    // Periodic dedup cleanup
    setInterval(() => this.cleanupDedup(), 60_000);
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: { thread_ts?: string },
  ): Promise<string | void> {
    const channelId = jid.replace(/@slack$/, '');
    const threadTs = options?.thread_ts;

    // Prefix with assistant name
    const prefixed = `${ASSISTANT_NAME}: ${text}`;

    // Chunk long messages
    const chunks = this.chunkMessage(prefixed);

    let firstTs: string | undefined;

    for (const chunk of chunks) {
      try {
        const result = await this.app.client.chat.postMessage({
          channel: channelId,
          text: chunk,
          thread_ts: threadTs,
        });
        if (!firstTs && result.ts) {
          firstTs = result.ts;
        }
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send Slack message');
      }
    }

    return firstTs;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@slack');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      await this.app.stop();
    } catch {
      // ignore
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Slack doesn't have a typing indicator API for bots.
    // Use emoji reactions as a substitute.
    // (Not implemented to keep it simple — can be added later)
  }

  private isDuplicate(eventId: string): boolean {
    const now = Date.now();
    if (this.seenEvents.has(eventId)) return true;
    this.seenEvents.set(eventId, now);
    return false;
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [id, ts] of this.seenEvents) {
      if (now - ts > DEDUP_TTL_MS) {
        this.seenEvents.delete(id);
      }
    }
    // Cap size
    if (this.seenEvents.size > DEDUP_MAX_SIZE) {
      const entries = Array.from(this.seenEvents.entries()).sort(
        (a, b) => a[1] - b[1],
      );
      const toRemove = entries.slice(0, entries.length - DEDUP_MAX_SIZE);
      for (const [id] of toRemove) {
        this.seenEvents.delete(id);
      }
    }
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached && Date.now() - cached.ts < USER_CACHE_TTL_MS) {
      return cached.name;
    }

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name =
        result.user?.profile?.display_name ||
        result.user?.profile?.real_name ||
        result.user?.name ||
        userId;
      this.userCache.set(userId, { name, ts: Date.now() });
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return userId;
    }
  }

  private async normalizeMentions(text: string): Promise<string> {
    const mentionRegex = /<@(U[A-Z0-9]+)>/g;
    const matches = text.matchAll(mentionRegex);
    let result = text;

    for (const match of matches) {
      const userId = match[1];
      const displayName = await this.resolveUserName(userId);
      result = result.replace(match[0], `@${displayName}`);
    }

    return result;
  }

  private chunkMessage(text: string): string[] {
    if (text.length <= MAX_CHUNK_SIZE) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_CHUNK_SIZE) {
        chunks.push(remaining);
        break;
      }

      // Try to break at a newline
      let breakIdx = remaining.lastIndexOf('\n', MAX_CHUNK_SIZE);
      if (breakIdx <= 0) {
        // Fall back to space
        breakIdx = remaining.lastIndexOf(' ', MAX_CHUNK_SIZE);
      }
      if (breakIdx <= 0) {
        breakIdx = MAX_CHUNK_SIZE;
      }

      chunks.push(remaining.slice(0, breakIdx));
      remaining = remaining.slice(breakIdx).trimStart();
    }

    return chunks;
  }
}
