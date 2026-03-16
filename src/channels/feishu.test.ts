import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
  afterEach,
} from 'vitest';

// --- Mocks (must be before imports) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Feishu SDK mock ---

const sdkRef = vi.hoisted(() => ({
  messageCreate: null as any,
  userGet: null as any,
  botInfoGet: null as any,
  wsStart: null as any,
  eventHandlers: null as Record<string, Function> | null,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(function () {
    return {
      im: {
        v1: { message: { create: sdkRef.messageCreate } },
      },
      contact: {
        v3: { user: { get: sdkRef.userGet } },
      },
      bot: {
        v3: { info: { get: sdkRef.botInfoGet } },
      },
    };
  }),
  WSClient: vi.fn(function () {
    return {
      start: sdkRef.wsStart,
    };
  }),
  EventDispatcher: vi.fn(function () {
    return {
      register: vi.fn(function (this: any, handlers: Record<string, Function>) {
        sdkRef.eventHandlers = handlers;
        return this;
      }),
    };
  }),
  AppType: { SelfBuild: 0 },
  Domain: { Feishu: 'https://open.feishu.cn' },
  LoggerLevel: { info: 1 },
}));

import { FeishuChannel, FeishuChannelOpts } from './feishu.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<FeishuChannelOpts>,
): FeishuChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'feishu:oc_test123': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  chatId?: string;
  chatType?: string;
  messageType?: string;
  content?: string;
  messageId?: string;
  senderOpenId?: string;
  senderType?: string;
  mentions?: any[];
  createTime?: string;
}) {
  return {
    message: {
      message_id: overrides.messageId ?? 'om_msg001',
      chat_id: overrides.chatId ?? 'oc_test123',
      chat_type: overrides.chatType ?? 'group',
      message_type: overrides.messageType ?? 'text',
      content: overrides.content ?? JSON.stringify({ text: 'Hello' }),
      mentions: overrides.mentions ?? [],
      create_time: overrides.createTime ?? '1704067200000',
    },
    sender: {
      sender_id: {
        open_id: overrides.senderOpenId ?? 'ou_sender001',
      },
      sender_type: overrides.senderType ?? 'user',
    },
  };
}

async function triggerEvent(eventName: string, data: any): Promise<void> {
  const handler = sdkRef.eventHandlers?.[eventName];
  if (handler) await handler(data);
}

// --- Tests ---

