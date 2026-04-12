import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  DEFAULT_MODEL: 'claude-sonnet-4-20250514',
  TIMEZONE: 'Asia/Tokyo',
  TRIGGER_PATTERN: /^@Andy\b/i,
  LIVE_LOCATION_IDLE_TIMEOUT_MS: 600000,
  LIVE_LOCATION_LOG_DIR: '/tmp/test-data/location_logs',
  resolveModelAlias: vi.fn((name: string) => {
    const aliases: Record<string, string> = {
      opus: 'claude-opus-4-20250514',
      sonnet: 'claude-sonnet-4-20250514',
      haiku: 'claude-haiku-4-20250514',
    };
    return aliases[name.toLowerCase()] || name;
  }),
  loadModelAliases: vi.fn(() => ({
    opus: 'claude-opus-4-20250514',
    sonnet: 'claude-sonnet-4-20250514',
    haiku: 'claude-haiku-4-20250514',
  })),
}));

// Mock live-location module
vi.mock('../live-location.js', () => {
  const MockLiveLocationManager = vi.fn(function MockLiveLocationManager() {
    return {
      initialize: vi.fn(),
      startSession: vi.fn(
        () => '/tmp/test-data/location_logs/_100200300_1.log',
      ),
      updateSession: vi.fn(() => 'updated'),
      stopSession: vi.fn(),
      getLatestPosition: vi.fn(() => undefined),
      destroy: vi.fn(),
    };
  });
  return {
    LiveLocationManager: MockLiveLocationManager,
    buildLocationPrefix: vi.fn(
      (label: string, lat: number, lng: number, logPath: string) =>
        `${label} lat: ${lat}, long: ${lng}. check \`tail ${logPath}\``,
    ),
    _setActiveLiveLocationManager: vi.fn(),
    getActiveLiveLocationContext: vi.fn(() => ''),
  };
});

// Mock db functions used by /model and /tasks commands
vi.mock('../db.js', () => ({
  setGroupModel: vi.fn(),
  setGroupEffort: vi.fn(),

  getTaskById: vi.fn((id: string) => {
    if (id === 'task-123') {
      return {
        id: 'task-123',
        group_folder: 'test-group',
        chat_jid: 'tg:100200300',
        prompt: 'heartbeat',
        schedule_type: 'cron',
        schedule_value: '0 */4 * * *',
        model: null,
        status: 'active',
      };
    }
    return undefined;
  }),
  getTasksForGroup: vi.fn((folder: string) => {
    if (folder === 'test-group') {
      return [
        {
          id: 'task-123',
          prompt: 'heartbeat flow',
          schedule_type: 'cron',
          schedule_value: '0 */4 * * *',
          model: 'claude-haiku-4-20250514',
          status: 'active',
          last_run: '2026-04-05T23:00:00.000Z',
          next_run: '2026-04-06T03:00:00.000Z',
        },
        {
          id: 'task-456',
          prompt: 'weekly report',
          schedule_type: 'once',
          schedule_value: '2026-04-10T09:00',
          model: null,
          status: 'active',
          last_run: null,
          next_run: '2026-04-10T00:00:00.000Z',
        },
      ];
    }
    return [];
  }),
  updateTask: vi.fn(),
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

// Mock group-folder (used by downloadFile)
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
}));

// --- Grammy mock ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  InputFile: class MockInputFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  },
  InlineKeyboard: class MockInlineKeyboard {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buttons: any[][] = [[]];
    text(label: string, data: string) {
      this.buttons[this.buttons.length - 1].push({
        text: label,
        callback_data: data,
      });
      return this;
    }
    row() {
      this.buttons.push([]);
      return this;
    }
  },
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    callbackQueryHandlers: Array<{
      pattern: RegExp | string;
      handler: Handler;
    }> = [];
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      setMyCommands: vi.fn().mockResolvedValue(undefined),
      deleteMyCommands: vi.fn().mockResolvedValue(undefined),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    callbackQuery(pattern: RegExp | string, handler: Handler) {
      this.callbackQueryHandlers.push({ pattern, handler });
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
}));

