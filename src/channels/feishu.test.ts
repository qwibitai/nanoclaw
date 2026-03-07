import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

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

// --- @larksuiteoapi/node-sdk mock ---

type MessageHandler = (data: any) => Promise<void>;

const wsClientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    appId: string;
    appSecret: string;

    constructor(opts: any) {
      this.appId = opts.appId;
      this.appSecret = opts.appSecret;
    }

    bot = {
      v3: {
        botInfo: {
          get: vi.fn().mockResolvedValue({
            data: { bot: { open_id: 'ou_bot_open_id_mock' } },
          }),
        },
      },
    };

    im = {
      message: {
        create: vi.fn().mockResolvedValue({ data: {} }),
      },
    };
  }

  class MockWSClient {
    handlers = new Map<string, MessageHandler>();

    constructor(_opts: any) {
      wsClientRef.current = this;
    }

    start({ eventDispatcher }: { eventDispatcher: any }) {
      // Capture the dispatcher so tests can trigger events
      wsClientRef.current._dispatcher = eventDispatcher;
    }
  }

  class MockEventDispatcher {
    _handlers: Record<string, MessageHandler> = {};

    register(handlers: Record<string, MessageHandler>) {
      Object.assign(this._handlers, handlers);
      return this;
    }
  }

  return {
    Client: MockClient,
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
  };
});

import { FeishuChannel, FeishuChannelOpts } from './feishu.js';

// --- Helpers ---

function createTestOpts(overrides?: Partial<FeishuChannelOpts>): FeishuChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'fs:oc_group_id_001': {
        name: 'Test Group',
        folder: 'test_group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: true,
      },
      'fs:p_ou_user_open_id': {
        name: 'Direct Chat',
        folder: 'direct',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    })),
    ...overrides,
  };
}

function makeEvent(overrides: {
  chatId?: string;
  chatType?: 'p2p' | 'group';
  openId?: string;
  content?: string;
  msgId?: string;
  createTime?: string;
  mentions?: Array<{ id?: { open_id?: string } }>;
}) {
  return {
    sender: {
      sender_id: { open_id: overrides.openId ?? 'ou_user_open_id' },
    },
    message: {
      message_id: overrides.msgId ?? 'msg_001',
      chat_id: overrides.chatId ?? 'oc_group_id_001',
      chat_type: overrides.chatType ?? 'group',
      message_type: 'text',
      content: JSON.stringify({ text: overrides.content ?? 'Hello' }),
      create_time: overrides.createTime ?? '1704067200000',
      mentions: overrides.mentions ?? [],
    },
  };
}

async function triggerMessage(channel: FeishuChannel, event: any) {
  const dispatcher = wsClientRef.current?._dispatcher;
  const handler = dispatcher?._handlers?.['im.message.receive_v1'];
  if (handler) await handler(event);
}

// --- Tests ---

