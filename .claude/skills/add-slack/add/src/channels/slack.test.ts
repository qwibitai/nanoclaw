import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  shouldIgnoreSlackMessageSubtype,
  SlackChannel,
} from './slack.js';

const mockCommandHandlers = new Map<string, (args: any) => Promise<void>>();
const mockMessageHandlers: Array<(args: any) => Promise<void>> = [];

const mockClient = {
  auth: { test: vi.fn(async () => ({ user_id: 'U_BOT' })) },
  chat: {
    postMessage: vi.fn(async () => ({})),
    postEphemeral: vi.fn(async () => ({})),
  },
  conversations: {
    info: vi.fn(async () => ({ channel: { name: 'eng-platform' } })),
  },
};

vi.mock('@slack/bolt', () => {
  class MockApp {
    client = mockClient;
    command(name: string, handler: (args: any) => Promise<void>) {
      mockCommandHandlers.set(name, handler);
    }
    message(handler: (args: any) => Promise<void>) {
      mockMessageHandlers.push(handler);
    }
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
  }
  return {
    App: MockApp,
    LogLevel: { WARN: 'warn' },
  };
});

describe('shouldIgnoreSlackMessageSubtype', () => {
  it('returns false for undefined', () => {
    expect(shouldIgnoreSlackMessageSubtype(undefined)).toBe(false);
  });

  it('keeps file_share events', () => {
    expect(shouldIgnoreSlackMessageSubtype('file_share')).toBe(false);
  });

  it('ignores unrelated subtypes', () => {
    expect(shouldIgnoreSlackMessageSubtype('bot_message')).toBe(true);
  });
});

describe('SlackChannel', () => {
  beforeEach(() => {
    mockCommandHandlers.clear();
    mockMessageHandlers.length = 0;
    vi.clearAllMocks();
  });

  function createChannel(overrides?: Partial<ConstructorParameters<typeof SlackChannel>[0]>) {
    return new SlackChannel({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'secret',
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      onAbort: vi.fn(async () => true),
      registerGroup: vi.fn(),
      registeredGroups: vi.fn(() => ({})),
      ...overrides,
    });
  }

  it('owns Slack-style channel IDs', () => {
    const channel = createChannel();
    expect(channel.ownsJid('C123ABC')).toBe(true);
    expect(channel.ownsJid('G123ABC')).toBe(true);
    expect(channel.ownsJid('D123ABC')).toBe(true);
    expect(channel.ownsJid('not-a-slack-jid')).toBe(false);
  });

  it('auto-registers on mention for unregistered channel', async () => {
    const onMessage = vi.fn();
    const registerGroup = vi.fn();
    const channel = createChannel({ onMessage, registerGroup });
    await channel.connect();

    const handler = mockMessageHandlers[0];
    await handler({
      client: mockClient,
      message: {
        channel: 'C123ABC',
        user: 'U123',
        ts: '1.2',
        channel_type: 'channel',
        text: '<@U_BOT> hello',
      },
    });

    expect(registerGroup).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('auto-registers DMs without mention', async () => {
    const onMessage = vi.fn();
    const registerGroup = vi.fn();
    const channel = createChannel({ onMessage, registerGroup });
    await channel.connect();

    const handler = mockMessageHandlers[0];
    await handler({
      client: mockClient,
      message: {
        channel: 'D123ABC',
        user: 'U123',
        ts: '1.2',
        channel_type: 'im',
        text: 'hello',
      },
    });

    expect(registerGroup).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('handles abort text fallback without storing message', async () => {
    const onMessage = vi.fn();
    const onAbort = vi.fn(async () => true);
    const channel = createChannel({ onMessage, onAbort });
    await channel.connect();

    const handler = mockMessageHandlers[0];
    await handler({
      client: mockClient,
      message: {
        channel: 'C123ABC',
        user: 'U123',
        ts: '1.2',
        channel_type: 'channel',
        text: '/abort',
      },
    });

    expect(onAbort).toHaveBeenCalledWith('C123ABC');
    expect(onMessage).not.toHaveBeenCalled();
    expect(mockClient.chat.postEphemeral).toHaveBeenCalled();
  });

  it('wires slash command /abort', async () => {
    const onAbort = vi.fn(async () => true);
    const channel = createChannel({ onAbort });
    await channel.connect();

    const handler = mockCommandHandlers.get('/abort');
    expect(handler).toBeTruthy();

    const ack = vi.fn(async () => {});
    await handler!({ ack, command: { channel_id: 'C123ABC' } });

    expect(onAbort).toHaveBeenCalledWith('C123ABC');
    expect(ack).toHaveBeenCalledWith('Abort requested.');
  });

  it('sends debounced ephemeral status updates on setTyping', async () => {
    vi.useFakeTimers();

    const channel = createChannel();
    await channel.connect();

    const handler = mockMessageHandlers[0];
    await handler({
      client: mockClient,
      message: {
        channel: 'C123ABC',
        user: 'U123',
        ts: '1.2',
        channel_type: 'channel',
        text: '<@U_BOT> hello',
      },
    });

    await channel.setTyping('C123ABC', true);
    await channel.setTyping('C123ABC', true);
    expect(mockClient.chat.postEphemeral).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4500);
    await channel.setTyping('C123ABC', true);
    expect(mockClient.chat.postEphemeral).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
