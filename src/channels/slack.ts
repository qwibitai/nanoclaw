import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { replyBus } from './reply-bus.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
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
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  /** Track the latest inbound (non-bot, non-self) message ts per channel for reaction-based ack */
  private lastInboundTs = new Map<string, string>();

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

      if (!msg.text) return;

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

      // isFromMe: only X's own messages (prevent self-response loops)
      // isBotMessage: all bots including X (for is_bot_message storage)
      const isFromMe = msg.user === this.botUserId;
      const isBotMessage = !!msg.bot_id || isFromMe;

      let senderName: string;
      if (isFromMe) {
        senderName = ASSISTANT_NAME;
      } else if (isBotMessage) {
        // Other bots — use their Slack username if available
        senderName = (msg as BotMessageEvent).username || msg.bot_id || 'bot';
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Apply to all non-self messages (including other bots) so @X from Nook works.
      let content = msg.text;
      if (this.botUserId && !isFromMe) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Track latest non-bot, non-self message for reaction-based typing indicator
      if (!isFromMe && !isBotMessage) {
        this.lastInboundTs.set(jid, msg.ts);
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isBotMessage,
      });

      replyBus.emitReply({
        channel: 'slack',
        userId: msg.user || msg.bot_id || '',
        text: msg.text || '',
      });

      // Show thinking indicator for non-self messages (including other bots)
      if (!isFromMe) {
        const group = groups[jid];
        const willTrigger =
          !group.requiresTrigger ||
          group.isMain ||
          TRIGGER_PATTERN.test(content.trim());
        if (willTrigger) {
          this.setTyping(jid, true).catch((err) =>
            logger.debug(
              { jid, err },
              'Failed to show early thinking indicator',
            ),
          );
        }
      }
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

  /**
   * Post directly to a Slack channel by ID or name (no jid prefix required).
   * Returns the Slack API response with ok/ts on success, or a structured
   * error object on failure. Used by the slack_post_to_channel IPC handler.
   */
  async postToChannel(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{
    ok: boolean;
    channel?: string;
    ts?: string;
    permalink?: string;
    error?: string;
    hint?: string;
  }> {
    if (!this.connected) {
      return {
        ok: false,
        error: 'not_connected',
        hint: 'Slack channel not connected yet. Retry after the bot finishes startup.',
      };
    }
    try {
      const result = await this.app.client.chat.postMessage({
        channel,
        text,
        thread_ts: threadTs,
      });
      const channelId = (result.channel as string) || channel;
      const ts = (result.ts as string) || '';
      let permalink: string | undefined;
      try {
        const perm = await this.app.client.chat.getPermalink({
          channel: channelId,
          message_ts: ts,
        });
        permalink = perm.permalink as string | undefined;
      } catch {
        // permalink is best-effort
      }
      return { ok: true, channel: channelId, ts, permalink };
    } catch (err) {
      const slackErr = err as {
        data?: { error?: string };
        code?: string;
        message?: string;
      };
      const errorCode =
        slackErr?.data?.error ??
        slackErr?.code ??
        slackErr?.message ??
        'unknown_error';
      const hints: Record<string, string> = {
        not_in_channel: `Ask the human operator to /invite this bot to ${channel}, or use send_message to a peer who is in it.`,
        channel_not_found: `Channel "${channel}" does not exist or the bot can't see it. Verify the ID/name and that the bot is in the same workspace.`,
        is_archived: `Channel "${channel}" is archived. Pick an active channel.`,
        msg_too_long: `Message too long for Slack (max ~40k). Split into smaller messages.`,
        rate_limited: `Slack rate-limited the post. Back off and retry after the Retry-After interval.`,
        invalid_auth: `Slack bot token is invalid or revoked. Surface to the operator — bot needs reauth.`,
        not_authed: `Slack bot is not authenticated. Surface to operator.`,
        token_revoked: `Slack token revoked. Surface to operator — bot needs reauth.`,
      };
      return {
        ok: false,
        channel,
        error: errorCode,
        hint:
          hints[errorCode] ??
          `Slack API returned "${errorCode}". Check Slack logs.`,
      };
    }
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
    await this.app.stop();
  }

  // Slack has no native typing indicator API for bots.
  // Instead, add/remove a 👀 reaction on the latest inbound (human) message
  // so the sender gets instant visual feedback that the bot saw it.
  // No-op if no human message has been tracked for the jid yet.
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const ts = this.lastInboundTs.get(jid);
    if (!ts) return;
    const channelId = jid.replace(/^slack:/, '');
    try {
      if (isTyping) {
        await this.app.client.reactions.add({
          channel: channelId,
          timestamp: ts,
          name: 'eyes',
        });
      } else {
        await this.app.client.reactions.remove({
          channel: channelId,
          timestamp: ts,
          name: 'eyes',
        });
        this.lastInboundTs.delete(jid);
      }
    } catch (err) {
      // Ignore already_reacted / not_reacted — reaction state is best-effort
      logger.debug(
        { jid, isTyping, err },
        'Slack typing reaction failed (non-fatal)',
      );
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
