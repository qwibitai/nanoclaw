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

// --- Slack Bolt mock ---

type EventHandler = (args: any) => Promise<void>;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    token: string;
    appToken: string;
    socketMode: boolean;
    eventHandlers = new Map<string, EventHandler[]>();

    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT_123' }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: {
            profile: { display_name: 'Test User', real_name: 'Test' },
            name: 'testuser',
          },
        }),
      },
      conversations: {
        info: vi.fn().mockResolvedValue({
          channel: { name: 'test-channel', is_im: false, is_mpim: false },
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
      files: {
        info: vi.fn().mockResolvedValue({
          file: {
            name: 'document.pdf',
            mimetype: 'application/pdf',
            user: 'U_USER_1',
          },
        }),
      },
    };

    constructor(opts: any) {
      this.token = opts.token;
      this.appToken = opts.appToken;
      this.socketMode = opts.socketMode;
      appRef.current = this;
    }

    event(eventType: string, handler: EventHandler) {
      const existing = this.eventHandlers.get(eventType) || [];
      existing.push(handler);
      this.eventHandlers.set(eventType, existing);
    }

    async start() {
      // No-op for tests
    }

    async stop() {
      // No-op for tests
    }
  },
  LogLevel: { WARN: 'warn' },
}));

import { SlackChannel, SlackChannelOpts } from './slack.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C_TEST_123': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  channel?: string;
  text: string;
  user?: string;
  ts?: string;
  bot_id?: string;
  subtype?: string;
}) {
  return {
    channel: overrides.channel ?? 'C_TEST_123',
    text: overrides.text,
    user: overrides.user ?? 'U_USER_1',
    ts: overrides.ts ?? '1704067200.000000',
    ...(overrides.bot_id && { bot_id: overrides.bot_id }),
    ...(overrides.subtype && { subtype: overrides.subtype }),
  };
}

function createAppMentionEvent(overrides: {
  channel?: string;
  text: string;
  user?: string;
  ts?: string;
}) {
  return {
    channel: overrides.channel ?? 'C_TEST_123',
    text: overrides.text,
    user: overrides.user ?? 'U_USER_1',
    ts: overrides.ts ?? '1704067200.000000',
  };
}

function createFileSharedEvent(overrides: {
  channel_id?: string;
  file_id?: string;
  event_ts?: string;
}) {
  return {
    channel_id: overrides.channel_id ?? 'C_TEST_123',
    file_id: overrides.file_id ?? 'F_FILE_1',
    event_ts: overrides.event_ts ?? '1704067200.000000',
  };
}

function currentApp() {
  return appRef.current;
}

