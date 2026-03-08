import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

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

// --- WebSocket mock ---

type WsHandler = (...args: any[]) => any;

const wsRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('ws', () => {
  const MockWebSocket = class {
    static OPEN = 1;
    static CLOSED = 3;

    url: string;
    readyState = 1; // OPEN
    handlers = new Map<string, WsHandler[]>();

    constructor(url: string) {
      this.url = url;
      wsRef.current = this;
    }

    on(event: string, handler: WsHandler) {
      const existing = this.handlers.get(event) || [];
      existing.push(handler);
      this.handlers.set(event, existing);
    }

    send = vi.fn().mockImplementation((data: string) => {
      // Auto-respond to API calls with success
      try {
        const parsed = JSON.parse(data);
        if (parsed.echo) {
          // Simulate async API response
          setTimeout(() => {
            const response = JSON.stringify({
              status: 'ok',
              retcode: 0,
              data: { message_id: 9999 },
              echo: parsed.echo,
            });
            const handlers = this.handlers.get('message') || [];
            for (const h of handlers) h(response);
          }, 0);
        }
      } catch {
        // ignore parse errors
      }
    });

    close() {
      this.readyState = 3;
    }

    // Test helper: emit an event
    emit(event: string, ...args: any[]) {
      const handlers = this.handlers.get(event) || [];
      for (const h of handlers) h(...args);
    }
  };

  return { default: MockWebSocket, __esModule: true };
});

import {
  NapCatChannel,
  NapCatChannelOpts,
  extractTextContent,
  buildJid,
  isBotMentioned,
} from './napcat.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<NapCatChannelOpts>,
): NapCatChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'qq:123456': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function currentWs() {
  return wsRef.current;
}

function createGroupMessageEvent(overrides: {
  groupId?: number;
  userId?: number;
  nickname?: string;
  card?: string;
  message?: any;
  rawMessage?: string;
  messageId?: number;
  time?: number;
  selfId?: number;
}) {
  return JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: overrides.messageId ?? 1001,
    user_id: overrides.userId ?? 99001,
    group_id: overrides.groupId ?? 123456,
    message: overrides.message ?? [{ type: 'text', data: { text: 'Hello' } }],
    raw_message: overrides.rawMessage ?? 'Hello',
    time: overrides.time ?? Math.floor(Date.now() / 1000),
    self_id: overrides.selfId ?? 10000,
    sender: {
      user_id: overrides.userId ?? 99001,
      nickname: overrides.nickname ?? 'Alice',
      card: overrides.card ?? '',
    },
  });
}

function createPrivateMessageEvent(overrides: {
  userId?: number;
  nickname?: string;
  message?: any;
  rawMessage?: string;
  messageId?: number;
  time?: number;
  selfId?: number;
}) {
  return JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: overrides.messageId ?? 2001,
    user_id: overrides.userId ?? 99001,
    message: overrides.message ?? [{ type: 'text', data: { text: 'Hi' } }],
    raw_message: overrides.rawMessage ?? 'Hi',
    time: overrides.time ?? Math.floor(Date.now() / 1000),
    self_id: overrides.selfId ?? 10000,
    sender: {
      user_id: overrides.userId ?? 99001,
      nickname: overrides.nickname ?? 'Alice',
    },
  });
}

function createLifecycleEvent(selfId: number = 10000) {
  return JSON.stringify({
    post_type: 'meta_event',
    meta_event_type: 'lifecycle',
    sub_type: 'connect',
    self_id: selfId,
    time: Math.floor(Date.now() / 1000),
  });
}

async function connectChannel(
  channel: NapCatChannel,
  selfId: number = 10000,
): Promise<void> {
  const connectPromise = channel.connect();
  // Simulate lifecycle event
  await vi.waitFor(() => {
    if (!currentWs()) throw new Error('WS not created yet');
  });
  currentWs().emit('open');
  currentWs().emit('message', createLifecycleEvent(selfId));
  await connectPromise;
}

// --- Tests ---

