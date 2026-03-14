import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock @larksuiteoapi/node-sdk before importing the channel
const mockCreate = vi.fn().mockResolvedValue({ data: { message_id: 'msg_1' } });
const mockImageCreate = vi.fn().mockResolvedValue({ image_key: 'img_v3_test_key' });
const mockStart = vi.fn();

// Mock readEnvFile so tests don't read the real .env file
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({}),
}));

// Mock fs for image file operations
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(true),
      statSync: vi.fn().mockReturnValue({ size: 1024 }),
      createReadStream: vi.fn().mockReturnValue({ pipe: vi.fn(), on: vi.fn() }),
    },
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  // Must use function() (not arrow) so they work with `new`
  function MockClient() {
    return {
      im: {
        message: {
          create: mockCreate,
        },
        image: {
          create: mockImageCreate,
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
import fs from 'fs';
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
    mockImageCreate.mockClear();
    mockStart.mockClear();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.createReadStream).mockReturnValue({ pipe: vi.fn(), on: vi.fn() } as unknown as ReturnType<typeof fs.createReadStream>);
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

  it('sendMessage with [IMAGE:] tag uploads and sends image', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.sendMessage(
      'fs:oc_abc123',
      'Check this chart [IMAGE:/tmp/chart.png] done',
    );

    // Should upload image via ReadStream
    expect(mockImageCreate).toHaveBeenCalledWith({
      data: {
        image_type: 'message',
        image: expect.objectContaining({ pipe: expect.any(Function) }),
      },
    });

    // Should send 3 messages: text before, image, text after
    expect(mockCreate).toHaveBeenCalledTimes(3);

    // First call: text before image
    expect(mockCreate).toHaveBeenNthCalledWith(1, {
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_abc123',
        msg_type: 'text',
        content: JSON.stringify({ text: 'Check this chart' }),
      },
    });

    // Second call: image message
    expect(mockCreate).toHaveBeenNthCalledWith(2, {
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_abc123',
        msg_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_test_key' }),
      },
    });

    // Third call: text after image
    expect(mockCreate).toHaveBeenNthCalledWith(3, {
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_abc123',
        msg_type: 'text',
        content: JSON.stringify({ text: 'done' }),
      },
    });
  });

  it('sendMessage with image-only text sends just the image', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.sendMessage('fs:oc_abc123', '[IMAGE:/tmp/photo.jpg]');

    expect(mockImageCreate).toHaveBeenCalledTimes(1);
    // Only image message, no text messages
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_abc123',
        msg_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_test_key' }),
      },
    });
  });

  it('sendMessage falls back to text when image file not found', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    vi.mocked(fs.existsSync).mockReturnValue(false);

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.sendMessage('fs:oc_abc123', '[IMAGE:/tmp/missing.png]');

    // Should NOT attempt upload
    expect(mockImageCreate).not.toHaveBeenCalled();

    // Should send fallback text
    expect(mockCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_abc123',
        msg_type: 'text',
        content: JSON.stringify({ text: '[Image not found: /tmp/missing.png]' }),
      },
    });
  });

  it('sendMessage falls back to text when image too large', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    vi.mocked(fs.statSync).mockReturnValue({
      size: 20 * 1024 * 1024,
    } as ReturnType<typeof fs.statSync>);

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.sendMessage('fs:oc_abc123', '[IMAGE:/tmp/huge.png]');

    expect(mockImageCreate).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_abc123',
        msg_type: 'text',
        content: JSON.stringify({
          text: '[Image too large or empty: /tmp/huge.png]',
        }),
      },
    });
  });

  it('sendMessage falls back to text when image upload fails', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    mockImageCreate.mockResolvedValueOnce({ image_key: undefined });

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.sendMessage('fs:oc_abc123', '[IMAGE:/tmp/bad.png]');

    expect(mockImageCreate).toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_abc123',
        msg_type: 'text',
        content: JSON.stringify({ text: '[Image upload failed: /tmp/bad.png]' }),
      },
    });
  });

  it('sendMessage handles multiple images in one message', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.sendMessage(
      'fs:oc_abc123',
      '[IMAGE:/tmp/a.png] [IMAGE:/tmp/b.jpg]',
    );

    // Two images uploaded
    expect(mockImageCreate).toHaveBeenCalledTimes(2);
    // Two image messages sent (no text between them after trim)
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('plain text without image tags works unchanged', async () => {
    process.env.FEISHU_APP_ID = 'cli_test123';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const channel = getChannelFactory('feishu')!(makeOpts());
    await channel!.sendMessage('fs:oc_abc123', 'No images here');

    expect(mockImageCreate).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_abc123',
        msg_type: 'text',
        content: JSON.stringify({ text: 'No images here' }),
      },
    });
  });
});
