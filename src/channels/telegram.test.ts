import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Pip',
  TRIGGER_PATTERN: /^@Pip\b/i,
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

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

// Track all created bots for multi-bot tests
const allBots = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      pinChatMessage: vi.fn().mockResolvedValue(undefined),
    };

    constructor(token: string) {
      this.token = token;
      allBots.instances.push(this);
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
      // Use token to generate a unique bot username
      const suffix = this.token.replace(/[^a-z0-9]/gi, '').slice(0, 8);
      opts.onStart({ username: `bot_${suffix}`, id: 12345 });
    }

    stop() {}
  },
}));

import {
  TelegramChannel,
  TelegramChannelOpts,
  parseBotConfig,
} from './telegram.js';

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
        trigger: '@Pip',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function singleBotConfigs() {
  return [{ name: 'pip', token: 'test-token' }];
}

function multiBotConfigs() {
  return [
    { name: 'pip', token: 'pip-token' },
    { name: 'pickle', token: 'pickle-token' },
  ];
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
    me: { username: 'bot_piptoken' },
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
    me: { username: 'bot_piptoken' },
  };
}

/** Get the most recently created bot instance. */
function lastBot() {
  return allBots.instances[allBots.instances.length - 1];
}

/** Get bot by index (0 = first created). */
function botAt(index: number) {
  return allBots.instances[index];
}

