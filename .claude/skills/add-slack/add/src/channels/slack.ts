import { App } from '@slack/bolt';
import { WebClientEvent } from '@slack/web-api';

import { calculateBackoff } from './reconnect-policy.js';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
  updateRegisteredGroupName,
} from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const SLACK_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const SLACK_SYNC_SENTINEL = '__slack_sync__';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  filterBotMessages?: boolean; // default true
  onRecovery?: () => void; // Called when Slack reconnects after outage
}

export class SlackChannel implements Channel {
  name = 'slack';
  private app: App | null = null;
  private connected = false;
  private opts: SlackChannelOpts;
  private botToken: string;
  private appToken: string;
  private botUserId = '';
  private safeMode = false;
  private seenEvents = new Map<string, number>(); // key → expiry timestamp
  private lastEventTs = Date.now();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimerStarted = false;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private isReconnecting = false;
  private breakerOpen = false;
  private readonly STALE_THRESHOLD = 12 * 60 * 1000; // 12 minutes (low-traffic safe)

  constructor(botToken: string, appToken: string, opts: SlackChannelOpts) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.opts = opts;
  }
  async connect(): Promise<void> {
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      clientOptions: {
        retryConfig: {
          retries: 1, // Minimal Bolt-level retries; watchdog manages reconnection
          factor: 1,
          randomize: false,
        },
        rejectRateLimitedCalls: false,
      },
    });

    this.app.event('app_mention', async ({ event }: { event: unknown }) => {
      this.lastEventTs = Date.now();
      await this.handleInboundEvent(event as Record<string, unknown>, true);
    });
    this.app.event('message', async ({ event }: { event: unknown }) => {
      this.lastEventTs = Date.now();
      await this.handleInboundEvent(event as Record<string, unknown>, false);
    });
    this.app.event('tokens_revoked', async () => {
      this.lastEventTs = Date.now();
      logger.warn(
        { event: 'token_revoked' },
        'Slack tokens revoked — disconnecting',
      );
      await this.disconnect();
    });
    this.app.event('app_uninstalled', async () => {
      this.lastEventTs = Date.now();
      logger.warn(
        { event: 'app_uninstalled' },
        'Slack app uninstalled — disconnecting',
      );
      await this.disconnect();
    });

    await this.app.start();
    // Socket-level liveness: update lastEventTs on connection events
    // Bolt's SocketModeReceiver is an EventEmitter
    const receiver = (
      this.app as unknown as {
        receiver?: { on?: (event: string, fn: () => void) => void };
      }
    ).receiver;
    if (receiver?.on) {
      receiver.on('connected', () => {
        this.lastEventTs = Date.now();
        logger.info(
          { event: 'socket_connected', liveness_source: 'socket_event' },
          'Socket connected',
        );
      });
      receiver.on('disconnected', () => {
        logger.warn(
          { event: 'socket_disconnected', liveness_source: 'socket_event' },
          'Socket disconnected',
        );
      });
    }

    this.app.client.on(
      WebClientEvent.RATE_LIMITED,
      (retryAfter: number, { url }: { url: string }) => {
        logger.warn(
          { event: 'slack_rate_limited', retry_after_s: retryAfter, url },
          'Slack rate limited',
        );
      },
    );

    try {
      const auth = await this.app.client.auth.test({});
      this.botUserId = (auth.user_id as string | undefined) || '';
    } catch (err) {
      logger.error({ err }, 'Slack auth.test failed; entering safe mode');
      this.safeMode = true;
    }

    this.connected = true;
    logger.info('Slack bot connected via Socket Mode');
    this.startWatchdog();
    // Sync channel metadata on startup (respects 24h cache)
    this.syncChannelMetadata().catch((err) =>
      logger.error({ err }, 'Initial Slack channel sync failed'),
    );
    // Set up daily sync timer (only once)
    if (!this.syncTimerStarted) {
      this.syncTimerStarted = true;
      this.syncTimer = setInterval(() => {
        this.syncChannelMetadata().catch((err) =>
          logger.error({ err }, 'Periodic Slack channel sync failed'),
        );
      }, SLACK_SYNC_INTERVAL_MS);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app || !this.connected) {
      logger.warn({ jid }, 'Slack app not initialized');
      return;
    }

    const channelId = jid.replace(/^slack:/, '');
    const MAX_LENGTH = 40_000;

    try {
      if (text.length <= MAX_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err: unknown) {
      const statusCode = (err as { code?: number })?.code;
      logger.error(
        {
          event: 'slack_send_failed',
          jid,
          status_code: statusCode,
          length: text.length,
          err,
        },
        'Failed to send Slack message after retries',
      );
      throw err; // Re-throw so caller knows delivery failed
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
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.syncTimerStarted = false;
    if (!this.app) return;
    await this.app.stop();
    this.app = null;
    logger.info('Slack bot stopped');
  }

  async syncChannelMetadata(force = false): Promise<void> {
    if (!this.app || !this.connected) return;

    if (!force) {
      const lastSync = getLastGroupSync(SLACK_SYNC_SENTINEL);
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < SLACK_SYNC_INTERVAL_MS) {
          logger.debug(
            { lastSync },
            'Skipping Slack channel sync - synced recently',
          );
          return;
        }
      }
    }

    try {
      logger.info('Syncing channel metadata from Slack...');
      const registeredGroups = this.opts.registeredGroups();
      let count = 0;
      let cursor: string | undefined;

      do {
        const result: {
          channels?: Array<{ id?: string; name?: string }>;
          response_metadata?: { next_cursor?: string };
        } = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const channel of result.channels || []) {
          if (!channel.id || !channel.name) continue;
          const jid = `slack:${channel.id}`;
          updateChatName(jid, channel.name);
          if (registeredGroups[jid]) {
            updateRegisteredGroupName(jid, channel.name);
          }
          count++;
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      setLastGroupSync(SLACK_SYNC_SENTINEL);
      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  /**
   * Resolve a Slack channel's display name from its ID via conversations.info.
   * Returns the channel name for public/private channels, a fallback for DMs/MPIMs,
   * or the raw channel ID if the lookup fails.
   */
  async resolveChannelName(channelId: string): Promise<string> {
    if (!this.app || !this.connected) return channelId;
    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      const ch = result.channel as
        | { name?: string; is_im?: boolean; is_mpim?: boolean; user?: string }
        | undefined;
      if (!ch) return channelId;
      if (ch.is_im) return `dm-${ch.user || channelId}`;
      if (ch.is_mpim) return ch.name || `mpim-${channelId}`;
      return ch.name || channelId;
    } catch (err) {
      logger.warn({ channelId, err }, 'Failed to resolve Slack channel name');
      return channelId;
    }
  }

  async setTyping(jid: string, _isTyping: boolean): Promise<void> {
    // Note: Slack doesn't have a direct 'typing' indicator API for bots.
    // This is a no-op or could post a temporary status message.
    void jid;
  }
  private startWatchdog(): void {
    this.watchdogTimer = setInterval(async () => {
      if (!this.connected || !this.app) return;
      if (this.isReconnecting) {
        logger.debug(
          { event: 'reconnect_skipped', reason: 'in_flight' },
          'Watchdog: reconnect in flight, skipping',
        );
        return;
      }
      if (this.breakerOpen) {
        logger.debug(
          { event: 'reconnect_skipped', reason: 'breaker_open' },
          'Watchdog: breaker open, skipping',
        );
        return;
      }
      const staleDuration = Date.now() - this.lastEventTs;
      if (staleDuration <= this.STALE_THRESHOLD) return;
      this.reconnectAttempt++;
      const { delay_ms, should_retry } = calculateBackoff(
        this.reconnectAttempt,
      );

      if (!should_retry) {
        this.breakerOpen = true;
        logger.error(
          {
            event: 'breaker_open',
            attempt: this.reconnectAttempt,
            stale_duration_ms: staleDuration,
            breaker_state: 'open',
          },
          'Circuit breaker opened — max reconnect retries exceeded. Exiting for supervisor restart.',
        );
        process.exit(1);
        return;
      }

      logger.warn(
        {
          event: 'socket_stale',
          last_event_ts: this.lastEventTs,
          reconnect_attempt: this.reconnectAttempt,
          stale_duration_ms: staleDuration,
          backoff_delay_ms: delay_ms,
          breaker_state: 'closed',
          liveness_source: 'watchdog',
        },
        `Socket stale for ${Math.round(staleDuration / 1000)}s — attempt ${this.reconnectAttempt} (backoff ${delay_ms}ms)`,
      );

      this.isReconnecting = true;
      const reconnectStart = Date.now();
      try {
        await new Promise((resolve) => setTimeout(resolve, delay_ms));
        await this.app.stop();
        await this.app.start();
        const duration = Date.now() - reconnectStart;
        this.lastEventTs = Date.now();
        logger.info(
          {
            event: 'socket_reconnect',
            reconnect_attempt: this.reconnectAttempt,
            duration_ms: duration,
            breaker_state: 'closed',
          },
          `Reconnected in ${duration}ms`,
        );
        this.reconnectAttempt = 0;
        // Emit recovery signal for exhausted groups
        try {
          this.opts.onRecovery?.();
        } catch (recoveryErr) {
          logger.error({ err: recoveryErr, event: 'recovery_callback_error' }, 'Recovery callback failed');
        }
      } catch (err) {
        const duration = Date.now() - reconnectStart;
        logger.error(
          {
            event: 'socket_reconnect_failed',
            reconnect_attempt: this.reconnectAttempt,
            duration_ms: duration,
            breaker_state: 'closed',
            error: err instanceof Error ? err.message : String(err),
          },
          `Reconnect failed after ${duration}ms`,
        );
      } finally {
        this.isReconnecting = false;
      }
    }, 60_000);
  }

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    // Cleanup expired entries periodically
    if (this.seenEvents.size > 1000) {
      for (const [k, expiry] of this.seenEvents) {
        if (expiry < now) this.seenEvents.delete(k);
      }
    }
    if (this.seenEvents.has(key) && this.seenEvents.get(key)! > now)
      return true;
    this.seenEvents.set(key, now + 5 * 60 * 1000); // 5 min TTL
    return false;
  }

  private async handleInboundEvent(
    event: Record<string, unknown>,
    fromMentionEvent: boolean,
  ): Promise<void> {
    // Filter ALL messages with any subtype — only process plain user messages
    if (event.subtype !== undefined) return;

    // Filter bot's own messages to prevent self-loop
    const sender = (event.user as string | undefined) || '';
    if (sender === this.botUserId && this.botUserId !== '') return;

    // Filter bot messages based on filterBotMessages option (default: true)
    if (event.bot_id) {
      if (!this.safeMode && this.opts.filterBotMessages === false) {
        // Allow other bot messages only when explicitly opted out and not in safe mode
      } else {
        return; // default: filter all bots (or safe mode: always filter)
      }
    }

    const channelId = (event.channel as string | undefined) || '';
    if (!channelId) return;

    const chatJid = `slack:${channelId}`;

    // TTL deduplication
    const dedupKey = `${channelId}:${event.ts as string}`;
    if (this.isDuplicate(dedupKey)) return;

    const timestamp = this.toIsoTimestamp(event.ts as string | undefined);
    const isGroup = channelId.startsWith('C') || channelId.startsWith('G');
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', isGroup);

    const senderName = sender || 'Unknown';
    const msgId =
      (event.client_msg_id as string | undefined) ||
      (event.ts as string | undefined) ||
      `${Date.now()}`;

    let content = this.extractContent(event);
    if (!content) return;

    // !chatid command — must work before group registration check (bootstrap)
    if (content === '!chatid') {
      const channelId = chatJid.replace(/^slack:/, '');
      const name = await this.resolveChannelName(channelId);
      await this.sendMessage(chatJid, `Chat ID: ${chatJid} (${name})`);
      return;
    }

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Slack chat');
      return;
    }

    const mentionsBot =
      fromMentionEvent ||
      (this.botUserId && !this.safeMode
        ? content.includes(`<@${this.botUserId}>`)
        : false);
    if (mentionsBot && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  private extractContent(event: Record<string, unknown>): string {
    const text = (event.text as string | undefined)?.trim();
    if (text) return text;

    const files = event.files as Array<{ name?: string }> | undefined;
    if (files && files.length > 0) {
      const names = files.map((f) => f.name || 'file').join(', ');
      return `[File: ${names}]`;
    }

    return '[Non-text message]';
  }

  private toIsoTimestamp(ts: string | undefined): string {
    if (!ts) return new Date().toISOString();
    const seconds = parseFloat(ts);
    if (Number.isNaN(seconds)) return new Date().toISOString();
    // Preserve full Slack ts precision by appending the raw ts as a suffix.
    // This ensures same-millisecond messages remain uniquely ordered.
    const isoBase = new Date(seconds * 1000).toISOString();
    return `${isoBase}|${ts}`;
  }
}
