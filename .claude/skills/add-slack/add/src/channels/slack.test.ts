import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  getLastGroupSync: vi.fn().mockReturnValue(null),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
  updateRegisteredGroupName: vi.fn(),
}));
type Handler = (payload: { event: Record<string, unknown> }) => Promise<void>;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    opts: Record<string, unknown>;
    eventHandlers = new Map<string, Handler[]>();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      on: vi.fn(),
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue(undefined),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [
            { id: 'C123', name: 'general' },
            { id: 'C456', name: 'random' },
          ],
          response_metadata: { next_cursor: '' },
        }),
        info: vi.fn().mockResolvedValue({
          channel: { id: 'C123', name: 'general', is_im: false, is_mpim: false },
        }),
      },
    };
    receiver: { on?: (event: string, fn: () => void) => void } = {};

    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      appRef.current = this;
    }

    event(name: string, handler: Handler): void {
      const existing = this.eventHandlers.get(name) || [];
      existing.push(handler);
      this.eventHandlers.set(name, existing);
    }
  },
}));
vi.mock('@slack/web-api', () => ({
  WebClientEvent: { RATE_LIMITED: 'rate_limited' },
}));

import { SlackChannel, SlackChannelOpts } from './slack.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
  updateRegisteredGroupName,
} from '../db.js';
import { logger } from '../logger.js';

function createOpts(overrides?: Partial<SlackChannelOpts>): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C123': {
        name: 'Slack Group',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