async function triggerEvent(eventType: string, event: any) {
  const handlers = currentApp().eventHandlers.get(eventType) || [];
  for (const h of handlers) {
    await h({ event, client: currentApp().client });
  }
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

      expect(currentApp().client.auth.test).toHaveBeenCalled();
    });

    it('registers message and app_mention event handlers', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      await channel.connect();

      expect(currentApp().eventHandlers.has('message')).toBe(true);
      expect(currentApp().eventHandlers.has('app_mention')).toBe(true);
      expect(currentApp().eventHandlers.has('file_shared')).toBe(true);
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

  // --- Message event handling ---

  describe('message event handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hello everyone' });
      await triggerEvent('message', event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.any(String),
        'test-channel',
        'slack',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({
          id: '1704067200.000000',
          chat_jid: 'slack:C_TEST_123',
          sender: 'U_USER_1',
          sender_name: 'Test User',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({
        channel: 'C_UNKNOWN',
        text: 'Unknown channel',
      });
      await triggerEvent('message', event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C_UNKNOWN',
        expect.any(String),
        'test-channel',
        'slack',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Bot message',
        bot_id: 'B_BOT_1',
      });
      await triggerEvent('message', event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('skips message subtypes (edits, deletes)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Edited message',
        subtype: 'message_changed',
      });
      await triggerEvent('message', event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips messages without text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = { channel: 'C_TEST_123', user: 'U_USER_1', ts: '123' };
      await triggerEvent('message', event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('fetches sender display name from users.info', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hi' });
      await triggerEvent('message', event);

      expect(currentApp().client.users.info).toHaveBeenCalledWith({
        user: 'U_USER_1',
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({ sender_name: 'Test User' }),
      );
    });

    it('falls back to user ID when users.info fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.users.info.mockRejectedValueOnce(
        new Error('API error'),
      );

      const event = createMessageEvent({ text: 'Hi', user: 'U_FALLBACK' });
      await triggerEvent('message', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({ sender_name: 'U_FALLBACK' }),
      );
    });

    it('converts ts to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Hello',
        ts: '1704067200.000000', // 2024-01-01T00:00:00.000Z
      });
      await triggerEvent('message', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates <@botUserId> mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '<@U_BOT_123> what time is it?',
      });
      await triggerEvent('message', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({
          content: '@Andy <@U_BOT_123> what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@Andy <@U_BOT_123> hello',
      });
      await triggerEvent('message', event);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({
          content: '@Andy <@U_BOT_123> hello',
        }),
      );
    });

    it('does not translate mentions of other users', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '<@U_OTHER_USER> hi',
      });
      await triggerEvent('message', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({
          content: '<@U_OTHER_USER> hi', // No translation
        }),
      );
    });

    it('handles message without any mentions', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'plain message' });
      await triggerEvent('message', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });
  });

  // --- app_mention event ---

  describe('app_mention event', () => {
    it('delivers app_mention for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createAppMentionEvent({
        text: '<@U_BOT_123> help me',
      });
      await triggerEvent('app_mention', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({
          content: '@Andy <@U_BOT_123> help me',
        }),
      );
    });

    it('ignores app_mention from unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createAppMentionEvent({
        channel: 'C_UNKNOWN',
        text: '<@U_BOT_123> hi',
      });
      await triggerEvent('app_mention', event);

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- file_shared event ---

  describe('file_shared event', () => {
    it('stores file with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createFileSharedEvent({});
      await triggerEvent('file_shared', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({ content: '[File: document.pdf]' }),
      );
    });

    it('stores image with Image placeholder', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.files.info.mockResolvedValueOnce({
        file: {
          name: 'screenshot.png',
          mimetype: 'image/png',
          user: 'U_USER_1',
        },
      });

      const event = createFileSharedEvent({});
      await triggerEvent('file_shared', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({ content: '[Image: screenshot.png]' }),
      );
    });

    it('stores video with Video placeholder', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.files.info.mockResolvedValueOnce({
        file: {
          name: 'clip.mp4',
          mimetype: 'video/mp4',
          user: 'U_USER_1',
        },
      });

      const event = createFileSharedEvent({});
      await triggerEvent('file_shared', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({ content: '[Video: clip.mp4]' }),
      );
    });

    it('stores audio with Audio placeholder', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.files.info.mockResolvedValueOnce({
        file: {
          name: 'voice.mp3',
          mimetype: 'audio/mpeg',
          user: 'U_USER_1',
        },
      });

      const event = createFileSharedEvent({});
      await triggerEvent('file_shared', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.objectContaining({ content: '[Audio: voice.mp3]' }),
      );
    });

    it('ignores file_shared from unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createFileSharedEvent({ channel_id: 'C_UNKNOWN' });
      await triggerEvent('file_shared', event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via chat.postMessage', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await channel.sendMessage('slack:C_TEST_123', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_TEST_123',
        text: 'Hello',
      });
    });

    it('strips slack: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await channel.sendMessage('slack:C_CHANNEL_ID', 'Message');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_CHANNEL_ID',
        text: 'Message',
      });
    });

    it('splits messages exceeding 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('slack:C_TEST_123', longText);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(1, {
        channel: 'C_TEST_123',
        text: 'x'.repeat(4000),
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(2, {
        channel: 'C_TEST_123',
        text: 'x'.repeat(1000),
      });
    });

    it('sends exactly one message at 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4000);
      await channel.sendMessage('slack:C_TEST_123', exactText);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('slack:C_TEST_123', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when app is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      // Don't connect — app is null
      await channel.sendMessage('slack:C_TEST_123', 'No app');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createTestOpts(),
      );
      expect(channel.ownsJid('slack:C123456')).toBe(true);
    });

    it('owns slack: JIDs with various channel ID formats', () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createTestOpts(),
      );
      expect(channel.ownsJid('slack:C_CHANNEL_ID')).toBe(true);
      expect(channel.ownsJid('slack:D_DM_ID')).toBe(true);
      expect(channel.ownsJid('slack:G_GROUP_ID')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createTestOpts(),
      );
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('is a no-op (Slack does not support bot typing)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      // Should not throw and should not call any API
      await expect(
        channel.setTyping('slack:C_TEST_123', true),
      ).resolves.toBeUndefined();
    });

    it('does not throw when app is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      // Don't connect
      await expect(
        channel.setTyping('slack:C_TEST_123', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel(
        'xoxb-token',
        'xapp-token',
        createTestOpts(),
      );
      expect(channel.name).toBe('slack');
    });
  });

  // --- Channel type detection ---

  describe('channel type detection', () => {
    it('marks DM channels as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:D_DM_123': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.conversations.info.mockResolvedValueOnce({
        channel: { name: 'dm', is_im: true, is_mpim: false },
      });

      const event = createMessageEvent({
        channel: 'D_DM_123',
        text: 'Hello',
      });
      await triggerEvent('message', event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:D_DM_123',
        expect.any(String),
        'dm',
        'slack',
        false, // isGroup = false for DMs
      );
    });

    it('marks MPIM channels as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:G_MPIM_123': {
            name: 'Group DM',
            folder: 'mpim',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.conversations.info.mockResolvedValueOnce({
        channel: { name: 'mpdm-user1--user2--user3', is_im: false, is_mpim: true },
      });

      const event = createMessageEvent({
        channel: 'G_MPIM_123',
        text: 'Hello',
      });
      await triggerEvent('message', event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:G_MPIM_123',
        expect.any(String),
        'mpdm-user1--user2--user3',
        'slack',
        false, // isGroup = false for MPIMs
      );
    });

    it('marks regular channels as groups', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hello' });
      await triggerEvent('message', event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C_TEST_123',
        expect.any(String),
        'test-channel',
        'slack',
        true, // isGroup = true for channels
      );
    });
  });
});