describe('FeishuChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connect() starts WebSocket client', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect() clears client references', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Group chat message handling ---

  describe('group chat messages', () => {
    it('delivers message with trigger for registered group', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy hello',
      });
      await triggerMessage(channel, event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.any(String),
        'oc_group_id_001',
        'feishu',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({
          id: 'msg_001',
          chat_jid: 'fs:oc_group_id_001',
          content: '@Andy hello',
          is_from_me: false,
        }),
      );
    });

    it('ignores group message without trigger when requiresTrigger is true', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: 'hello without trigger',
      });
      await triggerMessage(channel, event);

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('only emits metadata for unregistered group', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_unknown_group',
        content: '@Andy hi',
      });
      await triggerMessage(channel, event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'fs:oc_unknown_group',
        expect.any(String),
        'oc_unknown_group',
        'feishu',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Private chat message handling ---

  describe('private chat messages', () => {
    it('delivers p2p message using fs:p_ JID prefix', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'p2p',
        openId: 'ou_user_open_id',
        content: 'hey there',
      });
      await triggerMessage(channel, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:p_ou_user_open_id',
        expect.objectContaining({
          chat_jid: 'fs:p_ou_user_open_id',
          content: 'hey there',
        }),
      );
    });

    it('emits metadata with isGroup=false for p2p', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'p2p',
        openId: 'ou_user_open_id',
        content: 'hello',
      });
      await triggerMessage(channel, event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'fs:p_ou_user_open_id',
        expect.any(String),
        'ou_user_open_id',
        'feishu',
        false,
      );
    });
  });

  // --- @mention normalisation ---

  describe('@mention normalisation', () => {
    it('strips <at> tags and prepends trigger when bot is mentioned', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '<at user_id="ou_bot_open_id_mock">Andy</at> what time is it?',
        mentions: [{ id: { open_id: 'ou_bot_open_id_mock' } }],
      });
      await triggerMessage(channel, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({
          content: '@Andy what time is it?',
        }),
      );
    });

    it('does not prepend trigger if content already matches pattern', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy <at user_id="ou_bot_open_id_mock">Andy</at> help',
        mentions: [{ id: { open_id: 'ou_bot_open_id_mock' } }],
      });
      await triggerMessage(channel, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({
          content: '@Andy  help',
        }),
      );
    });

    it('does not modify content when bot is not mentioned', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'fs:oc_group_id_001': {
            name: 'Test Group',
            folder: 'test_group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            requiresTrigger: false,
          },
        })),
      });
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: 'hello everyone',
        mentions: [],
      });
      await triggerMessage(channel, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({ content: 'hello everyone' }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends to group chat using chat_id receive_id_type', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMessage('fs:oc_group_id_001', 'Hello group');

      const { Client } = await import('@larksuiteoapi/node-sdk');
      const clientInstance = new (Client as any)({ appId: '', appSecret: '' });
      // Access the underlying mock client via the channel's private field
      const anyChannel = channel as any;
      expect(anyChannel.client.im.message.create).toHaveBeenCalledWith({
        data: {
          receive_id: 'oc_group_id_001',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello group' }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    });

    it('sends to p2p chat using open_id receive_id_type', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMessage('fs:p_ou_user_open_id', 'Hello DM');

      const anyChannel = channel as any;
      expect(anyChannel.client.im.message.create).toHaveBeenCalledWith({
        data: {
          receive_id: 'ou_user_open_id',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Hello DM' }),
        },
        params: { receive_id_type: 'open_id' },
      });
    });

    it('splits long messages exceeding 4000 bytes', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      // ASCII chars: 1 byte each, so 4001 chars = 2 chunks
      const longText = 'x'.repeat(4001);
      await channel.sendMessage('fs:oc_group_id_001', longText);

      const anyChannel = channel as any;
      expect(anyChannel.client.im.message.create).toHaveBeenCalledTimes(2);
    });

    it('sends single chunk for short message', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMessage('fs:oc_group_id_001', 'short');

      const anyChannel = channel as any;
      expect(anyChannel.client.im.message.create).toHaveBeenCalledTimes(1);
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      // Not connected — should not throw
      await expect(
        channel.sendMessage('fs:oc_group_id_001', 'no client'),
      ).resolves.toBeUndefined();
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const anyChannel = channel as any;
      anyChannel.client.im.message.create.mockRejectedValueOnce(
        new Error('API error'),
      );

      await expect(
        channel.sendMessage('fs:oc_group_id_001', 'will fail'),
      ).resolves.toBeUndefined();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns fs: group JIDs', () => {
      const channel = new FeishuChannel('a', 'b', createTestOpts());
      expect(channel.ownsJid('fs:oc_xxxxxxxxxx')).toBe(true);
    });

    it('owns fs:p_ private JIDs', () => {
      const channel = new FeishuChannel('a', 'b', createTestOpts());
      expect(channel.ownsJid('fs:p_ou_xxxxxxxxxx')).toBe(true);
    });

    it('does not own Discord JIDs', () => {
      const channel = new FeishuChannel('a', 'b', createTestOpts());
      expect(channel.ownsJid('dc:1234567890')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new FeishuChannel('a', 'b', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new FeishuChannel('a', 'b', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('silently ignores typing calls (no Feishu typing API)', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      // Should not throw
      await expect(
        channel.setTyping('fs:oc_group_id_001', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "feishu"', () => {
      const channel = new FeishuChannel('a', 'b', createTestOpts());
      expect(channel.name).toBe('feishu');
    });
  });
});
