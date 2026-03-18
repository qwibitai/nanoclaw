import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ TELEGRAM_BOT_TOKEN: 'test-token' })),
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

// Mock transcription
vi.mock('../transcription.js', () => ({
  isTranscriptionAvailable: vi.fn(() => false),
  transcribeAudio: vi.fn(),
}));

// Build a fake Bot that's testable
let messageHandler: ((ctx: unknown) => Promise<void>) | undefined;
let errorHandler: ((err: unknown) => void) | undefined;

const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockSendChatAction = vi.fn().mockResolvedValue(undefined);
const mockGetFile = vi.fn();

const fakeBotInfo = {
  id: 999,
  is_bot: true,
  first_name: 'TestBot',
  username: 'testbot',
};

vi.mock('grammy', () => {
  class MockBot {
    botInfo = fakeBotInfo;
    token: string;
    api = {
      sendMessage: mockSendMessage,
      sendChatAction: mockSendChatAction,
      getFile: mockGetFile,
    };
    constructor(token: string) {
      this.token = token;
    }
    on(event: string, handler: (ctx: unknown) => Promise<void>) {
      if (event === 'message') messageHandler = handler;
    }
    catch(handler: (err: unknown) => void) {
      errorHandler = handler;
    }
    async init() {}
    start(opts?: { onStart?: () => void }) {
      if (opts?.onStart) opts.onStart();
    }
    async stop() {}
  }
  return { Bot: MockBot };
});

import { TelegramChannel } from './telegram.js';
import { ChannelOpts } from './registry.js';
import { readEnvFile } from '../env.js';
import {
  isTranscriptionAvailable,
  transcribeAudio,
} from '../transcription.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<ChannelOpts>,
): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:-1001234567890': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageContext(overrides: Record<string, unknown> = {}) {
  return {
    chat: {
      id: -1001234567890,
      type: 'supergroup' as const,
      title: 'Test Group',
      ...((overrides.chat as Record<string, unknown>) || {}),
    },
    from: {
      id: 12345,
      is_bot: false,
      first_name: 'Alice',
      last_name: 'Smith',
      username: 'alice',
      ...((overrides.from as Record<string, unknown>) || {}),
    },
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      text: 'Hello',
      chat: { id: -1001234567890 },
      ...((overrides.message as Record<string, unknown>) || {}),
    },
    api: {
      getFile: mockGetFile,
    },
    ...overrides,
  };
}

// --- Tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = undefined;
    errorHandler = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Factory ---

  describe('factory registration', () => {
    it('returns null when TELEGRAM_BOT_TOKEN is not set', async () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({});
      // Re-import to trigger factory
      const registry = await import('./registry.js');
      const factory = registry.getChannelFactory('telegram');
      expect(factory).toBeDefined();

      const channel = factory!(createTestOpts());
      expect(channel).toBeNull();
    });
  });

  // --- Connection ---

  describe('connection lifecycle', () => {
    it('connects and starts polling', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');

      await channel.connect();
      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      expect(messageHandler).toBeDefined();

      const ctx = createMessageContext();
      await messageHandler!(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({
          content: 'Hello',
          sender_name: 'Alice Smith',
          sender: '@alice',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      const ctx = createMessageContext({
        chat: { id: 9999, type: 'group', title: 'Other Group' },
      });
      await messageHandler!(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:9999',
        expect.any(String),
        'Other Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles DM messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:12345': {
            name: 'DM',
            folder: 'dm-alice',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      const ctx = createMessageContext({
        chat: { id: 12345, type: 'private' },
      });
      await messageHandler!(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:12345',
        expect.any(String),
        'Alice',
        'telegram',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('skips messages with no content', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      const ctx = createMessageContext({
        message: {
          message_id: 2,
          date: Math.floor(Date.now() / 1000),
          chat: { id: -1001234567890 },
          // No text, no caption, no voice
        },
      });
      await messageHandler!(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('extracts caption from messages', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      const ctx = createMessageContext({
        message: {
          message_id: 3,
          date: Math.floor(Date.now() / 1000),
          caption: 'Photo caption',
          chat: { id: -1001234567890 },
        },
      });
      await messageHandler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ content: 'Photo caption' }),
      );
    });

    it('uses sender ID when username is absent', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      const ctx = createMessageContext({
        from: { id: 12345, first_name: 'Bob', is_bot: false },
      });
      await messageHandler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({
          sender: '12345',
          sender_name: 'Bob',
        }),
      );
    });

    it('detects bot self-messages', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      const ctx = createMessageContext({
        from: {
          id: 999, // matches fakeBotInfo.id
          is_bot: true,
          first_name: 'TestBot',
          username: 'testbot',
        },
      });
      await messageHandler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });
  });

  // --- Voice messages ---

  describe('voice message handling', () => {
    it('transcribes voice when transcription is available', async () => {
      vi.mocked(isTranscriptionAvailable).mockReturnValue(true);
      vi.mocked(transcribeAudio).mockResolvedValue('Hello from voice');

      mockGetFile.mockResolvedValue({
        file_id: 'file-123',
        file_path: 'voice/file.ogg',
      });

      // Mock fetch for file download
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        arrayBuffer: () =>
          Promise.resolve(new ArrayBuffer(100)),
      }) as unknown as typeof fetch;

      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      const ctx = createMessageContext({
        message: {
          message_id: 10,
          date: Math.floor(Date.now() / 1000),
          voice: { file_id: 'file-123', duration: 5 },
          chat: { id: -1001234567890 },
        },
      });
      await messageHandler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({
          content: '[Voice: Hello from voice]',
        }),
      );

      globalThis.fetch = originalFetch;
    });

    it('shows unavailable message when transcription is disabled', async () => {
      vi.mocked(isTranscriptionAvailable).mockReturnValue(false);

      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      const ctx = createMessageContext({
        message: {
          message_id: 11,
          date: Math.floor(Date.now() / 1000),
          voice: { file_id: 'file-456', duration: 3 },
          chat: { id: -1001234567890 },
        },
      });
      await messageHandler!(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({
          content: '[Voice message - transcription unavailable]',
        }),
      );
    });
  });

  // --- Outgoing messages ---

  describe('sendMessage', () => {
    it('sends message to correct chat ID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Hello');

      expect(mockSendMessage).toHaveBeenCalledWith(-1001234567890, 'Hello');
    });

    it('splits long messages at 4096 chars', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      const longText = 'A'.repeat(5000);
      await channel.sendMessage('tg:12345', longText);

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it('warns on invalid JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      await channel.sendMessage('tg:invalid', 'Hello');

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns tg: prefixed JIDs', () => {
      const channel = new TelegramChannel(createTestOpts(), 'test-token');
      expect(channel.ownsJid('tg:12345')).toBe(true);
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new TelegramChannel(createTestOpts(), 'test-token');
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });
  });

  // --- Typing indicator ---

  describe('setTyping', () => {
    it('sends typing action', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      await channel.setTyping('tg:-1001234567890', true);

      expect(mockSendChatAction).toHaveBeenCalledWith(
        -1001234567890,
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(opts, 'test-token');
      await channel.connect();

      await channel.setTyping('tg:-1001234567890', false);

      expect(mockSendChatAction).not.toHaveBeenCalled();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel(createTestOpts(), 'test-token');
      expect(channel.name).toBe('telegram');
    });
  });
});
