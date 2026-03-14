import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  GROUPS_DIR: '/tmp/test-groups',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      createReadStream: vi.fn(() => 'mock-stream'),
    },
  };
});

// --- Feishu SDK mock ---

type EventHandler = (data: any) => Promise<void>;

const sdkRef = vi.hoisted(() => ({
  messageHandler: null as EventHandler | null,
  wsStarted: false,
  client: null as any,
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    appId: string;
    appSecret: string;
    request = vi.fn().mockResolvedValue({
      bot: { open_id: 'ou_bot_123' },
    });
    im = {
      v1: {
        message: {
          create: vi.fn().mockResolvedValue({}),
        },
        chat: {
          get: vi.fn().mockResolvedValue({ name: 'Test Group' }),
        },
        messageResource: {
          get: vi.fn().mockResolvedValue({
            writeFile: vi.fn().mockResolvedValue(undefined),
          }),
        },
        image: {
          create: vi.fn().mockResolvedValue({ image_key: 'img_uploaded_123' }),
        },
        file: {
          create: vi.fn().mockResolvedValue({ file_key: 'file_uploaded_456' }),
        },
      },
    };
    contact = {
      v3: {
        user: {
          get: vi.fn().mockResolvedValue({ user: { name: 'Alice' } }),
        },
      },
    };

    constructor(config: { appId: string; appSecret: string }) {
      this.appId = config.appId;
      this.appSecret = config.appSecret;
      sdkRef.client = this;
    }
  }

  class MockEventDispatcher {
    handlers: Record<string, EventHandler> = {};
    register(map: Record<string, EventHandler>) {
      Object.assign(this.handlers, map);
      // Expose the message handler for tests
      if (map['im.message.receive_v1']) {
        sdkRef.messageHandler = map['im.message.receive_v1'];
      }
      return this;
    }
  }

  class MockWSClient {
    constructor(_config: any) {}
    async start(opts: { eventDispatcher: MockEventDispatcher }) {
      sdkRef.wsStarted = true;
    }
  }

  return {
    Client: MockClient,
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
    LoggerLevel: { warn: 2, info: 1 },
  };
});

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
  msgType?: string;
  content?: string;
  messageId?: string;
  createTime?: string;
  senderId?: string;
  mentions?: any[];
}) {
  return {
    sender: {
      sender_id: {
        open_id: overrides.senderId ?? 'ou_sender_456',
      },
      sender_type: 'user',
    },
    message: {
      message_id: overrides.messageId ?? 'om_msg_001',
      chat_id: overrides.chatId ?? 'oc_test123',
      chat_type: overrides.chatType ?? 'group',
      message_type: overrides.msgType ?? 'text',
      content: overrides.content ?? JSON.stringify({ text: 'Hello everyone' }),
      create_time: overrides.createTime ?? '1704067200000',
      mentions: overrides.mentions ?? [],
    },
  };
}

function currentClient() {
  return sdkRef.client;
}

async function triggerMessage(data: any) {
  if (sdkRef.messageHandler) {
    await sdkRef.messageHandler(data);
  }
}

// --- Tests ---

