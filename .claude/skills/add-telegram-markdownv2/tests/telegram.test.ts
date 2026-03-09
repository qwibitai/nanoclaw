import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
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
  Api: class MockApi {},
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

function currentBot() {
  return botRef.current;
}

// --- MarkdownV2 tests ---

describe('TelegramChannel MarkdownV2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends message with MarkdownV2 parse mode', async () => {
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

  it('escapes MarkdownV2 special characters', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.sendMessage('tg:100200300', 'Price is $10.99!');

    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
      '100200300',
      'Price is $10\\.99\\!',
      { parse_mode: 'MarkdownV2' },
    );
  });

  it('preserves bold and italic formatting', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.sendMessage('tg:100200300', '*bold* and _italic_');

    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
      '100200300',
      '*bold* and _italic_',
      { parse_mode: 'MarkdownV2' },
    );
  });

  it('preserves code blocks', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.sendMessage('tg:100200300', '```console.log("hi")```');

    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
      '100200300',
      '```console.log("hi")```',
      { parse_mode: 'MarkdownV2' },
    );
  });

  it('preserves inline code', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.sendMessage('tg:100200300', 'Run `npm install` first');

    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
      '100200300',
      'Run `npm install` first',
      { parse_mode: 'MarkdownV2' },
    );
  });

  it('escapes multiple special characters', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.sendMessage('tg:100200300', 'Items: (a) and [b] + c!');

    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
      '100200300',
      'Items: \\(a\\) and \\[b\\] \\+ c\\!',
      { parse_mode: 'MarkdownV2' },
    );
  });

  it('falls back to plain text when MarkdownV2 fails', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    // First call (MarkdownV2) fails, second call (plain) succeeds
    currentBot()
      .api.sendMessage.mockRejectedValueOnce(new Error('Bad markup'))
      .mockResolvedValueOnce(undefined);

    await channel.sendMessage('tg:100200300', 'Malformed *bold');

    expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
    // Second call is plain text (no parse_mode)
    expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
      2,
      '100200300',
      'Malformed *bold',
    );
  });

  it('splits long messages with formatting', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const longText = 'x'.repeat(5000);
    await channel.sendMessage('tg:100200300', longText);

    // Two chunks, each with MarkdownV2
    expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
  });
});
