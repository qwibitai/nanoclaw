import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

const loggerRef = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../logger.js', () => ({
  logger: loggerRef.logger,
}));

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));
const registryRef = vi.hoisted(() => ({ factory: null as any }));

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn((_name: string, factory: Handler) => {
    registryRef.factory = factory;
  }),
}));

vi.mock('dingtalk-stream', () => ({
  TOPIC_ROBOT: 'TOPIC_ROBOT',
  DWClient: class MockDWClient {
    listeners = new Map<string, Handler>();
    connected = false;
    getAccessToken = vi.fn().mockResolvedValue('test-access-token');
    disconnect = vi.fn().mockImplementation(async () => {
      this.connected = false;
    });

    constructor(_opts: any) {
      clientRef.current = this;
    }

    registerCallbackListener(topic: string, handler: Handler) {
      this.listeners.set(topic, handler);
      return this;
    }

    async connect() {
      this.connected = true;
    }
  },
}));

import { readEnvFile } from '../env.js';
import { DingTalkChannel, DingTalkChannelOpts } from './dingtalk.js';

function createTestOpts(
  overrides?: Partial<DingTalkChannelOpts>,
): DingTalkChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'ding:cid-group': {
        name: 'Engineering',
        folder: 'dingtalk_engineering',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'ding:cid-private': {
        name: 'Alice',
        folder: 'dingtalk_alice',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createRobotPayload(overrides?: Partial<Record<string, any>>) {
  return {
    msgId: 'msg-001',
    msgtype: 'text',
    conversationId: 'cid-group',
    conversationType: '1',
    conversationTitle: 'Engineering',
    senderId: 'user-001',
    senderStaffId: 'staff-001',
    senderNick: 'Alice',
    chatbotUserId: 'bot-001',
    createAt: Date.parse('2024-01-01T00:00:00.000Z'),
    isInAtList: true,
    sessionWebhook: 'https://example.com/session',
    sessionWebhookExpiredTime: Date.now() + 60_000,
    text: {
      content: '请总结今天的消息',
    },
    ...overrides,
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerRobotMessage(raw: Record<string, any>) {
  const handler = currentClient().listeners.get('TOPIC_ROBOT');
  await handler({
    data: JSON.stringify(raw),
    headers: { messageId: 'stream-001' },
  });
}

describe('DingTalkChannel', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DINGTALK_CLIENT_ID;
    delete process.env.DINGTALK_CLIENT_SECRET;
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({}),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('connection lifecycle', () => {
    it('connects and registers the robot callback listener', async () => {
      const channel = new DingTalkChannel('client-id', 'client-secret', createTestOpts());

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(currentClient().listeners.has('TOPIC_ROBOT')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const channel = new DingTalkChannel('client-id', 'client-secret', createTestOpts());

      await channel.connect();
      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
      expect(currentClient().disconnect).toHaveBeenCalled();
    });
  });

  describe('message handling', () => {
    it('stores a registered group @mention message', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel('client-id', 'client-secret', opts);
      await channel.connect();

      await triggerRobotMessage(createRobotPayload());

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'ding:cid-group',
        '2024-01-01T00:00:00.000Z',
        'Engineering',
        'dingtalk',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'ding:cid-group',
        expect.objectContaining({
          id: 'msg-001',
          chat_jid: 'ding:cid-group',
          sender: 'staff-001',
          sender_name: 'Alice',
          content: '@Andy 请总结今天的消息',
          is_from_me: false,
        }),
      );
    });

    it('ignores unregistered chats after storing metadata', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new DingTalkChannel('client-id', 'client-secret', opts);
      await channel.connect();

      await triggerRobotMessage(createRobotPayload());

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('replies to /chatid without routing to the agent', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new DingTalkChannel('client-id', 'client-secret', opts);
      await channel.connect();

      await triggerRobotMessage(
        createRobotPayload({
          text: { content: ' /chatid ' },
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/session',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-acs-dingtalk-access-token': 'test-access-token',
          }),
          body: JSON.stringify({
            msgtype: 'text',
            text: {
              content: 'Chat ID: ding:cid-group\nType: group',
            },
          }),
        }),
      );
    });

    it('uses placeholders for non-text messages', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel('client-id', 'client-secret', opts);
      await channel.connect();

      await triggerRobotMessage(
        createRobotPayload({
          msgtype: 'file',
          content: { fileName: 'plan.pdf' },
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'ding:cid-group',
        expect.objectContaining({
          content: '@Andy [File: plan.pdf]',
        }),
      );
    });

    it('marks conversationType=2 as a private chat', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel('client-id', 'client-secret', opts);
      await channel.connect();

      await triggerRobotMessage(
        createRobotPayload({
          conversationId: 'cid-private',
          conversationType: '2',
          conversationTitle: undefined,
          senderNick: 'Alice',
          isInAtList: false,
          text: { content: 'hello' },
        }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'ding:cid-private',
        '2024-01-01T00:00:00.000Z',
        'Alice',
        'dingtalk',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'ding:cid-private',
        expect.objectContaining({
          content: 'hello',
        }),
      );
    });

    it('ignores bot self-messages', async () => {
      const opts = createTestOpts();
      const channel = new DingTalkChannel('client-id', 'client-secret', opts);
      await channel.connect();

      await triggerRobotMessage(
        createRobotPayload({
          senderId: 'bot-001',
          senderStaffId: 'bot-001',
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('outbound messages', () => {
    it('sends replies through the cached session webhook', async () => {
      const channel = new DingTalkChannel('client-id', 'client-secret', createTestOpts());
      await channel.connect();

      await triggerRobotMessage(createRobotPayload());
      fetchMock.mockClear();

      await channel.sendMessage('ding:cid-group', 'hello back');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/session',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            msgtype: 'text',
            text: { content: 'hello back' },
          }),
        }),
      );
    });

    it('does not send when no session webhook is cached', async () => {
      const channel = new DingTalkChannel('client-id', 'client-secret', createTestOpts());
      await channel.connect();

      await channel.sendMessage('ding:cid-group', 'hello back');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(loggerRef.logger.warn).toHaveBeenCalled();
    });

    it('splits long outbound messages conservatively', async () => {
      const channel = new DingTalkChannel('client-id', 'client-secret', createTestOpts());
      await channel.connect();

      await triggerRobotMessage(createRobotPayload());
      fetchMock.mockClear();

      await channel.sendMessage('ding:cid-group', 'x'.repeat(9001));

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('factory', () => {
    it('registers a factory that returns null when credentials are missing', () => {
      const factory = registryRef.factory;

      expect(factory).toBeTypeOf('function');
      expect(factory?.(createTestOpts() as any)).toBeNull();
    });

    it('returns a channel instance when credentials are present', () => {
      vi.mocked(readEnvFile).mockReturnValue({
        DINGTALK_CLIENT_ID: 'client-id',
        DINGTALK_CLIENT_SECRET: 'client-secret',
      });

      const factory = registryRef.factory;
      const instance = factory?.(createTestOpts() as any);

      expect(instance).toBeInstanceOf(DingTalkChannel);
    });
  });
});
