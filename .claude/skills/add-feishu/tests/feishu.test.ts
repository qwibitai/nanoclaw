import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel } from '../channels/feishu.js';

// Mock the @larksuiteoapi/node-sdk
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(() => ({
    contact: {
      user: {
        get: vi.fn().mockResolvedValue({
          data: { user: { name: 'Test User', open_id: 'ou_test123' } },
        }),
      },
    },
  })),
  WSClient: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
  })),
  EventDispatcher: vi.fn().mockImplementation(() => ({
    register: vi.fn(),
  })),
  LoggerLevel: { info: 'info' },
}));

// Mock env module
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockResolvedValue({
    FEISHU_APP_ID: 'test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
  }),
}));

describe('FeishuChannel', () => {
  let channel: FeishuChannel;
  let mockOnMessage: ReturnType<typeof vi.fn>;
  let mockOnChatMetadata: ReturnType<typeof vi.fn>;
  let mockRegisteredGroups: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnMessage = vi.fn();
    mockOnChatMetadata = vi.fn();
    mockRegisteredGroups = vi.fn().mockReturnValue({});

    channel = new FeishuChannel({
      onMessage: mockOnMessage,
      onChatMetadata: mockOnChatMetadata,
      registeredGroups: mockRegisteredGroups,
    });
  });

  it('should have name "feishu"', () => {
    expect(channel.name).toBe('feishu');
  });

  it('should own jids starting with ou_, oc_, or cli_', () => {
    expect(channel.ownsJid('ou_1234567890abcdef')).toBe(true);
    expect(channel.ownsJid('oc_1234567890abcdef')).toBe(true);
    expect(channel.ownsJid('cli_1234567890abcdef')).toBe(true);
    expect(channel.ownsJid('other_1234567890abcdef')).toBe(false);
  });

  it('should not be connected initially', () => {
    expect(channel.isConnected()).toBe(false);
  });
});