describe('FeishuChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkRef.messageCreate = vi.fn().mockResolvedValue({});
    sdkRef.userGet = vi
      .fn()
      .mockResolvedValue({ data: { user: { name: 'Test User' } } });
    sdkRef.botInfoGet = vi
      .fn()
      .mockResolvedValue({ data: { bot: { open_id: 'ou_bot123' } } });
    sdkRef.wsStart = vi.fn().mockResolvedValue(undefined);
    sdkRef.eventHandlers = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('factory registration', () => {
    let capturedFactory: any;

    beforeAll(async () => {
      const { registerChannel } = await import('./registry.js');
      // Verify registration happened at module load time (before clearAllMocks runs)
      expect(registerChannel).toHaveBeenCalledWith(
        'feishu',
        expect.any(Function),
      );
      capturedFactory = (registerChannel as any).mock.calls.find(
        (c: any) => c[0] === 'feishu',
      )?.[1];
      expect(capturedFactory).toBeDefined();
    });

    it('returns null when credentials are missing', () => {
      const result = capturedFactory(createTestOpts());
      expect(result).toBeNull();
    });

    it('returns FeishuChannel instance when credentials are set', () => {
      process.env.FEISHU_APP_ID = 'cli_test';
      process.env.FEISHU_APP_SECRET = 'secret_test';

      const result = capturedFactory(createTestOpts());
      expect(result).toBeInstanceOf(FeishuChannel);
      expect(result.name).toBe('feishu');

      delete process.env.FEISHU_APP_ID;
      delete process.env.FEISHU_APP_SECRET;
    });
  });

  describe('ownsJid', () => {
    it('owns feishu: JIDs', () => {
      const channel = new FeishuChannel('id', 'secret', createTestOpts());
      expect(channel.ownsJid('feishu:oc_abc123')).toBe(true);
    });

    it('does not own telegram JIDs', () => {
      const channel = new FeishuChannel('id', 'secret', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });
  });

  describe('connection lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const channel = new FeishuChannel('id', 'secret', createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('connect() creates Client and WSClient, starts WebSocket', async () => {
      const channel = new FeishuChannel('id', 'secret', createTestOpts());
      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(sdkRef.wsStart).toHaveBeenCalled();
      expect(sdkRef.botInfoGet).toHaveBeenCalled();
    });

    it('disconnect() sets connected to false', async () => {
      const channel = new FeishuChannel('id', 'secret', createTestOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('inbound text messages', () => {
    it('delivers text message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        content: JSON.stringify({ text: 'Hello world' }),
      });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          id: 'om_msg001',
          chat_jid: 'feishu:oc_test123',
          sender: 'ou_sender001',
          sender_name: 'Test User',
          content: 'Hello world',
          timestamp: '2024-01-01T00:00:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('ignores messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({ chatId: 'oc_unknown999' });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('tags bot messages with is_bot_message', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({ senderType: 'app' });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ is_bot_message: true }),
      );
    });

    it('sets is_from_me when sender is the bot', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        senderOpenId: 'ou_bot123',
        senderType: 'app',
      });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ is_from_me: true, is_bot_message: true }),
      );
    });

    it('converts create_time milliseconds to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({ createTime: '1704067200000' });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ timestamp: '2024-01-01T00:00:00.000Z' }),
      );
    });
  });

  describe('@mention handling', () => {
    it('replaces bot mention placeholder with trigger name', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        content: JSON.stringify({ text: '@_user_1 hello' }),
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot123' },
            name: 'TestBot',
          },
        ],
      });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('prepends trigger for private chat messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'feishu:oc_private001': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_private001',
        chatType: 'p2p',
        content: JSON.stringify({ text: 'What time is it?' }),
      });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_private001',
        expect.objectContaining({
          content: '@Andy What time is it?',
        }),
      );

      // Verify metadata emitted with isGroup = false for p2p chat
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_private001',
        expect.any(String),
        undefined,
        'feishu',
        false,
      );
    });
  });

  describe('non-text messages', () => {
    it('returns [Image] placeholder for image messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({
        messageType: 'image',
        content: JSON.stringify({ image_key: 'img_xxx' }),
      });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Image]' }),
      );
    });

    it('extracts plain text from post rich-text messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const postContent = {
        zh_cn: {
          title: 'My Title',
          content: [
            [
              { tag: 'text', text: 'Hello ' },
              { tag: 'a', text: 'link', href: 'https://example.com' },
            ],
            [
              { tag: 'at', user_id: 'ou_xxx' },
              { tag: 'text', text: ' world' },
            ],
          ],
        },
      };

      const event = createMessageEvent({
        messageType: 'post',
        content: JSON.stringify(postContent),
      });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: 'My Title\nHello link\n@ou_xxx world',
        }),
      );
    });

    it('returns [File] for file messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({ messageType: 'file', content: '{}' });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[File]' }),
      );
    });

    it('returns [Audio] for audio messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({ messageType: 'audio', content: '{}' });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('returns [Video] for media messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({ messageType: 'media', content: '{}' });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('returns [Sticker] for sticker messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({ messageType: 'sticker', content: '{}' });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Sticker]' }),
      );
    });

    it('returns [Unsupported: share_chat] for unknown types', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('id', 'secret', opts);
      await channel.connect();

      const event = createMessageEvent({ messageType: 'share_chat', content: '{}' });
      await triggerEvent('im.message.receive_v1', event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Unsupported: share_chat]' }),
      );
    });
  });
});
