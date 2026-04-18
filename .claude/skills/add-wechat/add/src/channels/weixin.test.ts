import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeixinChannel } from './weixin.js';

describe('WeixinChannel', () => {
  let channel: WeixinChannel;
  const mockOnMessage = vi.fn();
  const mockOnChatMetadata = vi.fn();
  const mockRegisteredGroups = vi.fn(() => ({}));

  beforeEach(() => {
    channel = new WeixinChannel({
      onMessage: mockOnMessage,
      onChatMetadata: mockOnChatMetadata,
      registeredGroups: mockRegisteredGroups,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('ownsJid', () => {
    it('should return true for wx: prefixed JIDs', () => {
      expect(channel.ownsJid('wx:user123@im.wechat')).toBe(true);
      expect(channel.ownsJid('wx:test')).toBe(true);
    });

    it('should return false for non-wx JIDs', () => {
      expect(channel.ownsJid('tg:123456')).toBe(false);
      expect(channel.ownsJid('123456@g.us')).toBe(false);
      expect(channel.ownsJid('user@example.com')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('should return false when not connected', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('name', () => {
    it('should return weixin as channel name', () => {
      expect(channel.name).toBe('weixin');
    });
  });
});