async function triggerTextMessage(
  bot: any,
  ctx: ReturnType<typeof createTextCtx>,
) {
  const handlers = bot.filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  bot: any,
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = bot.filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

describe('parseBotConfig', () => {
  it('parses multi-bot config string', () => {
    const configs = parseBotConfig('pip:token1,pickle:token2', undefined);
    expect(configs).toEqual([
      { name: 'pip', token: 'token1' },
      { name: 'pickle', token: 'token2' },
    ]);
  });

  it('falls back to legacy token', () => {
    const configs = parseBotConfig(undefined, 'legacy-token');
    expect(configs).toEqual([{ name: 'default', token: 'legacy-token' }]);
  });

  it('prefers TELEGRAM_BOTS over legacy token', () => {
    const configs = parseBotConfig('pip:token1', 'legacy-token');
    expect(configs).toEqual([{ name: 'pip', token: 'token1' }]);
  });

  it('returns empty array when no config', () => {
    const configs = parseBotConfig(undefined, undefined);
    expect(configs).toEqual([]);
  });

  it('throws on malformed entry', () => {
    expect(() => parseBotConfig('no-colon', undefined)).toThrow(
      'Invalid TELEGRAM_BOTS entry',
    );
  });

  it('handles whitespace in config', () => {
    const configs = parseBotConfig(' pip : token1 , pickle : token2 ', undefined);
    expect(configs).toEqual([
      { name: 'pip', token: 'token1' },
      { name: 'pickle', token: 'token2' },
    ]);
  });
});

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allBots.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('creates multiple bot instances for multi-bot config', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(multiBotConfigs(), opts);

      await channel.connect();

      expect(allBots.instances).toHaveLength(2);
      expect(allBots.instances[0].token).toBe('pip-token');
      expect(allBots.instances[1].token).toBe('pickle-token');
    });

    it('registers handlers on each bot', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(multiBotConfigs(), opts);
      await channel.connect();

      for (const bot of allBots.instances) {
        expect(bot.commandHandlers.has('chatid')).toBe(true);
        expect(bot.commandHandlers.has('ping')).toBe(true);
        expect(bot.filterHandlers.has('message:text')).toBe(true);
        expect(bot.filterHandlers.has('message:photo')).toBe(true);
      }
    });

    it('disconnects all bots cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(multiBotConfigs(), opts);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(lastBot(), ctx);

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
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(lastBot(), ctx);

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
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      const ctx1 = createTextCtx({ text: '/chatid' });
      await triggerTextMessage(lastBot(), ctx1);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      const ctx2 = createTextCtx({ text: '/ping' });
      await triggerTextMessage(lastBot(), ctx2);
      expect(opts.onMessage).not.toHaveBeenCalled();

      const ctx3 = createTextCtx({ text: '/remote-control' });
      await triggerTextMessage(lastBot(), ctx3);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '/remote-control' }),
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(lastBot(), ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- Multi-bot outbound routing ---

  describe('multi-bot outbound routing', () => {
    it('routes sendMessage to the correct bot based on group.bot', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Pip Admin',
            folder: 'telegram_pip_admin',
            trigger: '@Pip',
            added_at: '2024-01-01T00:00:00.000Z',
            bot: 'pip',
          },
          'tg:999888777': {
            name: 'Pickle',
            folder: 'telegram_pickle',
            trigger: '@Pickle',
            added_at: '2024-01-01T00:00:00.000Z',
            bot: 'pickle',
          },
        })),
      });

      const channel = new TelegramChannel(multiBotConfigs(), opts);
      await channel.connect();

      const pipBot = botAt(0);
      const pickleBot = botAt(1);

      await channel.sendMessage('tg:100200300', 'Hello from Pip');
      expect(pipBot.api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello from Pip',
        { parse_mode: 'Markdown' },
      );
      expect(pickleBot.api.sendMessage).not.toHaveBeenCalled();

      vi.clearAllMocks();

      await channel.sendMessage('tg:999888777', 'Hello from Pickle');
      expect(pickleBot.api.sendMessage).toHaveBeenCalledWith(
        '999888777',
        'Hello from Pickle',
        { parse_mode: 'Markdown' },
      );
      expect(pipBot.api.sendMessage).not.toHaveBeenCalled();
    });

    it('falls back to default bot when group has no bot field', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'No Bot Field',
            folder: 'test-group',
            trigger: '@Pip',
            added_at: '2024-01-01T00:00:00.000Z',
            // no bot field
          },
        })),
      });

      const channel = new TelegramChannel(multiBotConfigs(), opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      // Should use first bot (pip) as default
      expect(botAt(0).api.sendMessage).toHaveBeenCalled();
      expect(botAt(1).api.sendMessage).not.toHaveBeenCalled();
    });

    it('routes setTyping to the correct bot', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:999888777': {
            name: 'Pickle',
            folder: 'telegram_pickle',
            trigger: '@Pickle',
            added_at: '2024-01-01T00:00:00.000Z',
            bot: 'pickle',
          },
        })),
      });

      const channel = new TelegramChannel(multiBotConfigs(), opts);
      await channel.connect();

      await channel.setTyping('tg:999888777', true);

      expect(botAt(1).api.sendChatAction).toHaveBeenCalledWith(
        '999888777',
        'typing',
      );
      expect(botAt(0).api.sendChatAction).not.toHaveBeenCalled();
    });
  });

  // --- pinMessage ---

  describe('pinMessage', () => {
    it('pins a message via the correct bot', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Test',
            folder: 'test',
            trigger: '@Pip',
            added_at: '2024-01-01T00:00:00.000Z',
            bot: 'pip',
          },
        })),
      });

      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      await channel.pinMessage('tg:100200300', '42');

      expect(lastBot().api.pinChatMessage).toHaveBeenCalledWith(
        100200300,
        42,
        { disable_notification: true },
      );
    });

    it('handles pin failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      lastBot().api.pinChatMessage.mockRejectedValueOnce(
        new Error('Not enough rights'),
      );

      await expect(
        channel.pinMessage('tg:100200300', '42'),
      ).resolves.toBeUndefined();
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores photo with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage(lastBot(), 'message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('stores photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      const ctx = createMediaCtx({ caption: 'Look at this' });
      await triggerMediaMessage(lastBot(), 'message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Look at this' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage(lastBot(), 'message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(lastBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'Markdown' },
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(lastBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(lastBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        { parse_mode: 'Markdown' },
      );
      expect(lastBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        { parse_mode: 'Markdown' },
      );
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      lastBot().api.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when no bots available', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);

      // Don't connect — no bots
      await channel.sendMessage('tg:100200300', 'No bot');
      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel(singleBotConfigs(), createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel(singleBotConfigs(), createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel(singleBotConfigs(), createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel(singleBotConfigs(), createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(lastBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(lastBot().api.sendChatAction).not.toHaveBeenCalled();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID, bot name, and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      const handler = lastBot().commandHandlers.get('chatid')!;
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
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('pip'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel(singleBotConfigs(), opts);
      await channel.connect();

      const handler = lastBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Pip (pip) is online.');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel(singleBotConfigs(), createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });
});
