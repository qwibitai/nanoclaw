import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLark = vi.hoisted(() => ({
  createMessage: vi.fn().mockResolvedValue(undefined),
  wsStart: vi.fn(),
  wsStop: vi.fn(),
  handlers: {} as Record<string, (data: unknown) => Promise<void>>,
}));

const mockRegistry = vi.hoisted(() => ({
  entries: [] as Array<[string, unknown]>,
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockEventDispatcher {
    register(events: Record<string, (data: unknown) => Promise<void>>) {
      mockLark.handlers = { ...mockLark.handlers, ...events };
      return this;
    }
  }

  class MockWSClient {
    start = mockLark.wsStart;
    stop = mockLark.wsStop;
  }

  class MockClient {
    im = {
      message: {
        create: mockLark.createMessage,
      },
    };
  }

  return {
    default: {
      EventDispatcher: MockEventDispatcher,
      WSClient: MockWSClient,
      Client: MockClient,
    },
  };
});

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn((name: string, factory: unknown) => {
    mockRegistry.entries.push([name, factory]);
  }),
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

import { FeishuChannel } from './feishu.js';
import { readEnvFile } from '../env.js';

interface TestOpts {
  onMessage: ReturnType<typeof vi.fn>;
  onChatMetadata: ReturnType<typeof vi.fn>;
  registeredGroups: () => Record<string, unknown>;
}

function makeOpts(registered: Record<string, unknown> = {}): TestOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => registered,
  };
}

function inboundEvent(overrides: {
  chatId?: string;
  messageId?: string;
  messageType?: string;
  content?: string;
  chatType?: string;
  senderId?: string;
  senderType?: string;
}) {
  return {
    event: {
      sender: {
        sender_type: overrides.senderType ?? 'user',
        sender_id: {
          open_id: overrides.senderId ?? 'ou_user_1',
        },
      },
      message: {
        message_id: overrides.messageId ?? 'msg-1',
        chat_id: overrides.chatId ?? 'oc_123',
        chat_type: overrides.chatType ?? 'group',
        message_type: overrides.messageType ?? 'text',
        content: overrides.content ?? JSON.stringify({ text: 'hello' }),
        create_time: '1700000000000',
      },
    },
  };
}

describe('FeishuChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLark.handlers = {};
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.LARK_APP_ID;
    delete process.env.LARK_APP_SECRET;
    delete process.env.FEISHU_DOMAIN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects and registers message handler', async () => {
    const opts = makeOpts();
    const channel = new FeishuChannel('app-id', 'app-secret', opts as any);

    await channel.connect();

    expect(channel.isConnected()).toBe(true);
    expect(mockLark.wsStart).toHaveBeenCalledTimes(1);
    expect(typeof mockLark.handlers['im.message.receive_v1']).toBe('function');
  });

  it('sends outbound message to chat_id', async () => {
    const opts = makeOpts();
    const channel = new FeishuChannel('app-id', 'app-secret', opts as any);
    await channel.connect();

    await channel.sendMessage('fs:oc_chat_1', 'hello feishu');

    expect(mockLark.createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat_1',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello feishu' }),
      },
    });
  });

  it('stores inbound message for registered chat', async () => {
    const opts = makeOpts({
      'fs:oc_reg_1': {
        name: 'Reg Group',
      },
    });
    const channel = new FeishuChannel('app-id', 'app-secret', opts as any);
    await channel.connect();

    await mockLark.handlers['im.message.receive_v1'](
      inboundEvent({
        chatId: 'oc_reg_1',
        messageId: 'msg-reg-1',
        content: JSON.stringify({ text: '@Andy hi there' }),
      }),
    );

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'fs:oc_reg_1',
      new Date(1700000000000).toISOString(),
      undefined,
      'feishu',
      true,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_reg_1',
      expect.objectContaining({
        id: 'msg-reg-1',
        chat_jid: 'fs:oc_reg_1',
        sender: 'ou_user_1',
        sender_name: 'ou_user_1',
        content: '@Andy hi there',
      }),
    );
  });

  it('does not store inbound message for unregistered chat', async () => {
    const opts = makeOpts();
    const channel = new FeishuChannel('app-id', 'app-secret', opts as any);
    await channel.connect();

    await mockLark.handlers['im.message.receive_v1'](
      inboundEvent({
        chatId: 'oc_unreg_1',
        messageId: 'msg-unreg-1',
        content: JSON.stringify({ text: 'hello' }),
      }),
    );

    expect(opts.onChatMetadata).toHaveBeenCalledTimes(1);
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('handles /chatid command even before registration', async () => {
    const opts = makeOpts();
    const channel = new FeishuChannel('app-id', 'app-secret', opts as any);
    await channel.connect();

    await mockLark.handlers['im.message.receive_v1'](
      inboundEvent({
        chatId: 'oc_chatid_1',
        messageId: 'msg-chatid-1',
        content: JSON.stringify({ text: '/chatid' }),
      }),
    );

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(mockLark.createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chatid_1',
        msg_type: 'text',
        content: JSON.stringify({
          text: 'Chat ID: `fs:oc_chatid_1`\nType: group',
        }),
      },
    });
  });

  it('maps non-text message types to placeholders', async () => {
    const opts = makeOpts({
      'fs:oc_media_1': {
        name: 'Media Group',
      },
    });
    const channel = new FeishuChannel('app-id', 'app-secret', opts as any);
    await channel.connect();

    await mockLark.handlers['im.message.receive_v1'](
      inboundEvent({
        chatId: 'oc_media_1',
        messageId: 'msg-media-1',
        messageType: 'image',
        content: JSON.stringify({ image_key: 'img_123' }),
      }),
    );

    expect(opts.onMessage).toHaveBeenCalledWith(
      'fs:oc_media_1',
      expect.objectContaining({
        content: '[Image]',
      }),
    );
  });

  it('registers channel factory and validates env', () => {
    const readEnvMock = vi.mocked(readEnvFile);

    const entry = mockRegistry.entries.find((call) => call[0] === 'feishu');
    expect(entry).toBeTruthy();
    const factory = entry?.[1] as ((opts: unknown) => unknown) | undefined;
    expect(factory).toBeTypeOf('function');

    const opts = makeOpts();

    readEnvMock.mockReturnValueOnce({});
    expect(factory?.(opts as any)).toBeNull();

    readEnvMock.mockReturnValueOnce({
      FEISHU_APP_ID: 'app-id',
      FEISHU_APP_SECRET: 'app-secret',
    });
    const created = factory?.(opts as any);
    expect(created).toBeInstanceOf(FeishuChannel);
  });
});
