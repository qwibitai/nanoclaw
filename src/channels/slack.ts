import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { transcribeAudio } from '../transcription.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// How often to verify the Slack socket is alive (ms).
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Reconnection backoff: start at 5s, double each retry, cap at 5 minutes.
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

const MAX_TRANSCRIPTION_SIZE = 25 * 1024 * 1024;

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
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;
  private botToken: string;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  private reconnecting = false;
  private reconnectAttempts = 0;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;
    this.botToken = botToken || '';

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();

    // Catch unhandled Slack errors (socket drops, auth failures, etc.)
    this.app.error(async (error) => {
      logger.error({ err: error }, 'Slack app error');
      this.scheduleReconnect();
    });
  }

  private setupEventHandlers(): void {
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
      let content = msg.text || '';
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Download file attachments and append paths to message content.
      // Files are saved to the group's attachments dir, mounted at /workspace/group/attachments/
      const genericMsg = msg as GenericMessageEvent & {
        files?: Array<{
          id: string;
          url_private_download?: string;
          url_private: string;
          name: string;
          mimetype?: string;
          size?: number;
        }>;
      };
      if (genericMsg.files?.length && !isBotMessage) {
        const group = groups[jid];
        const attachDir = path.join(GROUPS_DIR, group.folder, 'attachments');
        fs.mkdirSync(attachDir, { recursive: true });

        const savedPaths: string[] = [];
        let transcriptText: string | null = null;
        let audioTranscribed = false;

        for (const file of genericMsg.files) {
          try {
            const downloadUrl = file.url_private_download || file.url_private;
            logger.debug(
              {
                file: file.name,
                id: file.id,
                url: downloadUrl,
                mimetype: file.mimetype,
              },
              'Attempting Slack file download',
            );

            const fileBuffer = await this.downloadSlackFile(downloadUrl);
            if (!fileBuffer) {
              logger.warn({ file: file.name }, 'Slack file download failed');
              continue;
            }

            // Save file to attachments (all files, including audio)
            const ts = Date.now();
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const filename = `${ts}-${safeName}`;
            const hostPath = path.join(attachDir, filename);
            fs.writeFileSync(hostPath, fileBuffer);
            savedPaths.push(`/workspace/group/attachments/${filename}`);
            logger.info(
              { file: file.name, path: hostPath, size: fileBuffer.length },
              'Slack attachment saved',
            );

            // Transcribe first audio file
            const isAudio = file.mimetype?.startsWith('audio/');
            if (isAudio && !audioTranscribed) {
              if (fileBuffer.length > MAX_TRANSCRIPTION_SIZE) {
                content += '\n\n[Audio clip too large for transcription (max ~25 min)]';
              } else {
                const transcript = await transcribeAudio(fileBuffer, file.name);
                if (transcript) {
                  transcriptText = transcript;
                } else {
                  content += '\n\n[Audio clip — transcription unavailable]';
                }
              }
              audioTranscribed = true;
            }
          } catch (err) {
            logger.warn(
              { file: file.name, error: err },
              'Slack file download error',
            );
          }
        }

        // Prepend transcript before attachment paths
        if (transcriptText) {
          content = `[Voice: ${transcriptText}]\n${content}`;
        }

        if (savedPaths.length) {
          const fileList = savedPaths.map((p) => `- ${p}`).join('\n');
          content += `\n\n[Attached files - read them with the Read tool:\n${fileList}\n]`;
        }
      }

      // Skip messages with no text and no attachments
      if (!content.trim()) return;

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
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
    this.reconnectAttempts = 0;

    // Start periodic health checks
    this.startHealthCheck();

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
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
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    await this.app.stop();
  }

  /**
   * Periodically call auth.test() to verify the socket is alive.
   * If the call fails, trigger a reconnect.
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);

    this.healthCheckTimer = setInterval(async () => {
      if (this.reconnecting) return;
      try {
        await this.app.client.auth.test();
        logger.debug('Slack health check OK');
      } catch (err) {
        logger.warn({ err }, 'Slack health check failed');
        this.scheduleReconnect();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * Safe to call multiple times — only one reconnect loop runs at a time.
   */
  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.connected = false;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }

    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    logger.info(
      { attempt: this.reconnectAttempts, delayMs: delay },
      'Scheduling Slack reconnect',
    );

    setTimeout(() => this.attemptReconnect(), delay);
  }

  private async attemptReconnect(): Promise<void> {
    try {
      logger.info(
        { attempt: this.reconnectAttempts },
        'Attempting Slack reconnect',
      );

      // Stop the old socket (ignore errors — it may already be dead)
      try {
        await this.app.stop();
      } catch {
        // expected if socket is already closed
      }

      // Re-create the Bolt app with fresh socket
      const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
      this.app = new App({
        token: env.SLACK_BOT_TOKEN,
        appToken: env.SLACK_APP_TOKEN,
        socketMode: true,
        logLevel: LogLevel.ERROR,
      });

      this.setupEventHandlers();
      this.app.error(async (error) => {
        logger.error({ err: error }, 'Slack app error');
        this.scheduleReconnect();
      });

      await this.app.start();

      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;

      this.connected = true;
      this.reconnecting = false;
      this.reconnectAttempts = 0;

      this.startHealthCheck();
      await this.flushOutgoingQueue();

      logger.info(
        { botUserId: this.botUserId },
        'Slack reconnected successfully',
      );
    } catch (err) {
      logger.error(
        { err, attempt: this.reconnectAttempts },
        'Slack reconnect failed',
      );
      this.reconnecting = false;
      this.scheduleReconnect();
    }
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

  /**
   * Download a file from Slack's private URL using the bot token.
   * Node.js fetch strips the Authorization header on cross-origin redirects
   * (per WHATWG Fetch spec). Slack redirects files.slack.com to their CDN on
   * a different origin, so we must use redirect: "manual" and re-attach the
   * auth header on the redirect request.
   */
  private async downloadSlackFile(url: string): Promise<Buffer | null> {
    const token = this.botToken;
    const authHeader = { Authorization: `Bearer ${token}` };

    const resp = await fetch(url, {
      headers: authHeader,
      redirect: 'manual',
    });

    let finalResp: Response;
    if (resp.status >= 300 && resp.status < 400) {
      const redirectUrl = resp.headers.get('location');
      if (!redirectUrl) return null;
      // Re-attach auth header on the redirect (fetch would strip it)
      finalResp = await fetch(redirectUrl, { headers: authHeader });
    } else {
      finalResp = resp;
    }

    if (!finalResp.ok) {
      logger.warn(
        { url, status: finalResp.status },
        'Slack file download failed',
      );
      return null;
    }

    const buf = Buffer.from(await finalResp.arrayBuffer());
    const contentType = finalResp.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      logger.warn({ url }, 'Slack file download returned HTML instead of file');
      return null;
    }

    return buf;
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
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
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
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
