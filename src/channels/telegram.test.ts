import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../core/env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../core/config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  PERMISSION_APPROVAL_TIMEOUT_MS: 300000,
  TELEGRAM_PERMISSION_APPROVER_IDS: new Set<string>(),
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../core/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock group-folder (used by downloadFile)
vi.mock('../platform/group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
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
      sendMessage: vi.fn().mockResolvedValue({ message_id: 987 }),
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      config: { use: vi.fn() },
      raw: null as any,
    };

    constructor(token: string) {
      this.token = token;
      this.api.raw = {
        sendMessage: vi.fn((params: any) => {
          const { chat_id, text, ...rest } = params;
          return this.api.sendMessage(chat_id.toString(), text, rest);
        }),
        sendMessageDraft: vi.fn((params: any) => {
          const { chat_id, draft_id, text, ...rest } = params;
          return this.api.sendMessageDraft(chat_id, draft_id, text, rest);
        }),
      };
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

    use(_middleware: Handler) {}

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
}));

import fs from 'fs';
import { TelegramChannel, TelegramChannelOpts } from './telegram.js';
import { registerChannel } from './registry.js';
import { readEnvFile } from '../core/env.js';
import { logger } from '../core/logger.js';

// Capture the factory at import time (before clearAllMocks runs)
const telegramFactoryCall = vi
  .mocked(registerChannel)
  .mock.calls.find((c) => c[0] === 'telegram');
const telegramFactory = telegramFactoryCall?.[1];

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
  reply_to_message?: any;
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
      reply_to_message: overrides.reply_to_message,
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