describe('NapCatChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // --- Helper function tests ---

  describe('extractTextContent', () => {
    it('extracts text from array segments', () => {
      const segments = [
        { type: 'text', data: { text: 'Hello ' } },
        { type: 'text', data: { text: 'world' } },
      ];
      expect(extractTextContent(segments, '')).toBe('Hello world');
    });

    it('handles string message format', () => {
      expect(extractTextContent('plain text', '')).toBe('plain text');
    });

    it('handles at segments', () => {
      const segments = [
        { type: 'at', data: { qq: '12345' } },
        { type: 'text', data: { text: ' hello' } },
      ];
      expect(extractTextContent(segments, '')).toBe('@12345 hello');
    });

    it('handles at all', () => {
      const segments = [{ type: 'at', data: { qq: 'all' } }];
      expect(extractTextContent(segments, '')).toBe('@all');
    });

    it('handles image segments', () => {
      const segments = [
        { type: 'image', data: { file: 'abc.jpg' } },
        { type: 'text', data: { text: ' caption' } },
      ];
      expect(extractTextContent(segments, '')).toBe('[Image] caption');
    });

    it('handles voice segments', () => {
      const segments = [{ type: 'record', data: { file: 'voice.amr' } }];
      expect(extractTextContent(segments, '')).toBe('[Voice]');
    });

    it('handles video segments', () => {
      const segments = [{ type: 'video', data: { file: 'vid.mp4' } }];
      expect(extractTextContent(segments, '')).toBe('[Video]');
    });

    it('handles face segments', () => {
      const segments = [{ type: 'face', data: { id: '1' } }];
      expect(extractTextContent(segments, '')).toBe('[QQ Face]');
    });

    it('handles share segments', () => {
      const segments = [
        { type: 'share', data: { url: 'https://example.com', title: 'Example' } },
      ];
      expect(extractTextContent(segments, '')).toBe('[Link: Example]');
    });

    it('handles location segments', () => {
      const segments = [
        { type: 'location', data: { lat: '39.9', lon: '116.3', title: 'Beijing' } },
      ];
      expect(extractTextContent(segments, '')).toBe('[Location: Beijing]');
    });

    it('skips reply segments', () => {
      const segments = [
        { type: 'reply', data: { id: '999' } },
        { type: 'text', data: { text: 'response' } },
      ];
      expect(extractTextContent(segments, '')).toBe('response');
    });

    it('handles forward segments', () => {
      const segments = [{ type: 'forward', data: { id: 'abc' } }];
      expect(extractTextContent(segments, '')).toBe('[Forward message]');
    });

    it('handles json segments', () => {
      const segments = [{ type: 'json', data: { data: '{}' } }];
      expect(extractTextContent(segments, '')).toBe('[JSON message]');
    });

    it('handles xml segments', () => {
      const segments = [{ type: 'xml', data: { data: '<xml/>' } }];
      expect(extractTextContent(segments, '')).toBe('[XML message]');
    });

    it('falls back to raw_message for empty array', () => {
      expect(extractTextContent([], 'fallback')).toBe('fallback');
    });

    it('handles unknown segment types with text data', () => {
      const segments = [{ type: 'custom', data: { text: 'custom text' } }];
      expect(extractTextContent(segments, '')).toBe('custom text');
    });

    it('handles unknown segment types without text data', () => {
      const segments = [{ type: 'custom', data: { foo: 'bar' } }];
      expect(extractTextContent(segments, 'raw')).toBe('raw');
    });
  });

  describe('buildJid', () => {
    it('builds group JID', () => {
      const event = {
        message_type: 'group' as const,
        group_id: 123456,
        user_id: 99001,
      } as any;
      expect(buildJid(event)).toBe('qq:123456');
    });

    it('builds private JID', () => {
      const event = {
        message_type: 'private' as const,
        user_id: 99001,
      } as any;
      expect(buildJid(event)).toBe('qq:99001');
    });
  });

  describe('isBotMentioned', () => {
    it('returns true when bot is mentioned', () => {
      const message = [
        { type: 'at', data: { qq: '10000' } },
        { type: 'text', data: { text: ' hello' } },
      ];
      expect(isBotMentioned(message, 10000)).toBe(true);
    });

    it('returns false when other user is mentioned', () => {
      const message = [
        { type: 'at', data: { qq: '99999' } },
        { type: 'text', data: { text: ' hello' } },
      ];
      expect(isBotMentioned(message, 10000)).toBe(false);
    });

    it('returns false for string messages', () => {
      expect(isBotMentioned('hello', 10000)).toBe(false);
    });

    it('returns false for empty array', () => {
      expect(isBotMentioned([], 10000)).toBe(false);
    });

    it('handles qq as number', () => {
      const message = [{ type: 'at', data: { qq: 10000 } }];
      expect(isBotMentioned(message, 10000)).toBe(true);
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when lifecycle event received', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);

      await connectChannel(channel);

      expect(channel.isConnected()).toBe(true);
    });

    it('passes access token in URL', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel(
        'ws://localhost:6700',
        'my-secret-token',
        opts,
      );

      const connectPromise = channel.connect();
      await vi.waitFor(() => {
        if (!currentWs()) throw new Error('WS not created yet');
      });

      expect(currentWs().url).toBe(
        'ws://localhost:6700?access_token=my-secret-token',
      );

      currentWs().emit('open');
      currentWs().emit('message', createLifecycleEvent());
      await connectPromise;
    });

    it('connects without access token', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);

      const connectPromise = channel.connect();
      await vi.waitFor(() => {
        if (!currentWs()) throw new Error('WS not created yet');
      });

      expect(currentWs().url).toBe('ws://localhost:6700');

      currentWs().emit('open');
      currentWs().emit('message', createLifecycleEvent());
      await connectPromise;
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);

      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Group message handling ---

  describe('group message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      currentWs().emit('message', createGroupMessageEvent({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qq:123456',
        expect.any(String),
        'QQ Group 123456',
        'napcat',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:123456',
        expect.objectContaining({
          id: '1001',
          chat_jid: 'qq:123456',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      currentWs().emit(
        'message',
        createGroupMessageEvent({ groupId: 999999 }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qq:999999',
        expect.any(String),
        'QQ Group 999999',
        'napcat',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses card (group nickname) as sender name when available', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      currentWs().emit(
        'message',
        createGroupMessageEvent({ card: 'Group Nickname' }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:123456',
        expect.objectContaining({ sender_name: 'Group Nickname' }),
      );
    });

    it('falls back to nickname when card is empty', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      currentWs().emit(
        'message',
        createGroupMessageEvent({ card: '', nickname: 'Bob' }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:123456',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('converts time to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      currentWs().emit(
        'message',
        createGroupMessageEvent({ time: unixTime }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:123456',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('detects is_from_me when sender is bot', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel, 10000);

      currentWs().emit(
        'message',
        createGroupMessageEvent({ userId: 10000, selfId: 10000 }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:123456',
        expect.objectContaining({ is_from_me: true }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when bot is @mentioned in group', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel, 10000);

      const message = [
        { type: 'at', data: { qq: '10000' } },
        { type: 'text', data: { text: ' what time is it?' } },
      ];
      currentWs().emit(
        'message',
        createGroupMessageEvent({
          message,
          rawMessage: '@bot what time is it?',
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:123456',
        expect.objectContaining({
          content: '@Andy @10000 what time is it?',
        }),
      );
    });

    it('does not prepend trigger if content already matches', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel, 10000);

      const message = [
        { type: 'text', data: { text: '@Andy hello' } },
      ];
      currentWs().emit(
        'message',
        createGroupMessageEvent({
          message,
          rawMessage: '@Andy hello',
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:123456',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('does not translate mentions of other users', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel, 10000);

      const message = [
        { type: 'at', data: { qq: '99999' } },
        { type: 'text', data: { text: ' hi' } },
      ];
      currentWs().emit(
        'message',
        createGroupMessageEvent({
          message,
          rawMessage: '@someone hi',
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:123456',
        expect.objectContaining({
          content: '@99999 hi',
        }),
      );
    });
  });

  // --- Private message handling ---

  describe('private message handling', () => {
    it('delivers private message for registered user', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'qq:99001': {
            name: 'Alice DM',
            folder: 'alice_dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      currentWs().emit('message', createPrivateMessageEvent({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'qq:99001',
        expect.any(String),
        'Alice',
        'napcat',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'qq:99001',
        expect.objectContaining({
          chat_jid: 'qq:99001',
          sender_name: 'Alice',
          content: 'Hi',
        }),
      );
    });

    it('ignores private messages from unregistered users', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      currentWs().emit('message', createPrivateMessageEvent({}));

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends group message via API', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      await channel.sendMessage('qq:123456', 'Hello group');

      expect(currentWs().send).toHaveBeenCalledWith(
        expect.stringContaining('"action":"send_group_msg"'),
      );
      const sent = JSON.parse(currentWs().send.mock.calls[0][0]);
      expect(sent.params.group_id).toBe(123456);
      expect(sent.params.message).toEqual([
        { type: 'text', data: { text: 'Hello group' } },
      ]);
    });

    it('sends private message for unregistered JID', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      await channel.sendMessage('qq:99001', 'Hello user');

      expect(currentWs().send).toHaveBeenCalledWith(
        expect.stringContaining('"action":"send_private_msg"'),
      );
      const sent = JSON.parse(currentWs().send.mock.calls[0][0]);
      expect(sent.params.user_id).toBe(99001);
    });

    it('strips qq: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      await channel.sendMessage('qq:123456', 'Test');

      const sent = JSON.parse(currentWs().send.mock.calls[0][0]);
      expect(sent.params.group_id).toBe(123456);
    });

    it('does nothing when WebSocket is not connected', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);

      // Don't connect
      await channel.sendMessage('qq:123456', 'No connection');

      // No error, no send call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns qq: JIDs', () => {
      const channel = new NapCatChannel(
        'ws://localhost:6700',
        '',
        createTestOpts(),
      );
      expect(channel.ownsJid('qq:123456')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new NapCatChannel(
        'ws://localhost:6700',
        '',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new NapCatChannel(
        'ws://localhost:6700',
        '',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = new NapCatChannel(
        'ws://localhost:6700',
        '',
        createTestOpts(),
      );
      expect(channel.ownsJid('dc:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new NapCatChannel(
        'ws://localhost:6700',
        '',
        createTestOpts(),
      );
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('is a no-op (QQ has no typing indicator)', async () => {
      const opts = createTestOpts();
      const channel = new NapCatChannel('ws://localhost:6700', '', opts);
      await connectChannel(channel);

      // Should not throw
      await expect(
        channel.setTyping('qq:123456', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "napcat"', () => {
      const channel = new NapCatChannel(
        'ws://localhost:6700',
        '',
        createTestOpts(),
      );
      expect(channel.name).toBe('napcat');
    });
  });
});
