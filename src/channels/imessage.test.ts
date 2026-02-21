import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
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
  updateChatName: vi.fn(),
}));

// Build a fake SDK
function createFakeSDK() {
  return {
    startWatching: vi.fn().mockResolvedValue(undefined),
    stopWatching: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    listChats: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    // Store callbacks so tests can trigger messages
    _onMessage: null as ((msg: unknown) => void) | null,
    _onGroupMessage: null as ((msg: unknown) => void) | null,
    _onError: null as ((err: unknown) => void) | null,
  };
}

let fakeSDK: ReturnType<typeof createFakeSDK>;

vi.mock('@photon-ai/imessage-kit', () => {
  return {
    IMessageSDK: vi.fn().mockImplementation(function () {
      return fakeSDK;
    }),
  };
});

import { IMessageChannel, IMessageChannelOpts } from './imessage.js';
import { updateChatName } from '../db.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<IMessageChannelOpts>): IMessageChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'imsg-group:chat123': {
        name: 'Test iMessage Group',
        folder: 'test-imsg',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'imsg:+14155551234': {
        name: 'Test DM',
        folder: 'test-dm',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function makeMessage(overrides?: Record<string, unknown>) {
  return {
    id: '1',
    guid: 'msg-guid-1',
    text: 'Hello from iMessage',
    sender: '+14155551234',
    senderName: null,
    chatId: 'chat123',
    isFromMe: false,
    isGroupChat: true,
    isRead: false,
    service: 'iMessage' as const,
    date: new Date('2024-06-01T12:00:00.000Z'),
    isReaction: false,
    reactionType: null,
    isReactionRemoval: false,
    associatedMessageGuid: null,
    attachments: [] as readonly unknown[],
    ...overrides,
  };
}

// --- Tests ---

describe('IMessageChannel', () => {
  beforeEach(() => {
    fakeSDK = createFakeSDK();
    // Default startWatching: capture callbacks for triggering messages in tests
    fakeSDK.startWatching.mockImplementation(async (opts: {
      onMessage?: (msg: unknown) => void;
      onGroupMessage?: (msg: unknown) => void;
      onError?: (err: unknown) => void;
    }) => {
      fakeSDK._onMessage = opts.onMessage || null;
      fakeSDK._onGroupMessage = opts.onGroupMessage || null;
      fakeSDK._onError = opts.onError || null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connects successfully', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(fakeSDK.startWatching).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();
      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
      expect(fakeSDK.stopWatching).toHaveBeenCalled();
      expect(fakeSDK.close).toHaveBeenCalled();
    });

    it('handles permission errors on connect', async () => {
      fakeSDK.startWatching.mockRejectedValue(new Error('Full Disk Access required'));

      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await expect(channel.connect()).rejects.toThrow('Full Disk Access');
      expect(channel.isConnected()).toBe(false);
    });

    it('handles disconnect errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      fakeSDK.stopWatching.mockRejectedValueOnce(new Error('Already stopped'));

      // Should not throw
      await expect(channel.disconnect()).resolves.toBeUndefined();
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers group message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      const msg = makeMessage();
      fakeSDK._onMessage!(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'imsg-group:chat123',
        expect.any(String),
        undefined,
        'imessage',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'imsg-group:chat123',
        expect.objectContaining({
          id: 'msg-guid-1',
          content: 'Hello from iMessage',
          sender_name: '+14155551234',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('delivers DM for registered contact', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      const msg = makeMessage({
        isGroupChat: false,
        sender: '+14155551234',
      });
      fakeSDK._onMessage!(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'imsg:+14155551234',
        expect.any(String),
        undefined,
        'imessage',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'imsg:+14155551234',
        expect.objectContaining({
          chat_jid: 'imsg:+14155551234',
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      const msg = makeMessage({ chatId: 'unregistered-chat' });
      fakeSDK._onMessage!(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'imsg-group:unregistered-chat',
        expect.any(String),
        undefined,
        'imessage',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips reactions', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      const msg = makeMessage({ isReaction: true });
      fakeSDK._onMessage!(msg);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('detects bot messages via isFromMe', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      const msg = makeMessage({ isFromMe: true });
      fakeSDK._onMessage!(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'imsg-group:chat123',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('detects bot messages via content prefix', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      const msg = makeMessage({
        isFromMe: false,
        text: 'Andy: Here is the response',
      });
      fakeSDK._onMessage!(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'imsg-group:chat123',
        expect.objectContaining({
          is_bot_message: true,
        }),
      );
    });

    it('handles null text as empty string', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      const msg = makeMessage({ text: null });
      fakeSDK._onMessage!(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'imsg-group:chat123',
        expect.objectContaining({
          content: '',
        }),
      );
    });

    it('processes messages from onGroupMessage callback too', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      const msg = makeMessage();
      fakeSDK._onGroupMessage!(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'imsg-group:chat123',
        expect.objectContaining({
          id: 'msg-guid-1',
        }),
      );
    });
  });

  // --- Outgoing queue ---

  describe('outgoing message queue', () => {
    it('sends message when connected', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      await channel.sendMessage('imsg-group:chat123', 'Hello');

      expect(fakeSDK.send).toHaveBeenCalledWith('chat123', 'Andy: Hello');
    });

    it('extracts chatId from DM JID', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      await channel.sendMessage('imsg:+14155551234', 'Hi');

      expect(fakeSDK.send).toHaveBeenCalledWith('+14155551234', 'Andy: Hi');
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      // Don't connect
      await channel.sendMessage('imsg-group:chat123', 'Queued');
      expect(fakeSDK.send).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      fakeSDK.send.mockRejectedValueOnce(new Error('Send failed'));

      await channel.sendMessage('imsg-group:chat123', 'Will fail');

      // Should not throw, message queued
    });

    it('flushes queued messages on connect', async () => {
      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('imsg-group:chat123', 'First');
      await channel.sendMessage('imsg-group:chat123', 'Second');

      await channel.connect();

      // Wait for async flush
      await new Promise((r) => setTimeout(r, 50));

      expect(fakeSDK.send).toHaveBeenCalledTimes(2);
      expect(fakeSDK.send).toHaveBeenNthCalledWith(1, 'chat123', 'Andy: First');
      expect(fakeSDK.send).toHaveBeenNthCalledWith(2, 'chat123', 'Andy: Second');
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns imsg: DM JIDs', () => {
      const channel = new IMessageChannel(createTestOpts());
      expect(channel.ownsJid('imsg:+14155551234')).toBe(true);
    });

    it('owns imsg-group: JIDs', () => {
      const channel = new IMessageChannel(createTestOpts());
      expect(channel.ownsJid('imsg-group:chat123')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new IMessageChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new IMessageChannel(createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new IMessageChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Chat metadata sync ---

  describe('chat metadata sync', () => {
    it('syncs chat names on connect', async () => {
      fakeSDK.listChats.mockResolvedValue([
        { chatId: 'chat123', displayName: 'Family Group', isGroup: true, unreadCount: 0 },
        { chatId: '+14155551234', displayName: 'Alice', isGroup: false, unreadCount: 1 },
      ]);

      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      // Wait for async sync
      await new Promise((r) => setTimeout(r, 50));

      expect(updateChatName).toHaveBeenCalledWith('imsg-group:chat123', 'Family Group');
      expect(updateChatName).toHaveBeenCalledWith('imsg:+14155551234', 'Alice');
    });

    it('skips chats without display name', async () => {
      fakeSDK.listChats.mockResolvedValue([
        { chatId: 'chat456', displayName: '', isGroup: true, unreadCount: 0 },
        { chatId: 'chat789', displayName: 'Has Name', isGroup: true, unreadCount: 0 },
      ]);

      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      // Wait for the initial auto-sync to complete, then clear the mock
      await new Promise((r) => setTimeout(r, 50));
      vi.mocked(updateChatName).mockClear();

      await channel.syncChatMetadata(true);

      expect(updateChatName).toHaveBeenCalledTimes(1);
      expect(updateChatName).toHaveBeenCalledWith('imsg-group:chat789', 'Has Name');
    });

    it('handles sync failure gracefully', async () => {
      fakeSDK.listChats.mockRejectedValue(new Error('Database locked'));

      const opts = createTestOpts();
      const channel = new IMessageChannel(opts);

      await channel.connect();

      // Should not throw
      await expect(channel.syncChatMetadata(true)).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "imessage"', () => {
      const channel = new IMessageChannel(createTestOpts());
      expect(channel.name).toBe('imessage');
    });

    it('does not implement setTyping', () => {
      const channel = new IMessageChannel(createTestOpts());
      expect('setTyping' in channel).toBe(false);
    });
  });
});
