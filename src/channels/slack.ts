import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const CHANNEL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_MESSAGE_LENGTH = 39000; // Slack limit is 40k, leave headroom
const SEND_DELAY_MS = 1000; // Rate limit: 1s between queued sends

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app!: App;
  private connected = false;
  private botUserId = '';
  private outgoingQueue: Array<{ jid: string; text: string; threadTs?: string }> = [];
  private flushing = false;
  private channelSyncTimerStarted = false;
  private displayNameCache: Map<string, string> = new Map();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN || env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. Add them to .env and re-run.',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // Handle @mentions in channels
    this.app.event('app_mention', async ({ event }) => {
      if (!event.user) return;
      // Reply in existing thread, or create a new thread under the mention
      const threadTs = (event as any).thread_ts as string | undefined;
      await this.handleEvent(event.channel, event.user, event.text, event.ts, true, threadTs || event.ts);
    });

    // Handle DMs
    this.app.event('message', async ({ event }) => {
      // Only handle DMs (channel starts with D)
      if (!event.channel.startsWith('D')) return;
      // Skip bot messages and subtypes (edits, deletes, etc.)
      if ('bot_id' in event || ('subtype' in event && event.subtype)) return;

      const user = 'user' in event ? (event.user as string) : '';
      const text = 'text' in event ? (event.text as string) : '';
      const ts = 'ts' in event ? (event.ts as string) : '';
      if (!user || !text) return;

      await this.handleEvent(event.channel, user, text, ts, false);
    });

    await this.app.start();

    // Get bot user ID
    const authResult = await this.app.client.auth.test({ token: botToken });
    this.botUserId = authResult.user_id || '';
    this.connected = true;

    logger.info({ botUserId: this.botUserId }, 'Connected to Slack (Socket Mode)');

    // Sync channel metadata on startup (respects 24h cache)
    this.syncChannelMetadata().catch((err) =>
      logger.error({ err }, 'Initial channel sync failed'),
    );
    // Set up daily sync timer (only once)
    if (!this.channelSyncTimerStarted) {
      this.channelSyncTimerStarted = true;
      setInterval(() => {
        this.syncChannelMetadata().catch((err) =>
          logger.error({ err }, 'Periodic channel sync failed'),
        );
      }, CHANNEL_SYNC_INTERVAL_MS);
    }

    // Flush any messages queued before connection
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush outgoing queue'),
    );
  }

  private async handleEvent(
    channel: string,
    userId: string,
    rawText: string,
    ts: string,
    isMention: boolean,
    threadTs?: string,
  ): Promise<void> {
    // Strip bot mention from text
    let text = rawText;
    if (isMention && this.botUserId) {
      text = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
    }

    if (!text) return;

    const timestamp = new Date(parseFloat(ts) * 1000).toISOString();

    // Resolve display name
    const senderName = await this.resolveDisplayName(userId);

    // Notify about chat metadata for channel discovery
    this.opts.onChatMetadata(channel, timestamp);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (groups[channel]) {
      // React with 👀 immediately so the user knows the message was seen
      this.app.client.reactions.add({ channel, name: 'eyes', timestamp: ts }).catch((err) => {
        logger.debug({ channel, ts, err }, 'Failed to add eyes reaction');
      });

      this.opts.onMessage(channel, {
        id: ts,
        chat_jid: channel,
        sender: userId,
        sender_name: senderName,
        content: text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        thread_ts: threadTs,
      });
    }
  }

  private async resolveDisplayName(userId: string): Promise<string> {
    const cached = this.displayNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name =
        result.user?.profile?.display_name ||
        result.user?.real_name ||
        result.user?.name ||
        userId;
      this.displayNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve display name');
      return userId;
    }
  }

  async sendMessage(jid: string, text: string, threadTs?: string): Promise<void> {
    // No assistant name prefix — Slack shows bot identity natively

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Split long messages on newline boundaries
      const chunks = this.splitMessage(text);
      for (const chunk of chunks) {
        await this.app.client.chat.postMessage({
          channel: jid,
          text: chunk,
          ...(threadTs && { thread_ts: threadTs }),
        });
      }
      logger.info({ jid, length: text.length, chunks: chunks.length, threadTs }, 'Message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text, threadTs });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return /^[CDG][A-Z0-9]+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      await this.app?.stop();
    } catch {
      // Ignore stop errors during shutdown
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // No-op: Slack API doesn't support bot typing indicators
  }

  async sendFile(
    jid: string,
    filePath: string,
    filename?: string,
    title?: string,
    comment?: string,
    threadTs?: string,
  ): Promise<void> {
    const resolvedThread = threadTs;
    const actualFilename = filename || path.basename(filePath);

    try {
      const base = {
        file: fs.createReadStream(filePath),
        filename: actualFilename,
        title: title || actualFilename,
        initial_comment: comment,
      };
      if (resolvedThread) {
        await this.app.client.files.uploadV2({ ...base, channel_id: jid, thread_ts: resolvedThread });
      } else {
        await this.app.client.files.uploadV2({ ...base, channel_id: jid });
      }
      logger.info({ jid, filePath: actualFilename, threadTs: resolvedThread }, 'File uploaded');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to upload file');
      throw err;
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches all channels the bot is in and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncChannelMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < CHANNEL_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping channel sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing channel metadata from Slack...');
      let count = 0;
      let cursor: string | undefined;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel,im',
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name) {
            updateChatName(ch.id, ch.name);
            count++;
          } else if (ch.id && ch.is_im) {
            // DMs don't have names; use the user's display name
            const user = ch.user;
            if (user) {
              const name = await this.resolveDisplayName(user);
              updateChatName(ch.id, `DM: ${name}`);
              count++;
            }
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      setLastGroupSync();
      logger.info({ count }, 'Channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync channel metadata');
    }
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > MAX_MESSAGE_LENGTH) {
      // Find the last newline before the limit
      let splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (splitIdx <= 0) {
        // No newline found; hard-split at limit
        splitIdx = MAX_MESSAGE_LENGTH;
      }
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 1);
    }
    if (remaining) chunks.push(remaining);

    return chunks;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const chunks = this.splitMessage(item.text);
        for (const chunk of chunks) {
          await this.app.client.chat.postMessage({
            channel: item.jid,
            text: chunk,
            ...(item.threadTs && { thread_ts: item.threadTs }),
          });
        }
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued message sent');
        // Rate limiting between queued sends
        if (this.outgoingQueue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