async function triggerCallbackQuery(ctx: {
  callbackQuery: { data: string };
  chat: { id: number };
  from: { id: number; first_name?: string; username?: string };
  answerCallbackQuery: ReturnType<typeof vi.fn>;
}) {
  const handlers = currentBot().filterHandlers.get('callback_query:data') || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

// Helper: flush pending microtasks (for async downloadFile().then() chains)
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock fs operations used by downloadFile
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    // Mock global fetch for file downloads
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

    it('skips bot commands (/chatid, /ping) but passes other / messages through', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Bot commands should be skipped
      const ctx1 = createTextCtx({ text: '/chatid' });
      await triggerTextMessage(ctx1);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      const ctx2 = createTextCtx({ text: '/ping' });
      await triggerTextMessage(ctx2);
      expect(opts.onMessage).not.toHaveBeenCalled();

      // Non-bot /commands should flow through
      const ctx3 = createTextCtx({ text: '/remote-control' });
      await triggerTextMessage(ctx3);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '/remote-control' }),
      );
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

  // --- Reply context ---

  describe('reply context', () => {
    it('extracts reply_to fields when replying to a text message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Yes, on my way!',
        reply_to_message: {
          message_id: 42,
          text: 'Are you coming tonight?',
          from: { id: 777, first_name: 'Bob', username: 'bob_user' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'Yes, on my way!',
          reply_to_message_id: '42',
          reply_to_message_content: 'Are you coming tonight?',
          reply_to_sender_name: 'Bob',
        }),
      );
    });

    it('uses caption when reply has no text (media reply)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Nice photo!',
        reply_to_message: {
          message_id: 50,
          caption: 'Check this out',
          from: { id: 888, first_name: 'Carol' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_content: 'Check this out',
        }),
      );
    });

    it('falls back to Unknown when reply sender has no from', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Interesting',
        reply_to_message: {
          message_id: 60,
          text: 'Channel post',
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: '60',
          reply_to_sender_name: 'Unknown',
        }),
      );
    });

    it('does not set reply fields when no reply_to_message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Just a normal message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: undefined,
          reply_to_message_content: undefined,
          reply_to_sender_name: undefined,
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('downloads photo and includes path in content', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: {
          photo: [
            { file_id: 'small_id', width: 90 },
            { file_id: 'large_id', width: 800 },
          ],
        },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('large_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo] (/workspace/group/attachments/photo_1.jpg)',
        }),
      );
    });

    it('downloads photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        caption: 'Look at this',
        extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Photo] (/workspace/group/attachments/photo_1.jpg) Look at this',
        }),
      );
    });

    it('falls back to placeholder when getFile returns no file_path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // getFile succeeds but returns no file_path (lines 121-123)
      currentBot().api.getFile.mockResolvedValueOnce({});

      const ctx = createMediaCtx({
        caption: 'Uploaded',
        extra: { photo: [{ file_id: 'no_path_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Uploaded' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        { fileId: 'no_path_id' },
        'Telegram getFile returned no file_path',
      );
    });

    it('falls back to placeholder when fetch response is not ok', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // getFile succeeds with a file_path, but fetch returns non-ok (lines 139-144)
      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'photos/file_0.jpg',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      );

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'fetch_fail_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        { fileId: 'fetch_fail_id', status: 404 },
        'Telegram file download failed',
      );
    });

    it('falls back to placeholder when file exceeds max size via content-length', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'photos/file_0.jpg',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: {
            get: (name: string) =>
              name === 'content-length' ? String(60 * 1024 * 1024) : null,
          },
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        }),
      );

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'too_large_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          declaredLength: 60 * 1024 * 1024,
        }),
        'Telegram file exceeds max allowed size',
      );
    });

    it('falls back to placeholder when download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Make getFile reject
      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createMediaCtx({
        caption: 'Check this',
        extra: { photo: [{ file_id: 'bad_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Check this' }),
      );
    });

    it('rejects unsafe Telegram file paths', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: '../secrets/token.txt',
      });

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'unsafe_path', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        { fileId: 'unsafe_path', filePath: '[unsafe-file-path]' },
        'Rejected unsafe Telegram file path',
      );
    });

    it('redacts bot token in download error logs', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('super-secret-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'photos/file_0.jpg',
      });
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValue(
            new Error('request failed for super-secret-token endpoint'),
          ),
      );

      const ctx = createMediaCtx({
        extra: { photo: [{ file_id: 'redact_test', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'redact_test',
          error: expect.stringContaining('[REDACTED_BOT_TOKEN]'),
        }),
        'Failed to download Telegram file',
      );
    });

    it('downloads document and includes filename and path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'documents/file_0.pdf',
      });

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf', file_id: 'doc_id' } },
      });
      await triggerMediaMessage('message:document', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('doc_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Document: report.pdf] (/workspace/group/attachments/report.pdf)',
        }),
      );
    });

    it('downloads video', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'videos/file_0.mp4',
      });

      const ctx = createMediaCtx({
        extra: { video: { file_id: 'vid_id' } },
      });
      await triggerMediaMessage('message:video', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('vid_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Video] (/workspace/group/attachments/video_1.mp4)',
        }),
      );
    });

    it('downloads voice message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'voice/file_0.oga',
      });

      const ctx = createMediaCtx({
        extra: { voice: { file_id: 'voice_id' } },
      });
      await triggerMediaMessage('message:voice', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('voice_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice message] (/workspace/group/attachments/voice_1.oga)',
        }),
      );
    });

    it('downloads audio with original filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'audio/file_0.mp3',
      });

      const ctx = createMediaCtx({
        extra: { audio: { file_id: 'audio_id', file_name: 'song.mp3' } },
      });
      await triggerMediaMessage('message:audio', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Audio] (/workspace/group/attachments/song.mp3)',
        }),
      );
    });

    it('stores sticker with emoji (no download)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(currentBot().api.getFile).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder (no download)', async () => {
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

    it('stores contact with placeholder (no download)', async () => {
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
      await flushPromises();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'documents/file_0.bin',
      });

      const ctx = createMediaCtx({
        extra: { document: { file_id: 'doc_id' } },
      });
      await triggerMediaMessage('message:document', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Document: file] (/workspace/group/attachments/file.bin)',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('download + polling edge cases', () => {
    it('throws when download response has neither reader nor arrayBuffer', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());

      await expect(
        (channel as any).writeFetchResponseToFile(
          { body: null, headers: { get: () => null } },
          '/tmp/missing-body.bin',
        ),
      ).rejects.toThrow('Telegram download response body is missing');
    });

    it('returns false when arrayBuffer response exceeds max size', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());

      const large = new Uint8Array(51 * 1024 * 1024).buffer;
      const wrote = await (channel as any).writeFetchResponseToFile(
        {
          body: null,
          headers: { get: () => null },
          arrayBuffer: vi.fn().mockResolvedValue(large),
        },
        '/tmp/too-large.bin',
      );

      expect(wrote).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bytes: 51 * 1024 * 1024 }),
        'Telegram file exceeds max allowed size',
      );
    });

    it('streams chunks to disk when reader is available', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      const openSpy = vi.spyOn(fs, 'openSync').mockReturnValue(77 as any);
      const writeSpy = vi.spyOn(fs, 'writeSync').mockReturnValue(1 as any);
      const closeSpy = vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);
      const reader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: new Uint8Array([1, 2, 3]),
          })
          .mockResolvedValueOnce({
            done: false,
            value: new Uint8Array([4]),
          })
          .mockResolvedValueOnce({ done: true }),
      };

      const wrote = await (channel as any).writeFetchResponseToFile(
        {
          body: { getReader: () => reader },
          headers: { get: () => null },
        },
        '/tmp/stream-success.bin',
      );

      expect(wrote).toBe(true);
      expect(openSpy).toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalledTimes(2);
      expect(closeSpy).toHaveBeenCalledWith(77);
      expect(unlinkSpy).not.toHaveBeenCalled();
    });

    it('cleans up partial file when streamed download exceeds max size', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      vi.spyOn(fs, 'openSync').mockReturnValue(88 as any);
      vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);
      const reader = {
        read: vi.fn().mockResolvedValueOnce({
          done: false,
          value: { byteLength: 60 * 1024 * 1024 },
        }),
      };

      const wrote = await (channel as any).writeFetchResponseToFile(
        {
          body: { getReader: () => reader },
          headers: { get: () => null },
        },
        '/tmp/stream-too-large.bin',
      );

      expect(wrote).toBe(false);
      expect(unlinkSpy).toHaveBeenCalledWith('/tmp/stream-too-large.bin');
    });

    it('rethrows stream read errors and marks partial file for cleanup', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      vi.spyOn(fs, 'openSync').mockReturnValue(99 as any);
      vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);
      const reader = {
        read: vi.fn().mockRejectedValue(new Error('stream read failed')),
      };

      await expect(
        (channel as any).writeFetchResponseToFile(
          {
            body: { getReader: () => reader },
            headers: { get: () => null },
          },
          '/tmp/stream-throw.bin',
        ),
      ).rejects.toThrow('stream read failed');
      expect(unlinkSpy).toHaveBeenCalledWith('/tmp/stream-throw.bin');
    });

    it('retries polling after failure and executes retry callback', async () => {
      vi.useFakeTimers();
      try {
        const opts = createTestOpts();
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        currentBot().start = vi.fn().mockRejectedValue(new Error('poll crash'));
        const startPollingSpy = vi.spyOn(channel as any, 'startPolling');

        (channel as any).startPolling();
        await vi.runAllTicks();
        await Promise.resolve();
        expect(logger.error).toHaveBeenCalledWith(
          { err: expect.any(Error) },
          'Telegram polling failed',
        );

        // Execute the scheduled retry callback to cover timer callback path.
        vi.runOnlyPendingTimers();
        expect(startPollingSpy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'MarkdownV2' },
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
        { parse_mode: 'MarkdownV2' },
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
        { parse_mode: 'MarkdownV2' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        { parse_mode: 'MarkdownV2' },
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

    it('falls back to escaped MarkdownV2 when raw MarkdownV2 fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessage.mockReset();
      currentBot()
        .api.sendMessage.mockRejectedValueOnce(new Error('Bad MarkdownV2'))
        .mockResolvedValueOnce({ message_id: 1 });

      await channel.sendMessage('tg:100200300', 'Hello (world)');

      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'Hello (world)',
        { parse_mode: 'MarkdownV2' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'Hello \\(world\\)',
        { parse_mode: 'MarkdownV2' },
      );
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });
  });

  describe('sendStreamingChunk', () => {
    it('uses sendMessageDraft in private chats and sends final message on done', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendStreamingChunk('tg:100200300', 'Hello ');
      await channel.sendStreamingChunk('tg:100200300', 'world');
      await channel.sendStreamingChunk('tg:100200300', '', { done: true });

      expect(currentBot().api.sendMessageDraft).toHaveBeenCalledWith(
        100200300,
        expect.any(Number),
        expect.stringContaining('Hello'),
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
      expect(currentBot().api.sendMessage).toHaveBeenLastCalledWith(
        '100200300',
        'Hello world',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
    });

    it('streams in groups via send+edit fallback', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendStreamingChunk('tg:-1001234567890', 'group update');
      await channel.sendStreamingChunk('tg:-1001234567890', '', { done: true });

      expect(currentBot().api.sendMessageDraft).not.toHaveBeenCalled();
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'group update',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '-1001234567890',
        987,
        'group update',
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
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
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
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

  describe('permission approvals', () => {
    it('sends approval prompt and resolves when an admin approves', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-1',
          sourceGroup: 'whatsapp_main',
          toolName: 'Bash',
          title: 'Allow command',
        },
      );
      await flushPromises();

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        expect.stringContaining('Permission request: perm-1'),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.any(Array),
          }),
        }),
      );

      const callbackCtx = {
        callbackQuery: { data: 'perm:approve:perm-1' },
        chat: { id: 100200300 },
        from: { id: 12345, first_name: 'Ravi' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(callbackCtx);
      const decision = await decisionPromise;

      expect(decision).toEqual({
        approved: true,
        decidedBy: 'Ravi',
        reason: 'approved via Telegram',
      });
      expect(callbackCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Approved.',
      });
      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '100200300',
        987,
        expect.stringContaining('Status: APPROVED by Ravi'),
        expect.objectContaining({
          reply_markup: { inline_keyboard: [] },
        }),
      );
    });

    it('rejects non-admin callbacks and keeps the request pending', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot()
        .api.getChatMember.mockResolvedValueOnce({ status: 'member' })
        .mockResolvedValueOnce({ status: 'administrator' });

      const decisionPromise = channel.requestPermissionApproval(
        'tg:100200300',
        {
          requestId: 'perm-2',
          sourceGroup: 'whatsapp_main',
          toolName: 'Write',
        },
      );
      await flushPromises();

      const deniedCtx = {
        callbackQuery: { data: 'perm:deny:perm-2' },
        chat: { id: 100200300 },
        from: { id: 333, first_name: 'Visitor' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(deniedCtx);
      expect(deniedCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Only approved admins can make this decision.',
        show_alert: true,
      });

      const approvedCtx = {
        callbackQuery: { data: 'perm:approve:perm-2' },
        chat: { id: 100200300 },
        from: { id: 444, first_name: 'Admin' },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      await triggerCallbackQuery(approvedCtx);
      const decision = await decisionPromise;
      expect(decision.approved).toBe(true);
      expect(decision.decidedBy).toBe('Admin');
    });

    it('auto-denies approval request after timeout', async () => {
      vi.useFakeTimers();
      try {
        const opts = createTestOpts();
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const decisionPromise = channel.requestPermissionApproval(
          'tg:100200300',
          {
            requestId: 'perm-timeout',
            sourceGroup: 'whatsapp_main',
            toolName: 'Edit',
          },
        );
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(300_000);
        const decision = await decisionPromise;
        expect(decision).toEqual({
          approved: false,
          decidedBy: 'system',
          reason: 'timed out',
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });

  // --- bot.catch error handler (line 393) ---

  describe('bot.catch error handler', () => {
    it('invokes errorHandler and logs the error message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const errorHandler = currentBot().errorHandler!;
      expect(errorHandler).not.toBeNull();

      // Invoke the error handler as grammy would
      errorHandler({ message: 'Polling error occurred' });

      const { logger: mockLogger } = await import('../core/logger.js');
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: 'Polling error occurred' },
        'Telegram bot error',
      );
    });
  });

  // --- sendMessage outer catch (line 434) ---

  describe('sendMessage outer catch', () => {
    it('logs error when both Markdown and plain text sends fail', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Reject ALL calls to sendMessage so the outer catch fires
      const apiError = new Error('Chat not found');
      currentBot().api.sendMessage.mockRejectedValue(apiError);

      await channel.sendMessage('tg:100200300', 'This will fail');

      const { logger: mockLogger } = await import('../core/logger.js');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:100200300' }),
        'Failed to send Telegram message',
      );
    });
  });
});

// --- registerChannel factory (lines 468-475) ---

describe('registerChannel factory', () => {
  it('registerChannel was called at import time with "telegram" name', () => {
    expect(telegramFactoryCall).toBeDefined();
    expect(telegramFactoryCall![0]).toBe('telegram');
    expect(typeof telegramFactory).toBe('function');
  });

  it('factory returns null when TELEGRAM_BOT_TOKEN is not set', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({});

    const saved = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const result = telegramFactory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Telegram: TELEGRAM_BOT_TOKEN not set',
      );
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });

  it('factory returns a TelegramChannel when token is available', () => {
    vi.mocked(readEnvFile).mockReturnValueOnce({
      TELEGRAM_BOT_TOKEN: 'test-token-from-env',
    });

    const saved = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const result = telegramFactory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(TelegramChannel);
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });
});
