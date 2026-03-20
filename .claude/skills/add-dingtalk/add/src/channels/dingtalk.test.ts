import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DingTalkChannel } from './dingtalk.js';

describe('DingTalkChannel', () => {
  const mockOpts = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  };

  const clientId = 'test-client-id';
  const clientSecret = 'test-client-secret';

  describe('constructor', () => {
    it('should create a channel with correct name', () => {
      const channel = new DingTalkChannel(clientId, clientSecret, mockOpts);
      expect(channel.name).toBe('dingtalk');
    });

    it('should store credentials and opts', () => {
      const channel = new DingTalkChannel(clientId, clientSecret, mockOpts);
      expect(channel['clientId']).toBe(clientId);
      expect(channel['clientSecret']).toBe(clientSecret);
      expect(channel['opts']).toBe(mockOpts);
    });
  });

  describe('isConnected', () => {
    it('should return false when not connected', () => {
      const channel = new DingTalkChannel(clientId, clientSecret, mockOpts);
      expect(channel.isConnected()).toBe(false);
    });

    it('should return true after connect (mocked)', () => {
      const channel = new DingTalkChannel(clientId, clientSecret, mockOpts);
      // After connect() would set client
      channel['client'] = {} as any;
      expect(channel.isConnected()).toBe(true);
    });
  });

  describe('ownsJid', () => {
    it('should return true for dingtalk: prefixed jids', () => {
      const channel = new DingTalkChannel(clientId, clientSecret, mockOpts);
      expect(channel.ownsJid('dingtalk:abc123')).toBe(true);
      expect(channel.ownsJid('dingtalk:123456789')).toBe(true);
    });

    it('should return false for other jids', () => {
      const channel = new DingTalkChannel(clientId, clientSecret, mockOpts);
      expect(channel.ownsJid('telegram:123')).toBe(false);
      expect(channel.ownsJid('slack:abc')).toBe(false);
      expect(channel.ownsJid('whatsapp:123')).toBe(false);
    });
  });

  describe('setTyping', () => {
    it('should be a no-op (DingTalk does not support typing indicators)', async () => {
      const channel = new DingTalkChannel(clientId, clientSecret, mockOpts);
      await expect(channel.setTyping('dingtalk:123', true)).resolves.toBeUndefined();
    });
  });

  describe('disconnect', () => {
    it('should clear client and session webhooks', async () => {
      const channel = new DingTalkChannel(clientId, clientSecret, mockOpts);
      const mockClient = {
        disconnect: vi.fn(),
      };
      channel['client'] = mockClient as any;
      channel['sessionWebhooks'].set('conv1', 'webhook1');

      await channel.disconnect();

      expect(mockClient.disconnect).toHaveBeenCalled();
      expect(channel['client']).toBeNull();
      expect(channel['sessionWebhooks'].size).toBe(0);
    });
  });

  describe('sendMessage', () => {
    it('should do nothing if no sessionWebhook stored', async () => {
      const channel = new DingTalkChannel(clientId, clientSecret, mockOpts);
      await channel.sendMessage('dingtalk:unknown', 'test message');
      // Should not throw, just log warning
      expect(mockOpts.onMessage).not.toHaveBeenCalled();
    });

    it('should do nothing if client not initialized', async () => {
      const channel = new DingTalkChannel(clientId, clientSecret, mockOpts);
      channel['sessionWebhooks'].set('conv1', 'webhook1');
      await channel.sendMessage('dingtalk:conv1', 'test message');
      // Should not throw, just log warning
    });
  });
});
