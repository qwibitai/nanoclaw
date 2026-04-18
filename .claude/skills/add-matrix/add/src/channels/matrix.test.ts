import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  STORE_DIR: '/tmp/nanoclaw-test-store',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- matrix-bot-sdk mock ---

type EventHandler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('matrix-bot-sdk', () => ({
  MatrixClient: class MockMatrixClient {
    homeserverUrl: string;
    accessToken: string;
    crypto: any = null;
    private eventHandlers = new Map<string, EventHandler[]>();

    sendText = vi.fn().mockResolvedValue('$event1');
    sendNotice = vi.fn().mockResolvedValue('$event2');
    setTyping = vi.fn().mockResolvedValue(undefined);
    getUserId = vi.fn().mockResolvedValue('@bot:example.com');
    getRoomStateEvent = vi.fn().mockResolvedValue({ name: 'Test Room' });
    getJoinedRooms = vi.fn().mockResolvedValue(['!test123:example.com']);
    stop = vi.fn();

    constructor(
      homeserverUrl: string,
      accessToken: string,
      _storage: any,
      cryptoStore?: any,
    ) {
      this.homeserverUrl = homeserverUrl;
      this.accessToken = accessToken;
      if (cryptoStore) {
        this.crypto = {
          prepare: vi.fn().mockResolvedValue(undefined),
          isReady: true,
        };
      }
      clientRef.current = this;
    }

    on(event: string, handler: EventHandler) {
      const existing = this.eventHandlers.get(event) || [];
      existing.push(handler);
      this.eventHandlers.set(event, existing);
    }

    async start() {
      // Resolves immediately in tests
    }

    // Test helper: trigger event handlers
    async _emit(event: string, ...args: any[]) {
      const handlers = this.eventHandlers.get(event) || [];
      for (const handler of handlers) {
        await handler(...args);
      }
    }
  },
  SimpleFsStorageProvider: class MockStorage {
    constructor(_path: string) {}
  },
  AutojoinRoomsMixin: {
    setupOnClient: vi.fn(),
  },
  RustSdkCryptoStorageProvider: class MockCryptoStorage {
    constructor(_path: string, _type: any) {}
  },
  RustSdkCryptoStoreType: { Sqlite: 0 },
}));

import { MatrixChannel } from './matrix.js';
import { AutojoinRoomsMixin } from 'matrix-bot-sdk';
import type { ChannelOpts } from './registry.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'mx:!test123:example.com': {
        name: 'Test Room',
        folder: 'test-room',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00Z',
        requiresTrigger: true,
      },
    })),
    ...overrides,
  };
}

function createTextEvent(overrides?: Record<string, any>) {
  return {
    type: 'm.room.message',
    sender: '@alice:example.com',
    event_id: '$evt1',
    origin_server_ts: 1700000000000,
    content: {
      msgtype: 'm.text',
      body: 'Hello world',
      ...(overrides?.content || {}),
    },
    ...overrides,
  };
}

async function triggerRoomMessage(roomId: string, event: any): Promise<void> {
  await clientRef.current._emit('room.message', roomId, event);
}

// --- Tests ---

describe('factory registration', () => {
  it('registers matrix with the channel registry', async () => {
    const { registerChannel } = await import('./registry.js');
    expect(registerChannel).toHaveBeenCalledWith('matrix', expect.any(Function));
  });
});

