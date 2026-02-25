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

// Mock elevenlabs
const mockTranscribeAudio = vi.fn();
vi.mock('../elevenlabs.js', () => ({
  transcribeAudio: (...args: any[]) => mockTranscribeAudio(...args),
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file_0.oga' }),
      sendVoice: vi.fn().mockResolvedValue(undefined),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
  InputFile: class MockInputFile {
    constructor(public data: any, public name?: string) {}
  },
}));

import { TelegramChannel, TelegramChannelOpts } from './telegram.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      ...(overrides.extra || {}),
    },
    me: { username: 'andy_ai_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips command messages (starting with /)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: '/start' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
        'telegram',
        false,
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
        'telegram',
        true,
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot_username mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@Andy @andy_ai_bot hello',
        entities: [{ type: 'mention', offset: 6, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot hello',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @andy_ai_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Bot is mentioned, message doesn't match trigger → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy hey @andy_ai_bot check this',
        }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores photo with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('stores photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ caption: 'Look at this' });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Look at this' }),
      );
    });

    it('stores video with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores voice message with transcription-unavailable fallback', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Voice handler now attempts transcription; the getFile mock returns
      // a file_path but fetch isn't stubbed, so it falls back gracefully.
      const ctx = createMediaCtx({
        extra: { voice: { file_id: 'voice_123' } },
      });
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice message - transcription unavailable]',
        }),
      );
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores document with filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf' } },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: report.pdf]' }),
      );
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ extra: { document: {} } });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: file]' }),
      );
    });

    it('stores sticker with emoji', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
      );
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
      );
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });
  });

  // --- Voice message handling ---

  describe('voice message handling', () => {
    function createVoiceCtx(overrides: {
      chatId?: number;
      chatType?: string;
      fromId?: number;
      firstName?: string;
      date?: number;
      messageId?: number;
      caption?: string;
      fileId?: string;
    }) {
      const chatId = overrides.chatId ?? 100200300;
      return {
        chat: {
          id: chatId,
          type: overrides.chatType ?? 'group',
          title: 'Test Group',
        },
        from: {
          id: overrides.fromId ?? 99001,
          first_name: overrides.firstName ?? 'Alice',
          username: 'alice_user',
        },
        message: {
          date: overrides.date ?? Math.floor(Date.now() / 1000),
          message_id: overrides.messageId ?? 1,
          caption: overrides.caption,
          voice: { file_id: overrides.fileId ?? 'voice_file_123' },
        },
        me: { username: 'andy_ai_bot' },
      };
    }

    it('transcribes voice message and stores as [Voice: transcript]', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Mock fetch for file download
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      vi.stubGlobal('fetch', mockFetch);
      mockTranscribeAudio.mockResolvedValue('Hello from voice');

      const ctx = createVoiceCtx({});
      await triggerMediaMessage('message:voice', ctx);

      expect(currentBot().api.getFile).toHaveBeenCalledWith('voice_file_123');
      expect(mockTranscribeAudio).toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice: Hello from voice]',
        }),
      );

      vi.unstubAllGlobals();
    });

    it('falls back to placeholder when transcription fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      vi.stubGlobal('fetch', mockFetch);
      mockTranscribeAudio.mockResolvedValue(null);

      const ctx = createVoiceCtx({});
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice message - transcription unavailable]',
        }),
      );

      vi.unstubAllGlobals();
    });

    it('falls back to placeholder when file download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const mockFetch = vi.fn().mockResolvedValue({ ok: false });
      vi.stubGlobal('fetch', mockFetch);

      const ctx = createVoiceCtx({});
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice message - transcription unavailable]',
        }),
      );

      vi.unstubAllGlobals();
    });

    it('falls back to placeholder when getFile throws', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createVoiceCtx({});
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice message - transcription unavailable]',
        }),
      );
    });

    it('includes caption with voice transcript', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      vi.stubGlobal('fetch', mockFetch);
      mockTranscribeAudio.mockResolvedValue('Hello');

      const ctx = createVoiceCtx({ caption: 'check this' });
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice: Hello] check this',
        }),
      );

      vi.unstubAllGlobals();
    });

    it('ignores voice from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createVoiceCtx({ chatId: 999999 });
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendVoiceMessage ---

  describe('sendVoiceMessage', () => {
    it('sends voice via bot API and returns true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const audioBuffer = Buffer.from([1, 2, 3]);
      const result = await channel.sendVoiceMessage('tg:100200300', audioBuffer);

      expect(result).toBe(true);
      expect(currentBot().api.sendVoice).toHaveBeenCalledWith(
        '100200300',
        expect.any(Object), // InputFile mock
      );
    });

    it('returns false when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      const result = await channel.sendVoiceMessage('tg:100200300', Buffer.from([1]));

      expect(result).toBe(false);
    });

    it('returns false on API error', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendVoice.mockRejectedValueOnce(new Error('Send failed'));

      const result = await channel.sendVoiceMessage('tg:100200300', Buffer.from([1]));

      expect(result).toBe(false);
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendVoiceMessage('tg:-1001234567890', Buffer.from([1]));

      expect(currentBot().api.sendVoice).toHaveBeenCalledWith(
        '-1001234567890',
        expect.any(Object),
      );
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });

  // --- Multi-bot routing ---

  describe('multi-bot routing (forGroupFolder)', () => {
    const multiGroupRegistry = () => ({
      'tg:100200300': {
        name: 'Ruby Chat',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'tg:400500600': {
        name: 'Dora Chat',
        folder: 'dora',
        trigger: '@Dora',
        added_at: '2024-06-01T00:00:00.000Z',
      },
      'tg:700800900': {
        name: 'Another Group',
        folder: 'other',
        trigger: '@Andy',
        added_at: '2024-07-01T00:00:00.000Z',
      },
    });

    it('forGroupFolder channel only owns JIDs mapped to that folder', () => {
      const channel = new TelegramChannel(
        'dora-token',
        createTestOpts({
          registeredGroups: multiGroupRegistry,
          forGroupFolder: 'dora',
        }),
      );

      expect(channel.ownsJid('tg:400500600')).toBe(true);
      expect(channel.ownsJid('tg:100200300')).toBe(false);
      expect(channel.ownsJid('tg:700800900')).toBe(false);
      expect(channel.ownsJid('tg:999999')).toBe(false);
    });

    it('catch-all channel (no forGroupFolder) owns all tg: JIDs', () => {
      const channel = new TelegramChannel(
        'ruby-token',
        createTestOpts({ registeredGroups: multiGroupRegistry }),
      );

      expect(channel.ownsJid('tg:100200300')).toBe(true);
      expect(channel.ownsJid('tg:400500600')).toBe(true);
      expect(channel.ownsJid('tg:700800900')).toBe(true);
      expect(channel.ownsJid('tg:999999')).toBe(true);
    });

    it('forGroupFolder channel does not own non-tg: JIDs', () => {
      const channel = new TelegramChannel(
        'dora-token',
        createTestOpts({
          registeredGroups: multiGroupRegistry,
          forGroupFolder: 'dora',
        }),
      );

      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('random')).toBe(false);
    });

    it('forGroupFolder channel does not own unregistered tg: JIDs', () => {
      const channel = new TelegramChannel(
        'dora-token',
        createTestOpts({
          registeredGroups: multiGroupRegistry,
          forGroupFolder: 'dora',
        }),
      );

      expect(channel.ownsJid('tg:111222333')).toBe(false);
    });

    it('/ping uses botName when provided', async () => {
      const channel = new TelegramChannel(
        'dora-token',
        createTestOpts({
          registeredGroups: multiGroupRegistry,
          forGroupFolder: 'dora',
          botName: 'Dora',
        }),
      );
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Dora is online.');
    });

    it('/ping falls back to ASSISTANT_NAME when botName not set', async () => {
      const channel = new TelegramChannel(
        'ruby-token',
        createTestOpts({ registeredGroups: multiGroupRegistry }),
      );
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });

    it('@mention translation uses botName', async () => {
      const doraOpts = createTestOpts({
        registeredGroups: () => ({
          'tg:400500600': {
            name: 'Dora Chat',
            folder: 'dora',
            trigger: '@Dora',
            added_at: '2024-06-01T00:00:00.000Z',
          },
        }),
        forGroupFolder: 'dora',
        botName: 'Dora',
      });
      const channel = new TelegramChannel('dora-token', doraOpts);
      await channel.connect();

      // The mock Bot always reports username 'andy_ai_bot', so we use that
      // in the mention entity. In production, Dora's bot would have its own username.
      const ctx = createTextCtx({
        chatId: 400500600,
        text: '@andy_ai_bot do research',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // botName 'Dora' should be used in the prepended trigger, not ASSISTANT_NAME
      expect(doraOpts.onMessage).toHaveBeenCalledWith(
        'tg:400500600',
        expect.objectContaining({
          content: '@Dora @andy_ai_bot do research',
        }),
      );
    });
  });
});
