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
  Client: vi.fn(() => ({
    im: {
      v1: { message: { create: sdkRef.messageCreate } },
    },
    contact: {
      v3: { user: { get: sdkRef.userGet } },
    },
    bot: {
      v3: { info: { get: sdkRef.botInfoGet } },
    },
  })),
  WSClient: vi.fn(() => ({
    start: sdkRef.wsStart,
  })),
  EventDispatcher: vi.fn(() => ({
    register: vi.fn(function (this: any, handlers: Record<string, Function>) {
      sdkRef.eventHandlers = handlers;
      return this;
    }),
  })),
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
});