describe('MatrixChannel', () => {
  let channel: MatrixChannel;
  let opts: ChannelOpts;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRef.current = null;
    opts = createTestOpts();
  });

  afterEach(async () => {
    if (channel?.isConnected()) {
      await channel.disconnect();
    }
  });

  // ========== Connection lifecycle ==========

  describe('connect', () => {
    it('creates client and registers handlers', async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(clientRef.current).not.toBeNull();
      expect(AutojoinRoomsMixin.setupOnClient).toHaveBeenCalled();
    });

    it('caches bot user ID', async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();

      expect(clientRef.current.getUserId).toHaveBeenCalled();
    });

    it('does not throw on connection failure', async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );

      // Make start() reject
      vi.spyOn(
        (await import('matrix-bot-sdk')).MatrixClient.prototype,
        'start',
      ).mockRejectedValueOnce(new Error('Connection refused'));

      // Should NOT throw
      await channel.connect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('stops client and nulls reference', async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(clientRef.current.stop).toHaveBeenCalled();
    });

    it('handles disconnect when not connected', async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.disconnect(); // Should not throw
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      expect(channel.isConnected()).toBe(false);
    });

    it('returns true after connect', async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });
  });

  // ========== Text message handling ==========

  describe('room.message', () => {
    beforeEach(async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();
    });

    it('delivers message for registered room', async () => {
      const event = createTextEvent();
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!test123:example.com',
        expect.any(String),
        'Test Room',
        'matrix',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'mx:!test123:example.com',
        expect.objectContaining({
          chat_jid: 'mx:!test123:example.com',
          sender: '@alice:example.com',
          sender_name: 'alice',
          content: 'Hello world',
          is_from_me: false,
        }),
      );
    });

    it('skips unregistered rooms', async () => {
      const event = createTextEvent();
      await triggerRoomMessage('!unregistered:example.com', event);

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips bot own messages', async () => {
      const event = createTextEvent({ sender: '@bot:example.com' });
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text messages', async () => {
      const event = createTextEvent({
        content: { msgtype: 'm.image', body: 'photo.jpg' },
      });
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips redacted events (no content)', async () => {
      await triggerRoomMessage('!test123:example.com', {
        sender: '@alice:example.com',
      });

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('extracts sender name from Matrix user ID', async () => {
      const event = createTextEvent({ sender: '@john.doe:matrix.org' });
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sender_name: 'john.doe' }),
      );
    });

    it('uses event timestamp', async () => {
      const event = createTextEvent({ origin_server_ts: 1700000000000 });
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          timestamp: new Date(1700000000000).toISOString(),
        }),
      );
    });

    it('passes channel=matrix and isGroup=true to onChatMetadata', async () => {
      const event = createTextEvent();
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!test123:example.com',
        expect.any(String),
        'Test Room',
        'matrix',
        true,
      );
    });

    it('falls back to JID when room has no name', async () => {
      clientRef.current.getRoomStateEvent.mockRejectedValueOnce(
        new Error('No state'),
      );
      const event = createTextEvent();
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!test123:example.com',
        expect.any(String),
        'mx:!test123:example.com',
        'matrix',
        true,
      );
    });
  });

  // ========== E2EE support ==========

  describe('E2EE', () => {
    it('initializes crypto when e2ee is enabled (default)', async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();

      expect(clientRef.current.crypto).toBeTruthy();
      expect(clientRef.current.crypto.isReady).toBe(true);
    });

    it('skips crypto when e2ee is disabled', async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
        false,
      );
      await channel.connect();

      expect(clientRef.current.crypto).toBeNull();
    });

    it('continues without crypto if prepare fails', async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();

      const origCrypto = clientRef.current.crypto;
      if (origCrypto) {
        origCrypto.prepare.mockRejectedValueOnce(new Error('Crypto failed'));
      }

      const channel2 = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel2.connect();
      expect(channel2.isConnected()).toBe(true);
    });
  });

  // ========== Mention translation ==========

  describe('mention translation', () => {
    beforeEach(async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();
    });

    it('translates bot user ID mention to trigger', async () => {
      const event = createTextEvent({
        content: { msgtype: 'm.text', body: '@bot:example.com do something' },
      });
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: '@Andy @bot:example.com do something',
        }),
      );
    });

    it('translates @localpart mention to trigger', async () => {
      const event = createTextEvent({
        content: { msgtype: 'm.text', body: 'hey @bot help me' },
      });
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: '@Andy hey @bot help me',
        }),
      );
    });

    it('does not trigger on bare localpart word without @', async () => {
      const event = createTextEvent({
        content: { msgtype: 'm.text', body: 'hey bot help me' },
      });
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: 'hey bot help me',
        }),
      );
    });

    it('does not add trigger if already present', async () => {
      const event = createTextEvent({
        content: { msgtype: 'm.text', body: '@Andy hey @bot help me' },
      });
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: '@Andy hey @bot help me',
        }),
      );
    });

    it('does not translate mentions of other users', async () => {
      const event = createTextEvent({
        content: { msgtype: 'm.text', body: '@alice:example.com hello' },
      });
      await triggerRoomMessage('!test123:example.com', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          content: '@alice:example.com hello',
        }),
      );
    });
  });

  // ========== room.decrypted_event and deduplication ==========

  describe('room.decrypted_event', () => {
    beforeEach(async () => {
      opts.registeredGroups = vi
        .fn()
        .mockReturnValue({ 'mx:!test123:example.com': { name: 'test' } });
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();
    });

    async function triggerDecryptedEvent(
      roomId: string,
      event: any,
    ): Promise<void> {
      await clientRef.current._emit('room.decrypted_event', roomId, event);
    }

    it('delivers decrypted m.room.message events', async () => {
      const event = createTextEvent({ type: 'm.room.message' });
      await triggerDecryptedEvent('!test123:example.com', event);
      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('ignores non-message decrypted events', async () => {
      const event = createTextEvent({ type: 'm.room.member' });
      await triggerDecryptedEvent('!test123:example.com', event);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('deduplicates same event across room.message and room.decrypted_event', async () => {
      const event = createTextEvent({
        event_id: '$dedup-test',
        type: 'm.room.message',
      });
      await triggerRoomMessage('!test123:example.com', event);
      await triggerDecryptedEvent('!test123:example.com', event);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });

    it('delivers different events from each handler', async () => {
      const event1 = createTextEvent({
        event_id: '$event-1',
        type: 'm.room.message',
      });
      const event2 = createTextEvent({
        event_id: '$event-2',
        type: 'm.room.message',
      });
      await triggerRoomMessage('!test123:example.com', event1);
      await triggerDecryptedEvent('!test123:example.com', event2);
      expect(opts.onMessage).toHaveBeenCalledTimes(2);
    });
  });

  // ========== sendMessage ==========

  describe('sendMessage', () => {
    beforeEach(async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();
    });

    it('sends text to room', async () => {
      await channel.sendMessage('mx:!room1:example.com', 'Hello');

      expect(clientRef.current.sendText).toHaveBeenCalledWith(
        '!room1:example.com',
        'Hello',
      );
    });

    it('strips mx: prefix', async () => {
      await channel.sendMessage('mx:!room1:example.com', 'test');

      const call = clientRef.current.sendText.mock.calls[0];
      expect(call[0]).toBe('!room1:example.com');
    });

    it('truncates long messages', async () => {
      const longText = 'x'.repeat(70_000);
      await channel.sendMessage('mx:!room1:example.com', longText);

      const call = clientRef.current.sendText.mock.calls[0];
      expect(call[1].length).toBeLessThan(65_000);
      expect(call[1]).toContain('[Message truncated');
    });

    it('logs error on send failure instead of throwing', async () => {
      clientRef.current.sendText.mockRejectedValueOnce(
        new Error('Send failed'),
      );
      const { logger } = await import('../logger.js');
      await channel.sendMessage('mx:!room1:example.com', 'test');
      expect(logger.error).toHaveBeenCalledWith(
        { jid: 'mx:!room1:example.com', err: expect.any(Error) },
        'Failed to send Matrix message',
      );
    });

    it('returns silently when client not initialized', async () => {
      await channel.disconnect();
      const { logger } = await import('../logger.js');
      await channel.sendMessage('mx:!room1:example.com', 'test');
      expect(logger.warn).toHaveBeenCalledWith(
        { jid: 'mx:!room1:example.com' },
        'Matrix client not initialized, cannot send',
      );
    });
  });

  // ========== ownsJid ==========

  describe('ownsJid', () => {
    beforeEach(() => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
    });

    it('returns true for mx: prefix', () => {
      expect(channel.ownsJid('mx:!room:example.com')).toBe(true);
    });

    it('returns false for WhatsApp JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('returns false for Telegram JIDs', () => {
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(channel.ownsJid('')).toBe(false);
    });
  });

  // ========== setTyping ==========

  describe('setTyping', () => {
    beforeEach(async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();
    });

    it('sends typing with timeout when isTyping=true', async () => {
      await channel.setTyping('mx:!room1:example.com', true);

      expect(clientRef.current.setTyping).toHaveBeenCalledWith(
        '!room1:example.com',
        true,
        30_000,
      );
    });

    it('cancels typing when isTyping=false', async () => {
      await channel.setTyping('mx:!room1:example.com', false);

      expect(clientRef.current.setTyping).toHaveBeenCalledWith(
        '!room1:example.com',
        false,
        0,
      );
    });

    it('no-ops when client is null', async () => {
      await channel.disconnect();
      await channel.setTyping('mx:!room1:example.com', true);
      // Should not throw
    });

    it('handles error gracefully', async () => {
      clientRef.current.setTyping.mockRejectedValueOnce(new Error('fail'));
      await channel.setTyping('mx:!room1:example.com', true);
      // Should not throw
    });
  });

  // ========== Commands ==========

  describe('commands', () => {
    beforeEach(async () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      await channel.connect();
    });

    it('!chatid replies with room ID', async () => {
      const event = createTextEvent({
        content: { msgtype: 'm.text', body: '!chatid' },
      });
      await triggerRoomMessage('!test123:example.com', event);

      expect(clientRef.current.sendNotice).toHaveBeenCalledWith(
        '!test123:example.com',
        expect.stringContaining('mx:!test123:example.com'),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('!ping replies with status', async () => {
      const event = createTextEvent({
        content: { msgtype: 'm.text', body: '!ping' },
      });
      await triggerRoomMessage('!test123:example.com', event);

      expect(clientRef.current.sendNotice).toHaveBeenCalledWith(
        '!test123:example.com',
        expect.stringContaining('online'),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // ========== Channel properties ==========

  describe('properties', () => {
    it('has name "matrix"', () => {
      channel = new MatrixChannel(
        'https://matrix.example.com',
        'token123',
        opts,
      );
      expect(channel.name).toBe('matrix');
    });
  });
});