async function emitEvent(
  name: string,
  event: Record<string, unknown>,
): Promise<void> {
  const handlers = appRef.current.eventHandlers.get(name) || [];
  for (const handler of handlers) {
    await handler({ event });
  }
}

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates instance with correct name', () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    expect(channel.name).toBe('slack');
  });

  it('isConnected returns false before connect', () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    expect(channel.isConnected()).toBe(false);
  });

  it('connect registers handlers and flips connected state', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());

    await channel.connect();

    expect(channel.isConnected()).toBe(true);
    expect(appRef.current.start).toHaveBeenCalledTimes(1);
    expect(appRef.current.eventHandlers.has('app_mention')).toBe(true);
    expect(appRef.current.eventHandlers.has('message')).toBe(true);
  });

  it('connect does not pass signingSecret to App', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    await channel.connect();
    expect(appRef.current.opts.signingSecret).toBeUndefined();
  });

  it('configures retry policy with minimal Bolt retries', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    await channel.connect();

    const opts = appRef.current.opts as {
      clientOptions: {
        retryConfig: { retries: number; factor: number; randomize: boolean };
        rejectRateLimitedCalls: boolean;
      };
    };

    expect(opts.clientOptions.retryConfig.retries).toBe(1);
    expect(opts.clientOptions.retryConfig.factor).toBe(1);
    expect(opts.clientOptions.retryConfig.randomize).toBe(false);
    expect(opts.clientOptions.rejectRateLimitedCalls).toBe(false);
  });

  it('ownsJid returns true for slack: prefix', () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    expect(channel.ownsJid('slack:C123')).toBe(true);
  });

  it('ownsJid returns false for other prefixes', () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    expect(channel.ownsJid('tg:123')).toBe(false);
  });

  it('sendMessage strips slack: prefix', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    await channel.connect();

    await channel.sendMessage('slack:C123', 'hello');

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: 'hello',
    });
  });

  it('sends exactly 40000 chars as single message', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    await channel.connect();

    await channel.sendMessage('slack:C123', 'x'.repeat(40000));

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('sends 40001 chars as two messages', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    await channel.connect();

    await channel.sendMessage('slack:C123', 'x'.repeat(40001));

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it('sends 120001 chars as four messages', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    await channel.connect();

    await channel.sendMessage('slack:C123', 'x'.repeat(120001));

    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledTimes(4);
  });

  it('logs structured error on send failure and re-throws', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    await channel.connect();
    const err = { code: 429, message: 'rate limited' };
    appRef.current.client.chat.postMessage.mockRejectedValueOnce(err);
    await expect(channel.sendMessage('slack:C123', 'hello')).rejects.toEqual(err);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'slack_send_failed',
        jid: 'slack:C123',
        status_code: 429,
        length: 5,
        err,
      }),
      'Failed to send Slack message after retries',
    );
  });

  it.todo('Bolt WebClient handles 429 Retry-After internally');

  it('sendMessage throws on failure so caller knows delivery failed', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    await channel.connect();
    const err = new Error('network error');
    appRef.current.client.chat.postMessage.mockRejectedValueOnce(err);
    await expect(channel.sendMessage('slack:C123', 'hello')).rejects.toThrow('network error');
  });

  it('stores inbound message for registered channel and translates mention trigger', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('app_mention', {
      channel: 'C123',
      user: 'U123',
      text: '<@U_BOT> hello',
      ts: '1704067200.000001',
      client_msg_id: 'm1',
    });

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'slack:C123',
      '2024-01-01T00:00:00.000Z|1704067200.000001',
      undefined,
      'slack',
      true,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'slack:C123',
      expect.objectContaining({
        id: 'm1',
        content: '@Andy <@U_BOT> hello',
      }),
    );
  });

  it('ignores inbound message from unregistered channel', async () => {
    const opts = createOpts({ registeredGroups: vi.fn(() => ({})) });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C999',
      user: 'U123',
      text: 'hello',
      ts: '1704067200.000001',
      client_msg_id: 'm2',
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('disconnect stops app and sets disconnected state', async () => {
    const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
    await channel.connect();

    await channel.disconnect();

    expect(appRef.current.stop).toHaveBeenCalledTimes(1);
    expect(channel.isConnected()).toBe(false);
  });

  it('filters message_changed subtype', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C123',
      user: 'U123',
      text: 'edited message',
      ts: '1704067200.000002',
      subtype: 'message_changed',
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(opts.onChatMetadata).not.toHaveBeenCalled();
  });

  it('filters message_deleted subtype', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C123',
      ts: '1704067200.000003',
      subtype: 'message_deleted',
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(opts.onChatMetadata).not.toHaveBeenCalled();
  });

  it('filters channel_join subtype', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C123',
      user: 'U123',
      ts: '1704067200.000004',
      subtype: 'channel_join',
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(opts.onChatMetadata).not.toHaveBeenCalled();
  });

  it('filters bot_message subtype', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C123',
      bot_id: 'B123',
      text: 'bot says hi',
      ts: '1704067200.000005',
      subtype: 'bot_message',
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(opts.onChatMetadata).not.toHaveBeenCalled();
  });

  it('filters bot own messages by user ID', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C123',
      user: 'U_BOT',
      text: 'I said this',
      ts: '1704067200.000006',
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('filters all bot messages when filterBotMessages is true', async () => {
    const opts = createOpts({ filterBotMessages: true });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C123',
      user: 'U_OTHER',
      bot_id: 'B123',
      text: 'another bot',
      ts: '1704067200.000007',
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('allows other bot messages when filterBotMessages is false', async () => {
    const opts = createOpts({ filterBotMessages: false });
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C123',
      user: 'U_OTHER',
      bot_id: 'B123',
      text: 'another bot message',
      ts: '1704067200.000008',
    });

    expect(opts.onMessage).toHaveBeenCalled();
  });

  it('deduplicates events with same channel:ts key', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    const event = {
      channel: 'C123',
      user: 'U123',
      text: 'hello',
      ts: '1704067200.000009',
      client_msg_id: 'dup1',
    };

    await emitEvent('message', event);
    await emitEvent('message', event);

    expect(opts.onMessage).toHaveBeenCalledTimes(1);
  });

  it('allows events with different ts', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C123',
      user: 'U123',
      text: 'first',
      ts: '1704067200.000010',
      client_msg_id: 'msg10',
    });

    await emitEvent('message', {
      channel: 'C123',
      user: 'U123',
      text: 'second',
      ts: '1704067200.000011',
      client_msg_id: 'msg11',
    });

    expect(opts.onMessage).toHaveBeenCalledTimes(2);
  });

  it('responds to !chatid command with channel name', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C123',
      user: 'U123',
      text: '!chatid',
      ts: '1704067200.000012',
    });

    expect(appRef.current.client.conversations.info).toHaveBeenCalledWith({
      channel: 'C123',
    });
    expect(appRef.current.client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: 'Chat ID: slack:C123 (general)',
    });
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('filters URL unfurl message_changed events', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();

    await emitEvent('message', {
      channel: 'C123',
      ts: '1704067200.000013',
      subtype: 'message_changed',
      message: {
        text: 'https://example.com',
        attachments: [{ title: 'Example' }],
      },
      previous_message: { text: 'https://example.com' },
    });

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(opts.onChatMetadata).not.toHaveBeenCalled();
  });
  describe('token lifecycle events', () => {
    it('handles tokens_revoked by disconnecting', async () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await emitEvent('tokens_revoked', {});
      expect(appRef.current.stop).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(false);
    });
    it('handles app_uninstalled by disconnecting', async () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await emitEvent('app_uninstalled', {});
      expect(appRef.current.stop).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(false);
    });
  });
  describe('socket watchdog', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    it('starts watchdog timer on connect', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    });
    it('triggers reconnect when socket is stale', async () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(appRef.current.stop).toHaveBeenCalled();
      expect(appRef.current.start).toHaveBeenCalledTimes(2);
    });
    it('clears watchdog on disconnect', async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      await channel.disconnect();
      expect(clearIntervalSpy).toHaveBeenCalled();
    });
    it('logs structured diagnostics on stale detection', async () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'socket_stale' }),
        expect.any(String),
      );
    });
    it('logs structured diagnostics on successful reconnect', async () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'socket_reconnect' }),
        expect.any(String),
      );
    });
  });
  it('updates lastEventTs on inbound events', async () => {
    const opts = createOpts();
    const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
    await channel.connect();
    await emitEvent('message', {
      channel: 'C123',
      user: 'U123',
      text: 'hello',
      ts: '1704067200.000099',
      client_msg_id: 'ts-test',
    });
    expect(opts.onMessage).toHaveBeenCalled();
  });
  describe('timestamp precision', () => {
    it('preserves full Slack ts precision in ISO timestamp', async () => {
      const opts = createOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await emitEvent('message', {
        channel: 'C123',
        user: 'U123',
        text: 'burst message 1',
        ts: '1704067200.123456',
        client_msg_id: 'burst1',
      });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C123',
        expect.stringContaining('|1704067200.123456'),
        undefined,
        'slack',
        true,
      );
    });

    it('allows same-millisecond messages with different microsecond precision', async () => {
      const opts = createOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      // Two messages in same millisecond but different microseconds
      await emitEvent('message', {
        channel: 'C123',
        user: 'U123',
        text: 'burst message 1',
        ts: '1704067200.123456',
        client_msg_id: 'burst1',
      });

      await emitEvent('message', {
        channel: 'C123',
        user: 'U123',
        text: 'burst message 2',
        ts: '1704067200.123789',
        client_msg_id: 'burst2',
      });

      // Both should be processed (different ts = different dedup keys)
      expect(opts.onMessage).toHaveBeenCalledTimes(2);
      expect(opts.onMessage).toHaveBeenNthCalledWith(
        1,
        'slack:C123',
        expect.objectContaining({ id: 'burst1' }),
      );
      expect(opts.onMessage).toHaveBeenNthCalledWith(
        2,
        'slack:C123',
        expect.objectContaining({ id: 'burst2' }),
      );
    });

    it('deduplicates identical ts values even with microsecond precision', async () => {
      const opts = createOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = {
        channel: 'C123',
        user: 'U123',
        text: 'duplicate burst',
        ts: '1704067200.123456',
        client_msg_id: 'dup-burst',
      };

      // Send same event twice
      await emitEvent('message', event);
      await emitEvent('message', event);

      // Only first should be processed (dedup catches second)
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });
  });
  describe('watchdog reliability', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    it('does not reconnect before 12-minute stale threshold, reconnects after', async () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      const stopSpy = appRef.current.stop;
      // Advance 11 minutes — below 12-minute threshold
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(stopSpy).not.toHaveBeenCalled();
      // Advance 2 more minutes — now 13 minutes total, above threshold
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stopSpy).toHaveBeenCalled();
    });
    it('socket heartbeat prevents stale detection', async () => {
      const receiverHandlers: Record<string, (() => void)[]> = {};
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      // connect() calls new App() synchronously (sets appRef.current), then awaits start()
      // We start the connect promise, then install receiver.on before start() resolves
      const connectPromise = channel.connect();
      // appRef.current is set synchronously in MockApp constructor
      appRef.current.receiver.on = (event: string, fn: () => void) => {
        receiverHandlers[event] = receiverHandlers[event] || [];
        receiverHandlers[event].push(fn);
      };
      await connectPromise;
      const stopSpy = appRef.current.stop;
      // Advance 11 minutes — below threshold
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(stopSpy).not.toHaveBeenCalled();
      // Fire the 'connected' socket heartbeat — resets lastEventTs
      (receiverHandlers['connected'] || []).forEach((fn) => fn());
      // Advance 11 more minutes from heartbeat — still under 12-minute threshold
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(stopSpy).not.toHaveBeenCalled();
    });
    it('reentrancy guard prevents concurrent reconnects', async () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      // Make stop() never resolve — simulates a slow reconnect stuck in flight
      appRef.current.stop.mockReturnValue(new Promise<void>(() => {}));
      // Advance past stale threshold — triggers first reconnect (isReconnecting = true)
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      // Advance another watchdog tick — should be skipped due to reentrancy guard
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'reconnect_skipped',
          reason: 'in_flight',
        }),
        expect.any(String),
      );
      // stop() called only once — second tick was skipped
      expect(appRef.current.stop).toHaveBeenCalledTimes(1);
    });
    it('exponential backoff delays increase between reconnect attempts', async () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      // Force start() to always reject so reconnects fail and attempt counter increments
      appRef.current.start.mockRejectedValue(new Error('connect failed'));
      // First attempt: advance past stale threshold
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      // attempt=1: baseDelay=5000 * 2^0 = 5000ms, jitter ±20% → [4000, 6000]
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'socket_stale',
          reconnect_attempt: 1,
          backoff_delay_ms: expect.toSatisfy(
            (v: number) => v >= 4000 && v <= 6000,
          ),
        }),
        expect.any(String),
      );
      // Second attempt: advance another full stale window
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      // attempt=2: baseDelay=5000 * 2^1 = 10000ms, jitter ±20% → [8000, 12000]
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'socket_stale',
          reconnect_attempt: 2,
          backoff_delay_ms: expect.toSatisfy(
            (v: number) => v >= 8000 && v <= 12000,
          ),
        }),
        expect.any(String),
      );
    });
    it('circuit breaker opens after max retries and calls process.exit(1)', async () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      // Force start() to always reject
      appRef.current.start.mockRejectedValue(new Error('connect failed'));
      // Trigger 6 watchdog ticks — maxAttempts=5, so attempt 6 exceeds limit
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      }
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'breaker_open' }),
        expect.any(String),
      );
      expect(process.exit).toHaveBeenCalledWith(1);
    });
    it('retry counter resets to 0 after successful reconnect', async () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts(),
      );
      await channel.connect();
      // Fail twice, then succeed on third attempt
      appRef.current.start
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue(undefined);
      // Two failed attempts
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      // Successful reconnect — resets reconnectAttempt to 0
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      // Now force failures again — next attempt should start from 1, not 3
      appRef.current.start.mockRejectedValue(new Error('fail again'));
      vi.clearAllMocks();
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'socket_stale',
          reconnect_attempt: 1,
        }),
        expect.any(String),
      );
    });
    it('calls onRecovery callback after successful reconnect', async () => {
      const onRecovery = vi.fn();
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts({ onRecovery }),
      );
      await channel.connect();
      // Advance past stale threshold — triggers reconnect (start() succeeds by default)
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      // Wait for backoff delay (attempt 1: ~5000ms)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onRecovery).toHaveBeenCalledTimes(1);
    });
    it('recovery callback is idempotent (multiple calls safe)', async () => {
      const onRecovery = vi.fn();
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts({ onRecovery }),
      );
      await channel.connect();
      // Trigger two successful reconnects
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(10_000);
      // Both calls should succeed without error
      expect(onRecovery).toHaveBeenCalledTimes(2);
    });
    it('logs error if onRecovery callback throws but does not propagate', async () => {
      const onRecovery = vi.fn().mockImplementation(() => {
        throw new Error('callback error');
      });
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createOpts({ onRecovery }),
      );
      await channel.connect();
      // Should not throw even if callback throws
      await vi.advanceTimersByTimeAsync(13 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'recovery_callback_error' }),
        'Recovery callback failed',
      );
    });
  });

  describe('syncChannelMetadata', () => {
    const createChannel = () =>
      new SlackChannel('xoxb-token', 'xapp-token', createOpts());

    const connectChannel = async () => {
      const channel = createChannel();
      await channel.connect();
      return channel;
    };

    it('fetches channels and updates names', async () => {
      const channel = await connectChannel();
      await channel.syncChannelMetadata(true);

      expect(appRef.current.client.conversations.list).toHaveBeenCalledWith(
        expect.objectContaining({
          types: 'public_channel,private_channel',
          exclude_archived: true,
        }),
      );
      expect(updateChatName).toHaveBeenCalledWith('slack:C123', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C456', 'random');
      expect(updateRegisteredGroupName).toHaveBeenCalledWith(
        'slack:C123',
        'general',
      );
      expect(updateRegisteredGroupName).not.toHaveBeenCalledWith(
        'slack:C456',
        expect.any(String),
      );
      expect(setLastGroupSync).toHaveBeenCalledWith('__slack_sync__');
    });

    it('skips when not connected', async () => {
      const channel = createChannel();
      await channel.syncChannelMetadata(true);
      expect(
        appRef.current?.client?.conversations?.list,
      ).not.toHaveBeenCalled();
    });

    it('handles API errors gracefully', async () => {
      const channel = await connectChannel();
      appRef.current.client.conversations.list.mockRejectedValueOnce(
        new Error('rate limited'),
      );
      await expect(channel.syncChannelMetadata(true)).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to sync Slack channel metadata',
      );
    });

    it('respects 24h cache when force=false', async () => {
      const channel = await connectChannel();
      // Reset call count after connect()'s initial sync
      vi.mocked(appRef.current.client.conversations.list).mockClear();
      vi.mocked(getLastGroupSync).mockReturnValueOnce(new Date().toISOString());
      await channel.syncChannelMetadata(false);
      expect(appRef.current.client.conversations.list).not.toHaveBeenCalled();
    });

    it('bypasses cache when force=true', async () => {
      const channel = await connectChannel();
      vi.mocked(getLastGroupSync).mockReturnValueOnce(new Date().toISOString());
      await channel.syncChannelMetadata(true);
      expect(appRef.current.client.conversations.list).toHaveBeenCalled();
    });

    it('handles paginated conversations.list responses', async () => {
      const channel = await connectChannel();
      vi.mocked(appRef.current.client.conversations.list).mockClear();
      vi.mocked(updateChatName).mockClear();
      vi.mocked(updateRegisteredGroupName).mockClear();
      vi.mocked(setLastGroupSync).mockClear();

      vi.mocked(appRef.current.client.conversations.list)
        .mockResolvedValueOnce({
          channels: [{ id: 'C100', name: 'page1-chan' }],
          response_metadata: { next_cursor: 'cursor_abc' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C200', name: 'page2-chan' }],
          response_metadata: { next_cursor: '' },
        });

      await channel.syncChannelMetadata(true);

      expect(appRef.current.client.conversations.list).toHaveBeenCalledTimes(2);
      expect(updateChatName).toHaveBeenCalledWith('slack:C100', 'page1-chan');
      expect(updateChatName).toHaveBeenCalledWith('slack:C200', 'page2-chan');
      expect(setLastGroupSync).toHaveBeenCalledWith('__slack_sync__');
    });

    it('triggers sync on connect', async () => {
      const channel = createChannel();
      await channel.connect();

      expect(appRef.current.client.conversations.list).toHaveBeenCalled();
    });

    it('clears sync timer on disconnect', async () => {
      const channel = await connectChannel();

      expect((channel as any).syncTimerStarted).toBe(true);
      expect((channel as any).syncTimer).not.toBeNull();

      await channel.disconnect();

      expect((channel as any).syncTimerStarted).toBe(false);
      expect((channel as any).syncTimer).toBeNull();
    });
  });

  describe('resolveChannelName', () => {
    it('resolves public channel name', async () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
      await channel.connect();

      appRef.current.client.conversations.info.mockResolvedValueOnce({
        channel: { id: 'C123', name: 'general', is_im: false, is_mpim: false },
      });

      const name = await channel.resolveChannelName('C123');
      expect(name).toBe('general');
    });

    it('returns dm- prefix for DMs', async () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
      await channel.connect();

      appRef.current.client.conversations.info.mockResolvedValueOnce({
        channel: { id: 'D123', is_im: true, user: 'U456' },
      });

      const name = await channel.resolveChannelName('D123');
      expect(name).toBe('dm-U456');
    });

    it('falls back to channelId on error', async () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
      await channel.connect();

      appRef.current.client.conversations.info.mockRejectedValueOnce(
        new Error('not_found'),
      );

      const name = await channel.resolveChannelName('C999');
      expect(name).toBe('C999');
    });

    it('returns channelId when not connected', async () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createOpts());
      // Don't connect
      const name = await channel.resolveChannelName('C123');
      expect(name).toBe('C123');
    });
  });
});
