import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandHandlers = new Map<string, (ctx: any) => unknown>();
const eventHandlers = new Map<string, (ctx: any) => unknown>();
const sendMessageMock = vi.fn();
const sendChatActionMock = vi.fn();
const getFileMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();

class FakeBot {
  public readonly api = {
    sendMessage: sendMessageMock,
    sendChatAction: sendChatActionMock,
    getFile: getFileMock,
  };

  public readonly me = { username: 'andy_bot' };

  constructor(
    public readonly token: string,
    public readonly options: Record<string, unknown>,
  ) {}

  command(name: string, handler: (ctx: any) => unknown) {
    commandHandlers.set(name, handler);
    return this;
  }

  on(event: string, handler: (ctx: any) => unknown) {
    eventHandlers.set(event, handler);
    return this;
  }

  catch(_handler: (err: Error) => unknown) {
    return this;
  }

  start(opts?: {
    onStart?: (botInfo: { username: string; id: number }) => void;
  }) {
    startMock(opts);
    opts?.onStart?.({ username: 'andy_bot', id: 42 });
  }

  stop() {
    stopMock();
  }
}

vi.mock('grammy', () => ({
  Api: class {},
  Bot: FakeBot,
}));

function baseGroup() {
  return {
    name: 'My Chat',
    folder: 'telegram_main',
    trigger: '@Andy',
    added_at: '2026-04-06T00:00:00.000Z',
    providerId: 'codex',
    isMain: true,
    requiresTrigger: false,
  };
}

async function loadTelegramRegistry() {
  vi.resetModules();
  const registry = await import('./registry.js');
  await import('./telegram.js');
  return registry;
}

describe('telegram channel', () => {
  beforeEach(() => {
    commandHandlers.clear();
    eventHandlers.clear();
    sendMessageMock.mockReset();
    sendChatActionMock.mockReset();
    getFileMock.mockReset();
    startMock.mockReset();
    stopMock.mockReset();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('registers a factory that returns null when TELEGRAM_BOT_TOKEN is missing', async () => {
    const { getChannelFactory } = await loadTelegramRegistry();
    const factory = getChannelFactory('telegram');

    expect(factory).toBeTypeOf('function');
    expect(
      factory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      }),
    ).toBeNull();
  });

  it('creates a telegram channel when TELEGRAM_BOT_TOKEN is present', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const { getChannelFactory } = await loadTelegramRegistry();
    const factory = getChannelFactory('telegram');
    const channel = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    expect(channel).not.toBeNull();
    expect(channel!.name).toBe('telegram');
    expect(channel!.ownsJid('tg:123')).toBe(true);
    expect(channel!.ownsJid('dc:123')).toBe(false);
  });

  it('connects the bot and exposes the /chatid helper command', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });

    await channel!.connect();

    expect(startMock).toHaveBeenCalledOnce();
    expect(commandHandlers.has('chatid')).toBe(true);

    const reply = vi.fn();
    await commandHandlers.get('chatid')!({
      chat: { id: 123456789, type: 'private' },
      from: { first_name: 'Jon' },
      reply,
    });

    expect(reply).toHaveBeenCalledWith(
      'Chat ID: `tg:123456789`\nName: Jon\nType: private',
      { parse_mode: 'Markdown' },
    );
  });

  it('stores metadata and forwards registered inbound messages', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();

    const { getChannelFactory } = await loadTelegramRegistry();
    const channel = getChannelFactory('telegram')!({
      onMessage,
      onChatMetadata,
      registeredGroups: () => ({
        'tg:123456789': baseGroup(),
      }),
    });

    await channel!.connect();

    const handler = eventHandlers.get('message:text');
    expect(handler).toBeTypeOf('function');

    await handler!({
      chat: { id: 123456789, type: 'private' },
      from: { id: 55, first_name: 'Jon' },
      me: { username: 'andy_bot' },
      message: {
        text: 'hello @andy_bot',
        date: 1712419200,
        message_id: 77,
        message_thread_id: 999,
        entities: [{ type: 'mention', offset: 6, length: 9 }],
      },
    });

    expect(onChatMetadata).toHaveBeenCalledWith(
      'tg:123456789',
      '2024-04-06T16:00:00.000Z',
      'Jon',
      'telegram',
      false,
    );
    expect(onMessage).toHaveBeenCalledWith(
      'tg:123456789',
      expect.objectContaining({
        id: '77',
        chat_jid: 'tg:123456789',
        sender: '55',
        sender_name: 'Jon',
        content: '@Andy hello @andy_bot',
        thread_id: '999',
        is_from_me: false,
      }),
    );
  });
});