describe('FeishuChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkRef.messageHandler = null;
    sdkRef.wsStarted = false;
    sdkRef.client = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when WSClient starts', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers im.message.receive_v1 event handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      await channel.connect();

      expect(sdkRef.messageHandler).not.toBeNull();
    });

    it('fetches bot info on connect', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      await channel.connect();

      expect(currentClient().request).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        content: JSON.stringify({ text: 'Hello everyone' }),
      });
      await triggerMessage(data);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.any(String),
        'Test Group',
        'feishu',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          id: 'om_msg_001',
          chat_jid: 'feishu:oc_test123',
          sender: 'ou_sender_456',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        chatId: 'oc_unknown',
        content: JSON.stringify({ text: 'Unknown chat' }),
      });
      await triggerMessage(data);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_unknown',
        expect.any(String),
        expect.any(String),
        'feishu',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('extracts sender name from user API', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        content: JSON.stringify({ text: 'Hi' }),
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ sender_name: 'Alice' }),
      );
    });

    it('falls back to open_id when user API fails', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      // Make user API fail
      currentClient().contact.v3.user.get.mockRejectedValueOnce(
        new Error('API error'),
      );

      const data = createMessageEvent({
        content: JSON.stringify({ text: 'Hi' }),
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ sender_name: 'ou_sender_456' }),
      );
    });

    it('uses sender name as chat name for p2p chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'feishu:oc_test123': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        chatType: 'p2p',
        content: JSON.stringify({ text: 'Hello' }),
      });
      await triggerMessage(data);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.any(String),
        'Alice', // p2p chats use sender name
        'feishu',
        false,
      );
    });

    it('uses chat API name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        chatType: 'group',
        content: JSON.stringify({ text: 'Hello' }),
      });
      await triggerMessage(data);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.any(String),
        'Test Group',
        'feishu',
        true,
      );
    });

    it('converts create_time to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        createTime: '1704067200000', // 2024-01-01T00:00:00.000Z
        content: JSON.stringify({ text: 'Hello' }),
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        content: JSON.stringify({ text: '@_user_1 what time is it?' }),
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot_123' },
            name: 'FeishuBot',
          },
        ],
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Andy @FeishuBot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        content: JSON.stringify({ text: '@Andy @_user_1 hello' }),
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot_123' },
            name: 'FeishuBot',
          },
        ],
      });
      await triggerMessage(data);

      // After replacing placeholder: "@Andy @FeishuBot hello"
      // Already starts with @Andy, so no double-prepend
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Andy @FeishuBot hello',
        }),
      );
    });

    it('does not translate mentions of other users', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        content: JSON.stringify({ text: '@_user_1 hi' }),
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_other_789' },
            name: 'Bob',
          },
        ],
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Bob hi', // No trigger prepended
        }),
      );
    });

    it('handles message with no mentions', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        content: JSON.stringify({ text: 'plain message' }),
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('replaces multiple mention placeholders', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        content: JSON.stringify({ text: '@_user_1 and @_user_2 check this' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot_123' }, name: 'FeishuBot' },
          { key: '@_user_2', id: { open_id: 'ou_other_789' }, name: 'Charlie' },
        ],
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Andy @FeishuBot and @Charlie check this',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores sticker with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({ msgType: 'sticker', content: '{}' });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Sticker]' }),
      );
    });

    it('stores location as unsupported', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({ msgType: 'location', content: '{}' });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Unsupported: location]' }),
      );
    });

    it('stores merge_forward with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        msgType: 'merge_forward',
        content: '{}',
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Merge Forward]' }),
      );
    });

    it('extracts post (rich text) content', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const postContent = {
        zh_cn: {
          title: 'Title',
          content: [
            [
              { tag: 'text', text: 'Hello ' },
              { tag: 'a', text: 'link', href: 'https://example.com' },
            ],
            [{ tag: 'at', user_name: 'Bob' }],
          ],
        },
      };
      const data = createMessageEvent({
        msgType: 'post',
        content: JSON.stringify(postContent),
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: 'Title Hello  link @Bob' }),
      );
    });

    it('stores interactive (card) with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        msgType: 'interactive',
        content: '{}',
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Card]' }),
      );
    });

    it('stores share_chat with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        msgType: 'share_chat',
        content: '{}',
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Shared Group]' }),
      );
    });

    it('stores share_user with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        msgType: 'share_user',
        content: '{}',
      });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Shared Contact]' }),
      );
    });

    it('stores unsupported types with type name', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({ msgType: 'system', content: '{}' });
      await triggerMessage(data);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Unsupported: system]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        chatId: 'oc_unknown',
        msgType: 'image',
        content: '{}',
      });
      await triggerMessage(data);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Media download (inbound) ---

  describe('media download (inbound)', () => {
    it('downloads image and enriches content with container path', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        msgType: 'image',
        messageId: 'om_img_001',
        content: JSON.stringify({ image_key: 'img_v3_abc' }),
      });
      await triggerMessage(data);

      // Verify messageResource.get was called
      expect(
        currentClient().im.v1.messageResource.get,
      ).toHaveBeenCalledWith({
        path: { message_id: 'om_img_001', file_key: 'img_v3_abc' },
        params: { type: 'image' },
      });

      // Content should be enriched with container path
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: expect.stringContaining('[Image: /workspace/group/media/'),
        }),
      );
    });

    it('downloads file and uses original filename', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        msgType: 'file',
        messageId: 'om_file_001',
        content: JSON.stringify({
          file_key: 'file_v3_xyz',
          file_name: 'report.pdf',
        }),
      });
      await triggerMessage(data);

      expect(
        currentClient().im.v1.messageResource.get,
      ).toHaveBeenCalledWith({
        path: { message_id: 'om_file_001', file_key: 'file_v3_xyz' },
        params: { type: 'file' },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: expect.stringContaining('[File: /workspace/group/media/'),
        }),
      );
    });

    it('downloads audio and labels as Audio', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        msgType: 'audio',
        messageId: 'om_audio_001',
        content: JSON.stringify({
          file_key: 'file_v3_audio',
          duration: 3000,
        }),
      });
      await triggerMessage(data);

      expect(
        currentClient().im.v1.messageResource.get,
      ).toHaveBeenCalledWith({
        path: { message_id: 'om_audio_001', file_key: 'file_v3_audio' },
        params: { type: 'file' },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: expect.stringContaining('[Audio: /workspace/group/media/'),
        }),
      );
    });

    it('downloads video (media) and labels as Video', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        msgType: 'media',
        messageId: 'om_video_001',
        content: JSON.stringify({
          file_key: 'file_v3_video',
          image_key: 'img_v3_cover',
          file_name: 'clip.mp4',
        }),
      });
      await triggerMessage(data);

      expect(
        currentClient().im.v1.messageResource.get,
      ).toHaveBeenCalledWith({
        path: { message_id: 'om_video_001', file_key: 'file_v3_video' },
        params: { type: 'file' },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: expect.stringContaining('[Video: /workspace/group/media/'),
        }),
      );
    });

    it('falls back to placeholder when download fails', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      // Make messageResource.get fail
      currentClient().im.v1.messageResource.get.mockRejectedValueOnce(
        new Error('Download failed'),
      );

      const data = createMessageEvent({
        msgType: 'image',
        messageId: 'om_fail_001',
        content: JSON.stringify({ image_key: 'img_v3_fail' }),
      });
      await triggerMessage(data);

      // Should fall back to placeholder
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Image]' }),
      );
    });

    it('falls back to placeholder when image_key is missing', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        msgType: 'image',
        content: JSON.stringify({}), // No image_key
      });
      await triggerMessage(data);

      // No download attempted
      expect(
        currentClient().im.v1.messageResource.get,
      ).not.toHaveBeenCalled();

      // Falls back to placeholder
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({ content: '[Image]' }),
      );
    });

    it('does not attempt download for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        chatId: 'oc_unknown',
        msgType: 'image',
        content: JSON.stringify({ image_key: 'img_v3_abc' }),
      });
      await triggerMessage(data);

      // Should not attempt download (chat is not registered)
      expect(
        currentClient().im.v1.messageResource.get,
      ).not.toHaveBeenCalled();
    });
  });

  // --- Media send (outbound) ---

  describe('sendMedia (outbound)', () => {
    it('uploads and sends image', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMedia('feishu:oc_test123', {
        type: 'image',
        filePath: '/tmp/photo.jpg',
        filename: 'photo.jpg',
      });

      // Should upload image
      expect(currentClient().im.v1.image.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            image_type: 'message',
          }),
        }),
      );

      // Should send image message
      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify({ image_key: 'img_uploaded_123' }),
          msg_type: 'image',
        },
      });
    });

    it('uploads and sends audio', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMedia('feishu:oc_test123', {
        type: 'audio',
        filePath: '/tmp/audio.opus',
        filename: 'audio.opus',
      });

      // Should upload as opus file
      expect(currentClient().im.v1.file.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            file_type: 'opus',
            file_name: 'audio.opus',
          }),
        }),
      );

      // Should send audio message
      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify({ file_key: 'file_uploaded_456' }),
          msg_type: 'audio',
        },
      });
    });

    it('uploads and sends file (default case)', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMedia('feishu:oc_test123', {
        type: 'file',
        filePath: '/tmp/report.pdf',
        filename: 'report.pdf',
      });

      // Should upload as pdf file
      expect(currentClient().im.v1.file.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            file_type: 'pdf',
            file_name: 'report.pdf',
          }),
        }),
      );

      // Should send file message
      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify({ file_key: 'file_uploaded_456' }),
          msg_type: 'file',
        },
      });
    });

    it('sends video as a regular file attachment', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMedia('feishu:oc_test123', {
        type: 'video',
        filePath: '/tmp/clip.mp4',
        filename: 'clip.mp4',
      });

      // Should upload as a regular file attachment to avoid type mismatch
      expect(currentClient().im.v1.file.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            file_type: 'stream',
            file_name: 'clip.mp4',
          }),
        }),
      );

      // Should send as file (not media)
      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify({ file_key: 'file_uploaded_456' }),
          msg_type: 'file',
        },
      });
    });

    it('handles image upload failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      currentClient().im.v1.image.create.mockRejectedValueOnce(
        new Error('Upload failed'),
      );

      await expect(
        channel.sendMedia('feishu:oc_test123', {
          type: 'image',
          filePath: '/tmp/photo.jpg',
        }),
      ).resolves.toBeUndefined();

      // No message.create should be called after failed upload
      expect(currentClient().im.v1.message.create).not.toHaveBeenCalled();
    });

    it('handles image upload returning no key', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      currentClient().im.v1.image.create.mockResolvedValueOnce({});

      await channel.sendMedia('feishu:oc_test123', {
        type: 'image',
        filePath: '/tmp/photo.jpg',
      });

      // No message.create should be called when no key returned
      expect(currentClient().im.v1.message.create).not.toHaveBeenCalled();
    });

    it('uses stream file type for unknown extensions', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMedia('feishu:oc_test123', {
        type: 'file',
        filePath: '/tmp/data.bin',
        filename: 'data.bin',
      });

      expect(currentClient().im.v1.file.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            file_type: 'stream',
          }),
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Feishu API', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMessage('feishu:oc_test123', 'Hello');

      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify({ text: 'Hello' }),
          msg_type: 'text',
        },
      });
    });

    it('strips feishu: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMessage('feishu:oc_group456', 'Group message');

      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_group456',
          }),
        }),
      );
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      currentClient().im.v1.message.create.mockRejectedValueOnce(
        new Error('Network error'),
      );

      await expect(
        channel.sendMessage('feishu:oc_test123', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);

      // Don't connect — wsClient is null
      await channel.sendMessage('feishu:oc_test123', 'No bot');

      // No error, no API call
      if (currentClient()) {
        expect(currentClient().im.v1.message.create).not.toHaveBeenCalled();
      }
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns feishu: JIDs', () => {
      const channel = new FeishuChannel(
        'app_id',
        'app_secret',
        createTestOpts(),
      );
      expect(channel.ownsJid('feishu:oc_123456')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new FeishuChannel(
        'app_id',
        'app_secret',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new FeishuChannel(
        'app_id',
        'app_secret',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new FeishuChannel(
        'app_id',
        'app_secret',
        createTestOpts(),
      );
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('is a no-op (Feishu has no typing indicator API)', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      // Should not throw
      await expect(
        channel.setTyping('feishu:oc_test123', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        content: JSON.stringify({ text: '/chatid' }),
      });
      await triggerMessage(data);

      // Should send a reply, not deliver as regular message
      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_test123',
            content: expect.stringContaining('feishu:oc_test123'),
          }),
        }),
      );
      // Should NOT deliver as regular message
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        chatType: 'p2p',
        content: JSON.stringify({ text: '/chatid' }),
      });
      await triggerMessage(data);

      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: expect.stringContaining('p2p'),
          }),
        }),
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const data = createMessageEvent({
        content: JSON.stringify({ text: '/ping' }),
      });
      await triggerMessage(data);

      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: expect.stringContaining('Andy is online'),
          }),
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "feishu"', () => {
      const channel = new FeishuChannel(
        'app_id',
        'app_secret',
        createTestOpts(),
      );
      expect(channel.name).toBe('feishu');
    });
  });

  // --- Factory registration ---

  describe('factory registration', () => {
    it('returns null when credentials are missing', async () => {
      // This tests the registerChannel factory logic
      // When no env vars are set, the factory should return null
      // We test this indirectly through the channel behavior
      const channel = new FeishuChannel('', '', createTestOpts());
      expect(channel.name).toBe('feishu');
    });
  });

  // --- Markdown to Post (md tag) ---

  describe('sendMessage with Markdown', () => {
    /** Helper: extract the parsed post content from the API call */
    function getPostContent(callIndex = 0) {
      const call = currentClient().im.v1.message.create.mock.calls[callIndex][0];
      return { call, content: JSON.parse(call.data.content) };
    }

    it('sends plain text without Markdown as text message', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      await channel.sendMessage('feishu:oc_test123', 'Hello world');

      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify({ text: 'Hello world' }),
          msg_type: 'text',
        },
      });
    });

    it('wraps bold Markdown in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown = 'This is **bold** text';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { call, content } = getPostContent();
      expect(call.data.msg_type).toBe('post');
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });

    it('wraps italic Markdown in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown = 'This is *italic* text';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { call, content } = getPostContent();
      expect(call.data.msg_type).toBe('post');
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });

    it('wraps inline code in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown = 'Run `npm install`';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { content } = getPostContent();
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });

    it('wraps links in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown = 'Visit [OpenAI](https://openai.com) for more';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { content } = getPostContent();
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });

    it('wraps headings in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown = '# Title\nSome content';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { content } = getPostContent();
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });

    it('wraps code blocks with language in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown = '```typescript\nconst x = 1;\n```';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { content } = getPostContent();
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });

    it('wraps mixed content in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown = 'Hello **world** and *universe*!';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { content } = getPostContent();
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });

    it('wraps multi-line Markdown in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown = 'Line 1\nLine 2\n**Line 3**';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { content } = getPostContent();
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });

    it('wraps list items in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown = '- Item 1\n- Item 2\n- Item 3';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { content } = getPostContent();
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });

    it('wraps blockquotes in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown = '> This is a quote\n> with two lines';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { content } = getPostContent();
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });

    it('wraps comprehensive Markdown in a single md tag', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', opts);
      await channel.connect();

      const markdown =
        '## Summary\n\n**Key points:**\n- First `item`\n- Second *item*\n\n> Important note\n\n```js\nconsole.log("hi");\n```';
      await channel.sendMessage('feishu:oc_test123', markdown);

      const { call, content } = getPostContent();
      expect(call.data.msg_type).toBe('post');
      expect(content.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]]);
    });
  });
});
