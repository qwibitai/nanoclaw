import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- @slack/bolt mock ---

type Handler = (...args: any[]) => any;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => {
  const LogLevel = { ERROR: 'error' };

  class MockApp {
    eventHandlers = new Map<string, Handler>();
    private _started = false;

    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'UBOTID123' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: {
            profile: { display_name: 'Test User' },
            real_name: 'Test User Real',
            name: 'testuser',
          },
        }),
      },
      conversations: {
        info: vi.fn().mockResolvedValue({
          channel: { name: 'general' },
        }),
      },
    };

    constructor(_opts: any) {
      appRef.current = this;
    }

    event(eventName: string, handler: Handler) {
      this.eventHandlers.set(eventName, handler);
    }

    async start() {
      this._started = true;
    }

    async stop() {
      this._started = false;
    }

    isStarted() {
      return this._started;
    }
  }

  return {
    App: MockApp,
    LogLevel,
  };
});

import { SlackChannel, SlackChannelOpts } from './slack.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C1234567890': {
        name: '#general',
        folder: 'slack-general',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function currentApp() {
  return appRef.current;
}

async function triggerAppMention(event: Record<string, any>) {
  const handler = currentApp().eventHandlers.get('app_mention');
  if (handler) await handler({ event });
}

async function triggerMessageEvent(event: Record<string, any>) {
  const handler = currentApp().eventHandlers.get('message');
  if (handler) await handler({ event });
}

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when app starts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('calls auth.test to get bot user ID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      await channel.connect();

      expect(currentApp().client.auth.test).toHaveBeenCalledWith({
        token: 'xoxb-token',
      });
    });

    it('registers event handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      await channel.connect();

      expect(currentApp().eventHandlers.has('app_mention')).toBe(true);
      expect(currentApp().eventHandlers.has('message')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- App mention handling ---

  describe('app_mention handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await triggerAppMention({
        user: 'U12345',
        channel: 'C1234567890',
        text: '<@UBOTID123> what time is it?',
        ts: '1704067200.000000',
      });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C1234567890',
        expect.any(String),
        '#general',
        'slack',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C1234567890',
        expect.objectContaining({
          id: '1704067200.000000',
          chat_jid: 'slack:C1234567890',
          sender: 'U12345',
          sender_name: 'Test User',
          content: '@Andy what time is it?',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await triggerAppMention({
        user: 'U12345',
        channel: 'C9999999999',
        text: '<@UBOTID123> hello',
        ts: '1704067200.000000',
      });

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('translates bot mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await triggerAppMention({
        user: 'U12345',
        channel: 'C1234567890',
        text: '<@UBOTID123> check this',
        ts: '1704067200.000000',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C1234567890',
        expect.objectContaining({
          content: '@Andy check this',
        }),
      );
    });

    it('does not double-prepend trigger if already present', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await triggerAppMention({
        user: 'U12345',
        channel: 'C1234567890',
        text: '@Andy hello <@UBOTID123>',
        ts: '1704067200.000000',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C1234567890',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });
  });

  // --- DM handling ---

  describe('DM handling', () => {
    it('handles direct messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:D5555555555': {
            name: 'DM',
            folder: 'slack-dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await triggerMessageEvent({
        user: 'U12345',
        channel: 'D5555555555',
        channel_type: 'im',
        text: 'hello',
        ts: '1704067200.000000',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:D5555555555',
        expect.objectContaining({
          content: '@Andy hello',
          sender_name: 'Test User',
        }),
      );
    });

    it('ignores bot messages in DMs', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      // Message from bot itself should be ignored (user === botUserId)
      await triggerMessageEvent({
        user: 'UBOTID123',
        channel: 'D5555555555',
        channel_type: 'im',
        text: 'I am the bot',
        ts: '1704067200.000000',
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores non-DM messages via message handler', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      // Channel message (not DM) should be ignored by message handler
      await triggerMessageEvent({
        user: 'U12345',
        channel: 'C1234567890',
        channel_type: 'channel',
        text: 'hello',
        ts: '1704067200.000000',
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    it('stores image attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await triggerAppMention({
        user: 'U12345',
        channel: 'C1234567890',
        text: '<@UBOTID123>',
        ts: '1704067200.000000',
        files: [{ name: 'photo.png', mimetype: 'image/png' }],
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C1234567890',
        expect.objectContaining({
          content: expect.stringContaining('[Image: photo.png]'),
        }),
      );
    });

    it('stores file attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await triggerAppMention({
        user: 'U12345',
        channel: 'C1234567890',
        text: '<@UBOTID123>',
        ts: '1704067200.000000',
        files: [{ name: 'report.pdf', mimetype: 'application/pdf' }],
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C1234567890',
        expect.objectContaining({
          content: expect.stringContaining('[File: report.pdf]'),
        }),
      );
    });

    it('includes text content with attachments', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await triggerAppMention({
        user: 'U12345',
        channel: 'C1234567890',
        text: '<@UBOTID123> check this out',
        ts: '1704067200.000000',
        files: [{ name: 'photo.jpg', mimetype: 'image/jpeg' }],
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C1234567890',
        expect.objectContaining({
          content: '@Andy check this out\n[Image: photo.jpg]',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via chat.postMessage', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      // Trigger a message first to set lastTriggerTs
      await triggerAppMention({
        user: 'U12345',
        channel: 'C1234567890',
        text: '<@UBOTID123> hello',
        ts: '1704067200.000000',
      });

      await channel.sendMessage('slack:C1234567890', 'Hello back!');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C1234567890',
        text: 'Hello back!',
        thread_ts: '1704067200.000000',
      });
    });

    it('strips slack: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await channel.sendMessage('slack:C9876543210', 'Test');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C9876543210',
        }),
      );
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('channel_not_found'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('slack:C1234567890', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when app is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      // Don't connect
      await channel.sendMessage('slack:C1234567890', 'No app');

      // No error, no API call
    });

    it('splits messages exceeding 3900 characters', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('slack:C1234567890', longText);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('slack:C1234567890')).toBe(true);
    });

    it('owns slack DM JIDs', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('slack:D1234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('dc:123456789')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('adds reaction when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      // Trigger a message first to set lastTriggerTs
      await triggerAppMention({
        user: 'U12345',
        channel: 'C1234567890',
        text: '<@UBOTID123> hello',
        ts: '1704067200.000000',
      });

      await channel.setTyping('slack:C1234567890', true);

      expect(currentApp().client.reactions.add).toHaveBeenCalledWith({
        channel: 'C1234567890',
        timestamp: '1704067200.000000',
        name: 'hourglass_flowing_sand',
      });
    });

    it('removes reaction when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      // Trigger a message first
      await triggerAppMention({
        user: 'U12345',
        channel: 'C1234567890',
        text: '<@UBOTID123> hello',
        ts: '1704067200.000000',
      });

      await channel.setTyping('slack:C1234567890', false);

      expect(currentApp().client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C1234567890',
        timestamp: '1704067200.000000',
        name: 'hourglass_flowing_sand',
      });
    });

    it('does nothing when app is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      // Don't connect
      await channel.setTyping('slack:C1234567890', true);

      // No error
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.name).toBe('slack');
    });
  });
});
