import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getChannelFactory } from './registry.js';
import { ChannelOpts } from './registry.js';

const cfg = vi.hoisted(() => ({
  enabled: true,
  redisUrl: 'redis://localhost:6379',
}));

const redisState = vi.hoisted(() => ({
  client: null as any,
  streamClient: null as any,
  brPopQueue: [] as Array<{ key?: string; element: string }>,
  brPopErrors: [] as Error[],
  setQueue: [] as Array<'OK' | null>,
}));

vi.mock('../config.js', () => ({
  get WEB_CHANNEL_ENABLED() {
    return cfg.enabled;
  },
  get WEB_CHANNEL_REDIS_URL() {
    return cfg.redisUrl;
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function makePendingPromise<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

vi.mock('redis', () => ({
  createClient: vi.fn(() => {
    const streamClient = {
      isOpen: false,
      connect: vi.fn(async () => {
        streamClient.isOpen = true;
      }),
      disconnect: vi.fn(async () => {
        streamClient.isOpen = false;
      }),
      on: vi.fn(),
      xAdd: vi.fn(async () => '1-0'),
      xTrim: vi.fn(async () => 0),
    };

    const client = {
      isOpen: false,
      connect: vi.fn(async () => {
        client.isOpen = true;
      }),
      disconnect: vi.fn(async () => {
        client.isOpen = false;
      }),
      on: vi.fn(),
      duplicate: vi.fn(() => streamClient),
      brPop: vi.fn(async () => {
        if (redisState.brPopErrors.length > 0) {
          throw redisState.brPopErrors.shift()!;
        }
        if (redisState.brPopQueue.length > 0) {
          return redisState.brPopQueue.shift()!;
        }
        return makePendingPromise();
      }),
      set: vi.fn(async () => {
        if (redisState.setQueue.length > 0) {
          return redisState.setQueue.shift()!;
        }
        return 'OK';
      }),
    };

    redisState.client = client;
    redisState.streamClient = streamClient;
    return client;
  }),
}));

import { WebChannel } from './web.js';

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function makeOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

describe('WebChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.enabled = true;
    cfg.redisUrl = 'redis://localhost:6379';
    redisState.client = null;
    redisState.streamClient = null;
    redisState.brPopQueue = [];
    redisState.brPopErrors = [];
    redisState.setQueue = [];
  });

  afterEach(async () => {
    if (redisState.client?.isOpen) await redisState.client.disconnect();
    if (redisState.streamClient?.isOpen) await redisState.streamClient.disconnect();
  });

  describe('factory', () => {
    it('returns null when WEB_CHANNEL_ENABLED is false', () => {
      cfg.enabled = false;
      const factory = getChannelFactory('web');
      expect(factory).toBeDefined();
      expect(factory!(makeOpts())).toBeNull();
    });

    it('returns null when redis url is missing', () => {
      cfg.enabled = true;
      cfg.redisUrl = '';
      const factory = getChannelFactory('web');
      expect(factory).toBeDefined();
      expect(factory!(makeOpts())).toBeNull();
    });

    it('returns channel instance when enabled and configured', () => {
      const factory = getChannelFactory('web');
      const instance = factory!(makeOpts());
      expect(instance).not.toBeNull();
      expect(instance?.name).toBe('web');
    });
  });

  it('connect/disconnect transitions state', async () => {
    const channel = new WebChannel(makeOpts());
    expect(channel.isConnected()).toBe(false);
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('owns web:* jids only', () => {
    const channel = new WebChannel(makeOpts());
    expect(channel.ownsJid('web:main')).toBe(true);
    expect(channel.ownsJid('web:abc')).toBe(true);
    expect(channel.ownsJid('tg:123')).toBe(false);
    expect(channel.ownsJid('123@g.us')).toBe(false);
  });

  it('processes a valid inbound message', async () => {
    const opts = makeOpts();
    const channel = new WebChannel(opts);
    redisState.brPopQueue.push({
      element: JSON.stringify({
        sessionId: 'main',
        text: 'hello',
        userName: 'Web User',
        messageId: 'msg-1',
        timestamp: Date.now(),
      }),
    });
    redisState.setQueue.push('OK');

    await channel.connect();
    await waitForMicrotasks();

    expect(opts.onMessage).toHaveBeenCalledWith(
      'web:main',
      expect.objectContaining({
        chat_jid: 'web:main',
        content: 'hello',
        sender_name: 'Web User',
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'web:main',
      expect.any(String),
      'Web Main',
      'web',
      false,
    );

    await channel.disconnect();
  });

  it('drops duplicate inbound message ids', async () => {
    const opts = makeOpts();
    const channel = new WebChannel(opts);
    const payload = {
      sessionId: 'main',
      text: 'duplicate',
      messageId: 'dup-1',
      timestamp: Date.now(),
    };
    redisState.brPopQueue.push(
      { element: JSON.stringify(payload) },
      { element: JSON.stringify(payload) },
    );
    redisState.setQueue.push('OK', null);

    await channel.connect();
    await waitForMicrotasks();
    await waitForMicrotasks();

    expect((opts.onMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    await channel.disconnect();
  });

  it('drops malformed json inbound payloads', async () => {
    const opts = makeOpts();
    const channel = new WebChannel(opts);
    redisState.brPopQueue.push({ element: '{not-json' });

    await channel.connect();
    await waitForMicrotasks();

    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('drops payloads with missing fields', async () => {
    const opts = makeOpts();
    const channel = new WebChannel(opts);
    redisState.brPopQueue.push({
      element: JSON.stringify({ sessionId: 'main', text: 'missing id' }),
    });

    await channel.connect();
    await waitForMicrotasks();

    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('drops unsupported session ids in v1', async () => {
    const opts = makeOpts();
    const channel = new WebChannel(opts);
    redisState.brPopQueue.push({
      element: JSON.stringify({
        sessionId: 'alice',
        text: 'hello',
        messageId: 'msg-2',
      }),
    });

    await channel.connect();
    await waitForMicrotasks();

    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('keeps running when brpop throws', async () => {
    const channel = new WebChannel(makeOpts());
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });

    redisState.brPopErrors.push(new Error('redis down'));

    await channel.connect();
    await waitForMicrotasks();

    expect(channel.isConnected()).toBe(true);
    setTimeoutSpy.mockRestore();
    await channel.disconnect();
  });

  it('writes outbound message and typing events to stream', async () => {
    const channel = new WebChannel(makeOpts());
    await channel.connect();

    await channel.sendMessage('web:main', 'outbound text');
    await channel.setTyping('web:main', true);

    expect(redisState.streamClient.xAdd).toHaveBeenCalledWith(
      'nanoclaw:outbound:main',
      '*',
      expect.objectContaining({
        type: 'message',
        text: 'outbound text',
      }),
    );
    expect(redisState.streamClient.xAdd).toHaveBeenCalledWith(
      'nanoclaw:outbound:main',
      '*',
      expect.objectContaining({
        type: 'typing',
        isTyping: 'true',
      }),
    );
    expect(redisState.streamClient.xTrim).toHaveBeenCalledWith(
      'nanoclaw:outbound:main',
      'MAXLEN',
      '~',
      1000,
    );

    await channel.disconnect();
  });
});
