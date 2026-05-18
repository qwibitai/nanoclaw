import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { processImageBuffer, isSupportedImageMime } from '../image.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  ImageAttachment,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<
    | { kind: 'text'; jid: string; text: string }
    | {
        kind: 'image';
        jid: string;
        imagePaths: string[];
        caption?: string;
      }
    | {
        kind: 'video';
        jid: string;
        videoPaths: string[];
        caption?: string;
      }
  > = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private botToken: string;

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
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
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text && !(msg as { files?: unknown[] }).files?.length) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage && content) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Process image attachments. Slack delivers files[] on the message event;
      // we download each supported image via url_private_download (requires the
      // bot token as bearer auth) and pass it through the shared image pipeline.
      const files =
        (
          msg as {
            files?: Array<{
              id?: string;
              mimetype?: string;
              url_private_download?: string;
              name?: string;
            }>;
          }
        ).files ?? [];
      const images: ImageAttachment[] = [];
      for (const file of files) {
        if (!file.mimetype || !isSupportedImageMime(file.mimetype)) {
          // Surface at warn level so silent file drops are visible in
          // info-level logs. The agent sees zero images when this fires;
          // without the log, that looks indistinguishable from "user
          // attached nothing", which is impossible to debug after the fact.
          logger.warn(
            { fileId: file.id, fileName: file.name, mime: file.mimetype },
            file.mimetype
              ? 'Slack attachment skipped: unsupported MIME type'
              : 'Slack attachment skipped: no MIME type reported',
          );
          continue;
        }
        if (!file.url_private_download) continue;
        try {
          const res = await fetch(file.url_private_download, {
            headers: { Authorization: `Bearer ${this.botToken}` },
          });
          if (!res.ok) {
            logger.warn(
              { fileId: file.id, status: res.status },
              'Slack image fetch failed',
            );
            continue;
          }
          const buf = Buffer.from(await res.arrayBuffer());
          const att = await processImageBuffer(buf, file.mimetype);
          if (att) images.push(att);
        } catch (err) {
          logger.warn({ fileId: file.id, err }, 'Slack image processing error');
        }
      }

      // If nothing survived (no text AND no images), silently drop to match pre-image behavior.
      if (!msg.text && images.length === 0) return;

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content: content ?? '',
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        images: images.length ? images : undefined,
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
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'text', jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ kind: 'text', jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  async sendImage(
    jid: string,
    imagePaths: string[],
    caption?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'image', jid, imagePaths, caption });
      logger.info(
        { jid, count: imagePaths.length, queueSize: this.outgoingQueue.length },
        'Slack disconnected, image queued',
      );
      return;
    }
    try {
      await this.app.client.files.uploadV2({
        channel_id: channelId,
        initial_comment: caption,
        file_uploads: imagePaths.map((p) => ({
          file: fs.createReadStream(p),
          filename: path.basename(p),
        })),
      });
      logger.info({ jid, count: imagePaths.length }, 'Slack image(s) sent');
    } catch (err) {
      this.outgoingQueue.push({ kind: 'image', jid, imagePaths, caption });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack image, queued',
      );
    }
  }

  async sendVideo(
    jid: string,
    videoPaths: string[],
    caption?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'video', jid, videoPaths, caption });
      logger.info(
        { jid, count: videoPaths.length, queueSize: this.outgoingQueue.length },
        'Slack disconnected, video queued',
      );
      return;
    }
    // files.uploadV2 auto-detects video mime types from filename; the same
    // call shape works for both images and videos.
    try {
      await this.app.client.files.uploadV2({
        channel_id: channelId,
        initial_comment: caption,
        file_uploads: videoPaths.map((p) => ({
          file: fs.createReadStream(p),
          filename: path.basename(p),
        })),
      });
      logger.info({ jid, count: videoPaths.length }, 'Slack video(s) sent');
    } catch (err) {
      this.outgoingQueue.push({ kind: 'video', jid, videoPaths, caption });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack video, queued',
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

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
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
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
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
        if (item.kind === 'text') {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: item.text,
          });
          logger.info(
            { jid: item.jid, length: item.text.length },
            'Queued Slack text sent',
          );
        } else if (item.kind === 'image') {
          await this.app.client.files.uploadV2({
            channel_id: channelId,
            initial_comment: item.caption,
            file_uploads: item.imagePaths.map((p) => ({
              file: fs.createReadStream(p),
              filename: path.basename(p),
            })),
          });
          logger.info(
            { jid: item.jid, count: item.imagePaths.length },
            'Queued Slack image(s) sent',
          );
        } else if (item.kind === 'video') {
          await this.app.client.files.uploadV2({
            channel_id: channelId,
            initial_comment: item.caption,
            file_uploads: item.videoPaths.map((p) => ({
              file: fs.createReadStream(p),
              filename: path.basename(p),
            })),
          });
          logger.info(
            { jid: item.jid, count: item.videoPaths.length },
            'Queued Slack video(s) sent',
          );
        } else {
          // Exhaustiveness check — adding a new kind to outgoingQueue will trip
          // this at compile time before it can silently misroute at runtime.
          const _exhaustive: never = item;
          void _exhaustive;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
