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

const dispatcherRef = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: any) => Promise<void>>,
}));

const clientRef = vi.hoisted(() => ({
  current: null as any,
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    contact = {
      v3: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: 'Test User' } } }),
        },
      },
    };
    im = {
      v1: {
        chat: {
          get: vi.fn().mockResolvedValue({
            data: { name: 'Test Chat', chat_mode: 'group' },
          }),
        },
        message: {
          create: vi.fn().mockResolvedValue({}),
        },
      },
    };

    constructor() {
      clientRef.current = this;
    }
  }

  class MockWSClient {
    async start({ eventDispatcher }: { eventDispatcher: any }) {
      dispatcherRef.handlers = eventDispatcher._handlers;
    }
  }

  class MockEventDispatcher {
    _handlers: Record<string, (data: any) => Promise<void>> = {};

    register(handlers: Record<string, (data: any) => Promise<void>>) {
      this._handlers = handlers;
      dispatcherRef.handlers = handlers;
      return this;
    }
  }

  return {
    Client: MockClient,
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
    LoggerLevel: { info: 'info', debug: 'debug', warn: 'warn', error: 'error' },
  };
});

import { FeishuChannel, FeishuChannelOpts } from './feishu.js';

// --- Helpers ---

function createTestOpts(overrides?: Partial<FeishuChannelOpts>): FeishuChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'fs:oc_chat123': {
        name: 'Test Chat',
        folder: 'test-chat',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  chatId?: string;
  messageId?: string;
  senderId?: string;
  senderType?: string;
  msgType?: string;
  content?: string;
  createTime?: string;
  mentions?: any[];
}) {
  const msgType = overrides.msgType ?? 'text';
  let content: string;
  if (msgType === 'text') {
    content = JSON.stringify({ text: overrides.content ?? 'Hello world' });
  } else {
    content = '{}';
  }

  return {
    event: {
      sender: {
        sender_type: overrides.senderType ?? 'user',
        sender_id: { open_id: overrides.senderId ?? 'ou_user123' },
      },
      message: {
        message_id: overrides.messageId ?? 'om_msg001',
        chat_id: overrides.chatId ?? 'oc_chat123',
        message_type: msgType,
        content,
        create_time: overrides.createTime ?? '1704067200000',
        mentions: overrides.mentions ?? [],
      },
    },
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerMessage(data: any) {
  const handler = dispatcherRef.handlers['im.message.receive_v1'];
  if (handler) await handler(data);
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
    it('resolves connect() and sets up WSClient', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);

      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered chat', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      await triggerMessage(createMessageEvent({ content: 'Hello world' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'fs:oc_chat123',
        expect.any(String),
        'Test Chat',
        'feishu',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_chat123',
        expect.objectContaining({
          id: 'om_msg001',
          chat_jid: 'fs:oc_chat123',
          sender: 'ou_user123',
          content: 'Hello world',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      await triggerMessage(createMessageEvent({ chatId: 'oc_unknown456' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'fs:oc_unknown456',
        expect.any(String),
        expect.any(String),
        'feishu',
        expect.any(Boolean),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores bot (app) messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      await triggerMessage(createMessageEvent({ senderType: 'app' }));

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('uses sender name from user API', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      currentClient().contact.v3.user.get.mockResolvedValueOnce({
        data: { user: { name: 'Alice Wang' } },
      });

      await triggerMessage(createMessageEvent({}));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_chat123',
        expect.objectContaining({ sender_name: 'Alice Wang' }),
      );
    });

    it('falls back to sender open_id when user API fails', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      currentClient().contact.v3.user.get.mockRejectedValueOnce(new Error('forbidden'));

      await triggerMessage(createMessageEvent({ senderId: 'ou_fallback' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_chat123',
        expect.objectContaining({ sender_name: 'ou_fallback' }),
      );
    });

    it('detects group chats via chat_mode', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      currentClient().im.v1.chat.get.mockResolvedValueOnce({
        data: { name: 'P2P Chat', chat_mode: 'p2p' },
      });

      await triggerMessage(createMessageEvent({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'fs:oc_chat123',
        expect.any(String),
        'P2P Chat',
        'feishu',
        false,
      );
    });
  });

  // --- Media message types ---

  describe('media message types', () => {
    it.each([
      ['image', '[图片]'],
      ['file', '[文件]'],
      ['audio', '[语音]'],
      ['video', '[视频]'],
    ])('stores %s as %s placeholder', async (msgType, placeholder) => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      await triggerMessage(createMessageEvent({ msgType }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_chat123',
        expect.objectContaining({ content: placeholder }),
      );
    });

    it('stores unknown type as bracketed type name', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      await triggerMessage(createMessageEvent({ msgType: 'sticker' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'fs:oc_chat123',
        expect.objectContaining({ content: '[sticker]' }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends text message to chat', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      await channel.sendMessage('fs:oc_chat123', 'Hello Feishu!');

      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { receive_id_type: 'chat_id' },
          data: expect.objectContaining({
            receive_id: 'oc_chat123',
            msg_type: 'text',
            content: JSON.stringify({ text: 'Hello Feishu!' }),
          }),
        }),
      );
    });

    it('strips fs: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      await channel.sendMessage('fs:oc_another456', 'Test');

      expect(currentClient().im.v1.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ receive_id: 'oc_another456' }),
        }),
      );
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      currentClient().im.v1.message.create.mockRejectedValueOnce(new Error('API error'));

      await expect(
        channel.sendMessage('fs:oc_chat123', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);

      // Don't connect
      await channel.sendMessage('fs:oc_chat123', 'No client');
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns fs: JIDs', () => {
      const channel = new FeishuChannel('cli_app123', 'secret_abc', createTestOpts());
      expect(channel.ownsJid('fs:oc_chat123')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new FeishuChannel('cli_app123', 'secret_abc', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new FeishuChannel('cli_app123', 'secret_abc', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = new FeishuChannel('cli_app123', 'secret_abc', createTestOpts());
      expect(channel.ownsJid('dc:1234567890')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('is a no-op (Feishu does not support typing indicators)', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('cli_app123', 'secret_abc', opts);
      await channel.connect();

      // Should not throw
      await expect(channel.setTyping('fs:oc_chat123', true)).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "feishu"', () => {
      const channel = new FeishuChannel('cli_app123', 'secret_abc', createTestOpts());
      expect(channel.name).toBe('feishu');
    });
  });
});
