import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  GROUPS_DIR: '/tmp/test-groups',
  PROJECT_ROOT: '/tmp/test-project',
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

// --- @larksuiteoapi/node-sdk mock ---

type MessageHandler = (data: any) => Promise<void>;

const wsClientRef = vi.hoisted(() => ({ current: null as any }));
const reactionMocks = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ data: { reaction_id: 'rxn_mock_001' } }),
  delete: vi.fn().mockResolvedValue({}),
}));
const messageMocks = vi.hoisted(() => ({
  create: vi
    .fn()
    .mockResolvedValue({ code: 0, data: { message_id: 'sent_msg_001' } }),
  reply: vi
    .fn()
    .mockResolvedValue({ code: 0, data: { message_id: 'reply_msg_001' } }),
  get: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
}));
const messageResourceMocks = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(Buffer.from('fake-image-data')),
}));

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

    request = vi
      .fn()
      .mockResolvedValue({ bot: { open_id: 'ou_bot_open_id_mock' } });

    im = {
      message: messageMocks,
      messageReaction: {
        create: reactionMocks.create,
        delete: reactionMocks.delete,
      },
      messageResource: messageResourceMocks,
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

function createTestOpts(
  overrides?: Partial<FeishuChannelOpts>,
): FeishuChannelOpts {
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
  messageType?: string;
  parentId?: string;
}) {
  return {
    sender: {
      sender_id: { open_id: overrides.openId ?? 'ou_user_open_id' },
    },
    message: {
      message_id: overrides.msgId ?? 'msg_001',
      chat_id: overrides.chatId ?? 'oc_group_id_001',
      chat_type: overrides.chatType ?? 'group',
      message_type: overrides.messageType ?? 'text',
      content: JSON.stringify({ text: overrides.content ?? 'Hello' }),
      create_time: overrides.createTime ?? '1704067200000',
      mentions: overrides.mentions ?? [],
      ...(overrides.parentId ? { parent_id: overrides.parentId } : {}),
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
    // Restore default mock return values
    messageMocks.create.mockResolvedValue({
      code: 0,
      data: { message_id: 'sent_msg_001' },
    });
    messageMocks.reply.mockResolvedValue({
      code: 0,
      data: { message_id: 'reply_msg_001' },
    });
    messageMocks.get.mockResolvedValue({ code: 0, data: { items: [] } });
    messageResourceMocks.get.mockResolvedValue(Buffer.from('fake-image-data'));
    reactionMocks.create.mockResolvedValue({
      data: { reaction_id: 'rxn_mock_001' },
    });
    reactionMocks.delete.mockResolvedValue({});
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

  // --- post inbound parsing ---

  describe('post inbound parsing', () => {
    it('extracts text from post message', async () => {
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

      const postContent = JSON.stringify({
        zh_cn: {
          title: 'My Title',
          content: [
            [
              { tag: 'text', text: 'Hello ' },
              { tag: 'text', text: 'world' },
            ],
          ],
        },
      });
      const event = {
        sender: { sender_id: { open_id: 'ou_user_open_id' } },
        message: {
          message_id: 'msg_post_001',
          chat_id: 'oc_group_id_001',
          chat_type: 'group',
          message_type: 'post',
          content: postContent,
          create_time: '1704067200000',
          mentions: [],
        },
      };
      await triggerMessage(channel, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({
          content: expect.stringContaining('Hello world'),
        }),
      );
    });

    it('falls back to [Rich text message] for unparseable post', async () => {
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

      const event = {
        sender: { sender_id: { open_id: 'ou_user_open_id' } },
        message: {
          message_id: 'msg_post_002',
          chat_id: 'oc_group_id_001',
          chat_type: 'group',
          message_type: 'post',
          content: 'not json',
          create_time: '1704067200000',
          mentions: [],
        },
      };
      await triggerMessage(channel, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({ content: '[Rich text message]' }),
      );
    });
  });

  // --- quoted message context ---

  describe('quoted message context', () => {
    it('prepends quoted text when parent_id is present', async () => {
      messageMocks.get.mockResolvedValue({
        code: 0,
        data: {
          items: [
            {
              msg_type: 'text',
              body: { content: JSON.stringify({ text: 'original question' }) },
            },
          ],
        },
      });

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
        content: 'follow-up answer',
        parentId: 'parent_msg_001',
      });
      await triggerMessage(channel, event);

      expect(messageMocks.get).toHaveBeenCalledWith({
        path: { message_id: 'parent_msg_001' },
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({
          content: '[Quoted: original question]\nfollow-up answer',
        }),
      );
    });

    it('delivers message normally when quoted fetch fails', async () => {
      messageMocks.get.mockRejectedValue(new Error('API error'));

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
        content: 'my message',
        parentId: 'parent_msg_002',
      });
      await triggerMessage(channel, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({ content: 'my message' }),
      );
    });
  });

  // --- media download ---

  describe('media download', () => {
    it('downloads image and sets content to file path', async () => {
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

      const event = {
        sender: { sender_id: { open_id: 'ou_user_open_id' } },
        message: {
          message_id: 'msg_img_001',
          chat_id: 'oc_group_id_001',
          chat_type: 'group',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_abcdefgh' }),
          create_time: '1704067200000',
          mentions: [],
        },
      };
      await triggerMessage(channel, event);

      expect(messageResourceMocks.get).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg_img_001', file_key: 'img_abcdefgh' },
          params: { type: 'image' },
        }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({
          content: expect.stringContaining('[Downloaded:'),
        }),
      );
    });

    it('sets placeholder when download fails', async () => {
      messageResourceMocks.get.mockRejectedValue(new Error('download error'));

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

      const event = {
        sender: { sender_id: { open_id: 'ou_user_open_id' } },
        message: {
          message_id: 'msg_img_002',
          chat_id: 'oc_group_id_001',
          chat_type: 'group',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_fail_key' }),
          create_time: '1704067200000',
          mentions: [],
        },
      };
      await triggerMessage(channel, event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({ content: '[image: unable to download]' }),
      );
    });

    it('downloads embedded image from post message and appends path', async () => {
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

      const postContent = JSON.stringify({
        zh_cn: {
          content: [
            [{ tag: 'text', text: 'See image:' }],
            [{ tag: 'img', image_key: 'img_embed_001' }],
          ],
        },
      });
      const event = {
        sender: { sender_id: { open_id: 'ou_user_open_id' } },
        message: {
          message_id: 'msg_post_img_001',
          chat_id: 'oc_group_id_001',
          chat_type: 'group',
          message_type: 'post',
          content: postContent,
          create_time: '1704067200000',
          mentions: [],
        },
      };
      await triggerMessage(channel, event);

      expect(messageResourceMocks.get).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg_post_img_001', file_key: 'img_embed_001' },
          params: { type: 'image' },
        }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_group_id_001',
        expect.objectContaining({
          content: expect.stringContaining('[Image:'),
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends to group chat using post format', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMessage('fs:oc_group_id_001', 'Hello group');

      const anyChannel = channel as any;
      expect(anyChannel.client.im.message.create).toHaveBeenCalledWith({
        data: {
          receive_id: 'oc_group_id_001',
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: { content: [[{ tag: 'md', text: 'Hello group' }]] },
          }),
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
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: { content: [[{ tag: 'md', text: 'Hello DM' }]] },
          }),
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

  // --- thread reply ---

  describe('thread reply', () => {
    it('replies to triggering message when cached message ID exists', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      // Trigger a message to populate lastMessageIdByJid
      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy hello',
        msgId: 'trigger_msg_001',
      });
      await triggerMessage(channel, event);

      messageMocks.create.mockClear();
      await channel.sendMessage('fs:oc_group_id_001', 'my reply');

      expect(messageMocks.reply).toHaveBeenCalledWith({
        path: { message_id: 'trigger_msg_001' },
        data: expect.objectContaining({ msg_type: 'post' }),
      });
      expect(messageMocks.create).not.toHaveBeenCalled();
    });

    it('falls back to create when no cached message ID', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      // No prior message event — no cached ID
      await channel.sendMessage('fs:oc_group_id_001', 'unprompted');

      expect(messageMocks.reply).not.toHaveBeenCalled();
      expect(messageMocks.create).toHaveBeenCalled();
    });

    it('falls back to create when reply target is withdrawn', async () => {
      // reply() returns withdrawn error code
      messageMocks.reply.mockResolvedValue({ code: 230011, msg: 'withdrawn' });

      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy hello',
        msgId: 'withdrawn_msg_001',
      });
      await triggerMessage(channel, event);

      messageMocks.create.mockClear();
      await channel.sendMessage('fs:oc_group_id_001', 'fallback reply');

      expect(messageMocks.reply).toHaveBeenCalled();
      expect(messageMocks.create).toHaveBeenCalled();
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
    it('silently ignores when no cached message (e.g. before any message)', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await expect(
        channel.setTyping('fs:oc_group_id_001', true),
      ).resolves.toBeUndefined();
      expect(reactionMocks.create).not.toHaveBeenCalled();
    });

    it('adds Typing reaction when message cached, removes when done', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy hello',
      });
      await triggerMessage(channel, event);

      await channel.setTyping('fs:oc_group_id_001', true);
      expect(reactionMocks.create).toHaveBeenCalledWith({
        path: { message_id: 'msg_001' },
        data: { reaction_type: { emoji_type: 'Typing' } },
      });

      await channel.setTyping('fs:oc_group_id_001', false);
      expect(reactionMocks.delete).toHaveBeenCalledWith({
        path: { message_id: 'msg_001', reaction_id: 'rxn_mock_001' },
      });
    });

    it('uses original message_id for delete even when a new message arrives during processing', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      // First message triggers the bot
      const event1 = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy hello',
        msgId: 'msg_first',
      });
      await triggerMessage(channel, event1);

      await channel.setTyping('fs:oc_group_id_001', true);
      expect(reactionMocks.create).toHaveBeenCalledWith({
        path: { message_id: 'msg_first' },
        data: { reaction_type: { emoji_type: 'Typing' } },
      });

      // A second message arrives while the bot is still processing
      const event2 = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy follow-up',
        msgId: 'msg_second',
      });
      await triggerMessage(channel, event2);

      // setTyping(false) must still delete from msg_first, not msg_second
      await channel.setTyping('fs:oc_group_id_001', false);
      expect(reactionMocks.delete).toHaveBeenCalledWith({
        path: { message_id: 'msg_first', reaction_id: 'rxn_mock_001' },
      });
    });

    it('trips backoff when thrown error has backoff code', async () => {
      reactionMocks.create.mockRejectedValue({ code: 99991400 });

      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy hello',
      });
      await triggerMessage(channel, event);

      await channel.setTyping('fs:oc_group_id_001', true);

      // Should not throw and backoff should be set
      const anyChannel = channel as any;
      expect(anyChannel.typingBackoffUntil).toBeGreaterThan(Date.now());
    });

    it('trips backoff when response body contains backoff code', async () => {
      reactionMocks.create.mockResolvedValue({ code: 99991403 });

      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy hello',
      });
      await triggerMessage(channel, event);

      await channel.setTyping('fs:oc_group_id_001', true);

      const anyChannel = channel as any;
      expect(anyChannel.typingBackoffUntil).toBeGreaterThan(Date.now());
    });

    it('suppresses typing calls during backoff period', async () => {
      reactionMocks.create.mockRejectedValue({ code: 429 });

      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy hello',
      });
      await triggerMessage(channel, event);

      // First call trips the breaker
      await channel.setTyping('fs:oc_group_id_001', true);
      expect(reactionMocks.create).toHaveBeenCalledTimes(1);

      reactionMocks.create.mockClear();

      // Subsequent calls during backoff should not call the API
      await triggerMessage(channel, event);
      await channel.setTyping('fs:oc_group_id_001', true);
      expect(reactionMocks.create).not.toHaveBeenCalled();
    });

    it('silently ignores non-backoff errors without tripping breaker', async () => {
      reactionMocks.create.mockRejectedValue(new Error('message deleted'));

      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_group_id_001',
        content: '@Andy hello',
      });
      await triggerMessage(channel, event);

      await channel.setTyping('fs:oc_group_id_001', true);

      const anyChannel = channel as any;
      expect(anyChannel.typingBackoffUntil).toBe(0);
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
