import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuChannel } from './feishu.js';

describe('FeishuChannel', () => {
  const mockOpts = {
    appId: 'cli_test',
    appSecret: 'test-secret',
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'feishu:oc_test123': {
        jid: 'feishu:oc_test123',
        name: 'Test Group',
        folder: 'main',
        trigger_pattern: '@Andy',
        added_at: new Date().toISOString(),
        requires_trigger: 0,
      },
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ownsJid', () => {
    it('should return true for feishu: prefixed JIDs', () => {
      const channel = new FeishuChannel(mockOpts);
      expect(channel.ownsJid('feishu:oc_test123')).toBe(true);
      expect(channel.ownsJid('feishu:ou_test456')).toBe(true);
    });

    it('should return false for non-feishu JIDs', () => {
      const channel = new FeishuChannel(mockOpts);
      expect(channel.ownsJid('whatsapp:123@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('should return false before connect', () => {
      const channel = new FeishuChannel(mockOpts);
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('name', () => {
    it('should be "feishu"', () => {
      const channel = new FeishuChannel(mockOpts);
      expect(channel.name).toBe('feishu');
    });
  });
});
