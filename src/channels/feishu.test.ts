import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock @larksuiteoapi/node-sdk before importing the channel
const mockCreate = vi.fn().mockResolvedValue({ data: { message_id: 'msg_1' } });
const mockStart = vi.fn();

vi.mock('@larksuiteoapi/node-sdk', () => {
  // Must use function() (not arrow) so they work with `new`
  function MockClient() {
    return {
      im: {
        message: {
          create: mockCreate,
        },
      },
    };
  }
  function MockWSClient() {
    return { start: mockStart };
  }
  function MockEventDispatcher() {
    return { register: vi.fn().mockReturnThis() };
  }
  return {
    Client: MockClient,
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
    Domain: {
      Feishu: 'https://open.feishu.cn',
      Lark: 'https://open.larksuite.com',
    },
    AppType: { SelfBuild: 0 },
    LoggerLevel: { warn: 2, info: 1 },
  };
});

// Import after mock — feishu.ts self-registers via the barrel-style import
import './feishu.js';
import { getChannelFactory } from './registry.js';

function makeOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  };
}

describe('feishu channel', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    mockCreate.mockClear();
    mockStart.mockClear();
  });

  it('factory returns null when credentials missing', () => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;

    const factory = getChannelFactory('feishu');
    expect(factory).toBeDefined();
    expect(factory!(makeOpts())).toBeNull();
  });

  it('factory returns channel when credentials are set', () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const factory = getChannelFactory('feishu');
    const channel = factory!(makeOpts());

    expect(channel).not.toBeNull();
    expect(channel!.name).toBe('feishu');
  });

  it('ownsJid returns true for fs: prefix', () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const channel = getChannelFactory('feishu')!(makeOpts());

    expect(channel!.ownsJid('fs:oc_abc123')).toBe(true);
    expect(channel!.ownsJid('tg:12345')).toBe(false);
    expect(channel!.ownsJid('whatsapp:12345')).toBe(false);
  });

  it('connect starts WebSocket client', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.connect();

    expect(mockStart).toHaveBeenCalled();
    expect(channel!.isConnected()).toBe(true);
  });

  it('sendMessage calls Lark API with correct params', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.sendMessage('fs:oc_abc123', 'Hello from NanoClaw');

    expect(mockCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_abc123',
        msg_type: 'text',
        content: JSON.stringify({ text: 'Hello from NanoClaw' }),
      },
    });
  });

  it('sendMessage resolves open_id type for ou_ prefix', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.sendMessage('fs:ou_user123', 'DM test');

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: 'open_id' },
      }),
    );
  });

  it('disconnect sets connected to false', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.connect();
    expect(channel!.isConnected()).toBe(true);

    await channel!.disconnect();
    expect(channel!.isConnected()).toBe(false);
  });
});