import fs from 'fs';
import { setGroupModel, setGroupEffort, updateTask } from '../db.js';
import { loadModelAliases } from '../config.js';
import { getActiveLiveLocationContext } from '../live-location.js';
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
    getStatus: vi.fn(() => ({
      activeContainers: 1,
      uptimeSeconds: 9240,
      sessions: { 'test-group': 'session-abc123-def456' },
      lastUsage: {
        'test-group': { inputTokens: 45200, outputTokens: 3100, numTurns: 12 },
      },
    })),
    sendIpcMessage: vi.fn(() => true),
    clearSession: vi.fn(),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entities?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createEditedLocationCtx(location: Record<string, any>) {
  return {
    chat: { id: 100200300, type: 'group', title: 'Test Group' },
    from: { id: 99001, first_name: 'Alice', username: 'alice_user' },
    editedMessage: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      location,
    },
    me: { username: 'andy_ai_bot' },
  };
}

async function triggerEditedLocationMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
) {
  const handlers =
    currentBot().filterHandlers.get('edited_message:location') || [];
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
      expect(currentBot().commandHandlers.has('model')).toBe(true);
      expect(currentBot().commandHandlers.has('effort')).toBe(true);
      expect(currentBot().commandHandlers.has('status')).toBe(true);
      expect(currentBot().commandHandlers.has('compact')).toBe(true);
      expect(currentBot().commandHandlers.has('clear')).toBe(true);
      expect(currentBot().commandHandlers.has('tasks')).toBe(true);
      expect(currentBot().api.setMyCommands).toHaveBeenCalledWith([
        { command: 'chatid', description: 'Show chat ID for registration' },
        { command: 'ping', description: 'Check bot status' },
        { command: 'model', description: 'View or change the AI model' },
        { command: 'effort', description: 'Set thinking effort level' },
        { command: 'status', description: 'Show system status' },
        { command: 'compact', description: 'Compact conversation context' },
        { command: 'clear', description: 'Clear conversation session' },
        { command: 'tasks', description: 'List scheduled tasks' },
      ]);
      // Clears stale commands from scoped menus (e.g. leftover OpenClaw commands)
      expect(currentBot().api.deleteMyCommands).toHaveBeenCalledTimes(3);
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

    it('skips bot commands (/chatid, /ping, /model, /status, /compact, /clear) but passes other / messages through', async () => {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.from.first_name = undefined as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    it('stores static location with placeholder (no live_period)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Provide an explicit location object without live_period — static location
      const ctx = createMediaCtx({
        extra: { location: { latitude: 35.6762, longitude: 139.6503 } },
      });
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

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'Markdown' },
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
        { parse_mode: 'Markdown' },
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
        { parse_mode: 'Markdown' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        { parse_mode: 'Markdown' },
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

  // --- sendPhoto ---

  describe('sendPhoto', () => {
    it('sends photo with URL directly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendPhoto(
        'tg:100200300',
        'https://example.com/photo.jpg',
        'A photo',
      );

      expect(currentBot().api.sendPhoto).toHaveBeenCalledWith(
        '100200300',
        'https://example.com/photo.jpg',
        { caption: 'A photo', parse_mode: 'Markdown' },
      );
    });

    it('wraps local file path with InputFile', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendPhoto('tg:100200300', '/tmp/photo.jpg');

      const call = currentBot().api.sendPhoto.mock.calls[0];
      expect(call[0]).toBe('100200300');
      // Second arg should be a MockInputFile instance with the path
      expect(call[1]).toEqual(
        expect.objectContaining({ path: '/tmp/photo.jpg' }),
      );
      // No caption — options should be empty
      expect(call[2]).toEqual({});
    });

    it('falls back to text on sendPhoto failure', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendPhoto.mockRejectedValueOnce(
        new Error('Upload failed'),
      );

      await channel.sendPhoto(
        'tg:100200300',
        'https://example.com/big.jpg',
        'Fallback caption',
      );

      // Should have fallen back to sendMessage with caption
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Fallback caption',
        { parse_mode: 'Markdown' },
      );
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null
      await channel.sendPhoto('tg:100200300', 'https://example.com/photo.jpg');

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

  // --- /model command ---

  describe('/model command', () => {
    it('registers the model command handler', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      expect(currentBot().commandHandlers.has('model')).toBe(true);
    });

    it('/model shows current model (default) when no per-group model set', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('claude-sonnet-4-20250514'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('(default)'),
        expect.any(Object),
      );
    });

    it('/model shows current model when per-group model is set', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Test Group',
            folder: 'test-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            model: 'claude-opus-4-20250514',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('claude-opus-4-20250514'),
        expect.any(Object),
      );
      // Should NOT show "(default)" when a per-group model is set
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.not.stringContaining('(default)'),
        expect.any(Object),
      );
    });

    it('/model with empty aliases shows only Reset button', async () => {
      vi.mocked(loadModelAliases).mockReturnValueOnce({});
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model' },
        reply: vi.fn(),
      };

      await handler(ctx);

      const replyOpts = ctx.reply.mock.calls[0][1];
      expect(replyOpts.reply_markup).toBeDefined();
      const buttons = replyOpts.reply_markup.buttons.flat() as Array<{
        text: string;
        callback_data: string;
      }>;
      expect(buttons).toHaveLength(1);
      expect(buttons[0].text).toBe('Reset to default');
      expect(buttons[0].callback_data).toBe('model:reset');
    });

    it('/model shows alias list as inline keyboard buttons', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model' },
        reply: vi.fn(),
      };

      await handler(ctx);

      const replyOpts = ctx.reply.mock.calls[0][1];
      expect(replyOpts.reply_markup).toBeDefined();
      const buttons = replyOpts.reply_markup.buttons.flat() as Array<{
        text: string;
        callback_data: string;
      }>;
      const labels = buttons.map((b) => b.text);
      expect(labels.some((l) => l.includes('opus'))).toBe(true);
      expect(labels.some((l) => l.includes('sonnet'))).toBe(true);
      expect(labels.some((l) => l.includes('haiku'))).toBe(true);
    });

    it('/model <alias> sets model and preserves session', async () => {
      const groups = {
        'tg:100200300': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      };
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => groups),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model opus' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(setGroupModel).toHaveBeenCalledWith(
        'tg:100200300',
        'claude-opus-4-20250514',
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('claude-opus-4-20250514'),
        expect.any(Object),
      );
    });

    it('/model <full-id> sets model with full model ID', async () => {
      const groups = {
        'tg:100200300': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      };
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => groups),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model claude-opus-4-20250514' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(setGroupModel).toHaveBeenCalledWith(
        'tg:100200300',
        'claude-opus-4-20250514',
      );
    });

    it('/model reset clears per-group model and preserves session', async () => {
      const groups = {
        'tg:100200300': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          model: 'claude-opus-4-20250514',
        },
      };
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => groups),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model reset' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(setGroupModel).toHaveBeenCalledWith('tg:100200300', null);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('default'),
        expect.any(Object),
      );
    });

    it('/model replies error for unregistered chat', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 999999 },
        message: { text: '/model' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
      expect(setGroupModel).not.toHaveBeenCalled();
    });

    it('/model is skipped by general message handler', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: '/model opus' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    describe('model: callback queries', () => {
      function findModelCallbackHandler() {
        const bot = currentBot();
        const entry = bot.callbackQueryHandlers.find(
          (h: { pattern: RegExp | string }) =>
            h.pattern instanceof RegExp && h.pattern.source === /^model:/.source,
        );
        return entry?.handler;
      }

      it('registers the model: callback handler', async () => {
        const channel = new TelegramChannel('test-token', createTestOpts());
        await channel.connect();

        expect(findModelCallbackHandler()).toBeDefined();
      });

      it('model:set:<alias> sets the model', async () => {
        const groups: Record<
          string,
          {
            name: string;
            folder: string;
            trigger: string;
            added_at: string;
            model?: string;
          }
        > = {
          'tg:100200300': {
            name: 'Test Group',
            folder: 'test-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        };
        const opts = createTestOpts({
          registeredGroups: vi.fn(() => groups),
        });
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const handler = findModelCallbackHandler()!;
        const ctx = {
          callbackQuery: { data: 'model:set:opus' },
          chat: { id: 100200300 },
          editMessageText: vi.fn(),
          answerCallbackQuery: vi.fn(),
        };

        await handler(ctx);

        expect(setGroupModel).toHaveBeenCalledWith(
          'tg:100200300',
          'claude-opus-4-20250514',
        );
        expect(groups['tg:100200300'].model).toBe('claude-opus-4-20250514');
        expect(ctx.editMessageText).toHaveBeenCalledWith(
          expect.stringContaining('claude-opus-4-20250514'),
          expect.any(Object),
        );
        expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      });

      it('model:reset clears the model', async () => {
        const groups: Record<
          string,
          {
            name: string;
            folder: string;
            trigger: string;
            added_at: string;
            model?: string;
          }
        > = {
          'tg:100200300': {
            name: 'Test Group',
            folder: 'test-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            model: 'claude-opus-4-20250514',
          },
        };
        const opts = createTestOpts({
          registeredGroups: vi.fn(() => groups),
        });
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const handler = findModelCallbackHandler()!;
        const ctx = {
          callbackQuery: { data: 'model:reset' },
          chat: { id: 100200300 },
          editMessageText: vi.fn(),
          answerCallbackQuery: vi.fn(),
        };

        await handler(ctx);

        expect(setGroupModel).toHaveBeenCalledWith('tg:100200300', null);
        expect(groups['tg:100200300'].model).toBeUndefined();
        expect(ctx.editMessageText).toHaveBeenCalledWith(
          expect.stringContaining('default'),
          expect.any(Object),
        );
        expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      });

      it('model: callback for unregistered chat replies error', async () => {
        const opts = createTestOpts({
          registeredGroups: vi.fn(() => ({})),
        });
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const handler = findModelCallbackHandler()!;
        const ctx = {
          callbackQuery: { data: 'model:set:opus' },
          chat: { id: 999999 },
          editMessageText: vi.fn(),
          answerCallbackQuery: vi.fn(),
        };

        await handler(ctx);

        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
          'This chat is not registered.',
        );
        expect(setGroupModel).not.toHaveBeenCalled();
      });
    });
  });

  // --- /status command ---

  describe('/status command', () => {
    it('shows system status with usage data', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('status')!;
      const ctx = {
        chat: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain('Status: Online');
      expect(replyText).toContain('2h 34m');
      expect(replyText).toContain('Active containers: 1');
      expect(replyText).toContain('45,200 input tokens');
      expect(replyText).toContain('12 turns');
      expect(replyText).toContain('session-abc1');
    });

    it('shows "no usage data" when no usage available', async () => {
      const opts = createTestOpts({
        getStatus: vi.fn(() => ({
          activeContainers: 0,
          uptimeSeconds: 120,
          sessions: {},
          lastUsage: {},
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('status')!;
      const ctx = {
        chat: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain('no usage data');
      expect(replyText).toContain('Session: none');
    });

    it('replies error for unregistered chat', async () => {
      const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('status')!;
      const ctx = { chat: { id: 999 }, reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
    });

    it('/status is skipped by general message handler', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: '/status' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- /compact command ---

  describe('/compact command', () => {
    it('sends compact via IPC when session is active', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('compact')!;
      const ctx = {
        chat: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(opts.sendIpcMessage).toHaveBeenCalledWith(
        'tg:100200300',
        '/compact',
      );
      expect(ctx.reply).toHaveBeenCalledWith('Compact requested.');
    });

    it('shows error when no active session', async () => {
      const opts = createTestOpts({
        sendIpcMessage: vi.fn(() => false),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('compact')!;
      const ctx = {
        chat: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('No active session to compact.');
    });

    it('replies error for unregistered chat', async () => {
      const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('compact')!;
      const ctx = { chat: { id: 999 }, reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
    });
  });

  // --- /clear command ---

  describe('/clear command', () => {
    it('clears session for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('clear')!;
      const ctx = {
        chat: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(opts.clearSession).toHaveBeenCalledWith(
        'test-group',
        'tg:100200300',
      );
      expect(ctx.reply).toHaveBeenCalledWith('Session cleared.');
    });

    it('replies error for unregistered chat', async () => {
      const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('clear')!;
      const ctx = { chat: { id: 999 }, reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
      expect(opts.clearSession).not.toHaveBeenCalled();
    });
  });

  // --- /tasks command ---

  describe('/tasks command', () => {
    it('lists tasks for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('tasks')!;
      const ctx = {
        chat: { id: 100200300 },
        reply: vi.fn(),
      };

      await handler(ctx);

      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain('task-123');
      expect(replyText).toContain('task-456');
      expect(replyText).toContain('claude-haiku-4-20250514');
      expect(replyText).toContain('(default)');
      expect(replyText).toContain('Last:');
      expect(replyText).toContain('Next:');
    });

    it('shows empty message when no tasks', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Empty Group',
            folder: 'empty-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('tasks')!;
      const ctx = { chat: { id: 100200300 }, reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('No tasks for this group.');
    });

    it('replies error for unregistered chat', async () => {
      const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('tasks')!;
      const ctx = { chat: { id: 999 }, reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
    });
  });

  // --- /model task subcommand ---

  describe('/model task subcommand', () => {
    it('sets model for a task', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model task task-123 haiku' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(updateTask).toHaveBeenCalledWith('task-123', {
        model: 'claude-haiku-4-20250514',
      });
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('claude-haiku-4-20250514'),
        expect.any(Object),
      );
    });

    it('resets task model', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model task task-123 reset' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(updateTask).toHaveBeenCalledWith('task-123', { model: null });
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('reset to default'),
        expect.any(Object),
      );
    });

    it('shows error for unknown task', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model task nonexistent haiku' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('not found'),
        expect.any(Object),
      );
      expect(updateTask).not.toHaveBeenCalled();
    });

    it('shows usage when args missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/model task' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Usage'),
        expect.any(Object),
      );
    });
  });

  // --- /effort command ---

  describe('/effort command', () => {
    function findCallbackHandler(pattern: RegExp) {
      const bot = currentBot();
      const entry = bot.callbackQueryHandlers.find(
        (h: { pattern: RegExp | string }) =>
          h.pattern instanceof RegExp && h.pattern.source === pattern.source,
      );
      return entry?.handler;
    }

    it('registers the effort command and callback handler', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      expect(currentBot().commandHandlers.has('effort')).toBe(true);
      expect(currentBot().callbackQueryHandlers.length).toBeGreaterThan(0);
    });

    it('/effort shows current effort and target selection keyboard', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      const handler = currentBot().commandHandlers.get('effort')!;
      const ctx = {
        chat: { id: 100200300 },
        message: { text: '/effort' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('default'),
        expect.objectContaining({
          parse_mode: 'Markdown',
          reply_markup: expect.anything(),
        }),
      );
    });

    it('effort:target:group shows effort level picker', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      const handler = findCallbackHandler(/^effort:/)!;
      const ctx = {
        callbackQuery: { data: 'effort:target:group' },
        chat: { id: 100200300 },
        editMessageText: vi.fn(),
        answerCallbackQuery: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Group effort'),
        expect.objectContaining({ reply_markup: expect.anything() }),
      );
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    });

    it('effort:group:high sets group effort', async () => {
      const groups: Record<
        string,
        {
          name: string;
          folder: string;
          trigger: string;
          added_at: string;
          effort?: string;
        }
      > = {
        'tg:100200300': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      };
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => groups),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = findCallbackHandler(/^effort:/)!;
      const ctx = {
        callbackQuery: { data: 'effort:group:high' },
        chat: { id: 100200300 },
        editMessageText: vi.fn(),
        answerCallbackQuery: vi.fn(),
      };

      await handler(ctx);

      expect(setGroupEffort).toHaveBeenCalledWith('tg:100200300', 'high');
      expect(groups['tg:100200300'].effort).toBe('high');
      expect(ctx.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('high'),
        expect.any(Object),
      );
    });

    it('effort:group:reset clears group effort', async () => {
      const groups = {
        'tg:100200300': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          effort: 'high',
        },
      };
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => groups),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = findCallbackHandler(/^effort:/)!;
      const ctx = {
        callbackQuery: { data: 'effort:group:reset' },
        chat: { id: 100200300 },
        editMessageText: vi.fn(),
        answerCallbackQuery: vi.fn(),
      };

      await handler(ctx);

      expect(setGroupEffort).toHaveBeenCalledWith('tg:100200300', null);
      expect(groups['tg:100200300'].effort).toBeUndefined();
    });

    it('effort:target:task shows task list', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      const handler = findCallbackHandler(/^effort:/)!;
      const ctx = {
        callbackQuery: { data: 'effort:target:task' },
        chat: { id: 100200300 },
        editMessageText: vi.fn(),
        answerCallbackQuery: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.editMessageText).toHaveBeenCalledWith(
        'Select a task:',
        expect.objectContaining({ reply_markup: expect.anything() }),
      );
    });

    it('effort:task:<id> shows effort picker for task', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      const handler = findCallbackHandler(/^effort:/)!;
      const ctx = {
        callbackQuery: { data: 'effort:task:task-123' },
        chat: { id: 100200300 },
        editMessageText: vi.fn(),
        answerCallbackQuery: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('task-123'),
        expect.objectContaining({ reply_markup: expect.anything() }),
      );
    });

    it('effort:tset:<id>:low sets task effort', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      const handler = findCallbackHandler(/^effort:/)!;
      const ctx = {
        callbackQuery: { data: 'effort:tset:task-123:low' },
        chat: { id: 100200300 },
        editMessageText: vi.fn(),
        answerCallbackQuery: vi.fn(),
      };

      await handler(ctx);

      expect(updateTask).toHaveBeenCalledWith('task-123', { effort: 'low' });
      expect(ctx.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('low'),
        expect.any(Object),
      );
    });

    it('effort:back returns to target selection', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      const handler = findCallbackHandler(/^effort:/)!;
      const ctx = {
        callbackQuery: { data: 'effort:back' },
        chat: { id: 100200300 },
        editMessageText: vi.fn(),
        answerCallbackQuery: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Select target'),
        expect.objectContaining({ reply_markup: expect.anything() }),
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

  // --- editMessage retry logic (#27) ---

  describe('editMessage', () => {
    let channel: TelegramChannel;

    beforeEach(async () => {
      channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
    });

    it('edits message with Markdown parse_mode', async () => {
      await channel.editMessage!('tg:100200300', 1, 'hello');

      expect(currentBot().api.editMessageText).toHaveBeenCalledWith(
        '100200300',
        1,
        'hello',
        { parse_mode: 'Markdown' },
      );
    });

    it('silently ignores "message is not modified" error', async () => {
      currentBot().api.editMessageText.mockRejectedValue(
        new Error('Bad Request: message is not modified'),
      );

      // Should not throw
      await channel.editMessage!('tg:100200300', 1, 'same text');
    });

    it('retries on 429 with exponential backoff', async () => {
      vi.useFakeTimers();
      const editMock = currentBot().api.editMessageText;
      editMock
        .mockRejectedValueOnce(new Error('429: Too Many Requests'))
        .mockRejectedValueOnce(new Error('429: Too Many Requests'))
        .mockResolvedValueOnce(undefined);

      const promise = channel.editMessage!('tg:100200300', 1, 'text');

      // First retry after 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      // Second retry after 2000ms
      await vi.advanceTimersByTimeAsync(2000);

      await promise;

      expect(editMock).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it('falls back to plain text on non-429 error', async () => {
      const editMock = currentBot().api.editMessageText;
      editMock
        .mockRejectedValueOnce(new Error('Bad Request: cannot parse Markdown'))
        .mockResolvedValueOnce(undefined); // plain text succeeds

      await channel.editMessage!('tg:100200300', 1, 'text');

      // Second call should be without parse_mode
      expect(editMock).toHaveBeenCalledTimes(2);
      expect(editMock.mock.calls[1]).toEqual(['100200300', 1, 'text']);
    });

    it('throws after exhausting all retries', async () => {
      vi.useFakeTimers();
      const editMock = currentBot().api.editMessageText;
      // All Markdown attempts get 429, plain text fallback also fails
      editMock.mockRejectedValue(new Error('429: Too Many Requests'));

      const promise = channel.editMessage!('tg:100200300', 1, 'text').catch(
        (e: Error) => e,
      );

      // First retry after 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      // Second retry after 2000ms
      await vi.advanceTimersByTimeAsync(2000);
      // Let microtasks flush
      await vi.advanceTimersByTimeAsync(0);

      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('429');
      vi.useRealTimers();
    });
  });

  // --- deleteMessage ---

  describe('deleteMessage', () => {
    let channel: TelegramChannel;

    beforeEach(async () => {
      channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
    });

    it('calls bot.api.deleteMessage with numeric chat ID and message ID', async () => {
      await channel.deleteMessage!('tg:100200300', 42);

      expect(currentBot().api.deleteMessage).toHaveBeenCalledWith(
        '100200300',
        42,
      );
    });

    it('strips tg: prefix from JID', async () => {
      await channel.deleteMessage!('tg:-1001234567', 7);

      expect(currentBot().api.deleteMessage).toHaveBeenCalledWith(
        '-1001234567',
        7,
      );
    });

    it('does nothing when bot is not initialized', async () => {
      const uninitChannel = new TelegramChannel('test-token', createTestOpts());
      // do NOT call connect()
      await uninitChannel.deleteMessage!('tg:100200300', 1);

      // api.deleteMessage should not be called on an unconnected channel
      expect(currentBot().api.deleteMessage).not.toHaveBeenCalled();
    });
  });

  // --- Live location ---

  describe('live location', () => {
    it('registers edited_message:location handler on connect', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();
      expect(currentBot().filterHandlers.has('edited_message:location')).toBe(
        true,
      );
    });

    it('start: calls startSession, sends system msg, calls onMessage', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Get the LiveLocationManager mock instance created inside connect()
      const { LiveLocationManager } = await import('../live-location.js');
      const mockInstance =
        vi.mocked(LiveLocationManager).mock.results[0]?.value;

      const ctx = createMediaCtx({
        extra: {
          location: {
            latitude: 35.6762,
            longitude: 139.6503,
            live_period: 600,
          },
        },
      });
      await triggerMediaMessage('message:location', ctx);

      expect(mockInstance.startSession).toHaveBeenCalledWith(
        'tg:100200300',
        1,
        35.6762,
        139.6503,
        600,
        undefined,
        undefined,
      );
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        '📍 Live location sharing start.',
        expect.anything(),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: expect.stringContaining('[Live location sharing start]'),
        }),
      );
    });

    it('start: unregistered chat is ignored', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const { LiveLocationManager } = await import('../live-location.js');
      const mockInstance =
        vi.mocked(LiveLocationManager).mock.results[0]?.value;

      const ctx = createMediaCtx({
        extra: {
          location: { latitude: 35, longitude: 139, live_period: 600 },
        },
      });
      await triggerMediaMessage('message:location', ctx);

      expect(mockInstance.startSession).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('message:text with active session prepends prefix', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      vi.mocked(getActiveLiveLocationContext).mockReturnValue(
        '[Live location sharing enabled] lat: 35, long: 139. check `tail /path/log`\n',
      );

      const ctx = createTextCtx({ text: '@Andy hello' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: expect.stringContaining(
            '[Live location sharing enabled] lat: 35, long: 139',
          ),
        }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: expect.stringContaining('@Andy hello'),
        }),
      );
    });

    it('message:text without active session leaves content unchanged', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      vi.mocked(getActiveLiveLocationContext).mockReturnValue('');

      const ctx = createTextCtx({ text: '@Andy hello' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '@Andy hello' }),
      );
    });

    it('edited_message:location update calls updateSession', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const { LiveLocationManager } = await import('../live-location.js');
      const mockInstance =
        vi.mocked(LiveLocationManager).mock.results[0]?.value;

      const ctx = createEditedLocationCtx({
        latitude: 36,
        longitude: 140,
        live_period: 600,
      });
      await triggerEditedLocationMessage(ctx);

      expect(mockInstance.updateSession).toHaveBeenCalledWith(
        'tg:100200300',
        1,
        36,
        140,
        undefined,
        undefined,
        600,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('edited_message:location stopped calls stopSession', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const { LiveLocationManager } = await import('../live-location.js');
      const mockInstance =
        vi.mocked(LiveLocationManager).mock.results[0]?.value;
      mockInstance.updateSession.mockReturnValue('stopped');

      const ctx = createEditedLocationCtx({
        latitude: 36,
        longitude: 140,
        live_period: 0,
      });
      await triggerEditedLocationMessage(ctx);

      expect(mockInstance.stopSession).toHaveBeenCalledWith('tg:100200300');
    });
  });
});
