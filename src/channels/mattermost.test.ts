import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MattermostChannel, MattermostChannelOpts } from './mattermost.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('MattermostChannel', () => {
  let channel: MattermostChannel;
  let mockOnMessage: any;
  let mockOnChatMetadata: any;
  let mockRegisteredGroups: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockOnMessage = vi.fn();
    mockOnChatMetadata = vi.fn();
    mockRegisteredGroups = vi.fn(() => ({}));

    const opts: MattermostChannelOpts = {
      onMessage: mockOnMessage,
      onChatMetadata: mockOnChatMetadata,
      registeredGroups: mockRegisteredGroups,
    };

    channel = new MattermostChannel('https://mattermost.example.com', 'test-bot-token', opts);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a channel with correct name', () => {
      expect(channel.name).toBe('mattermost');
    });

    it('should store baseUrl without trailing slash', () => {
      const channel2 = new MattermostChannel('https://mattermost.example.com/', 'token', {
        onMessage: () => {},
        onChatMetadata: () => {},
        registeredGroups: () => ({}),
      });
      expect((channel2 as any).baseUrl).toBe('https://mattermost.example.com');
    });
  });

  describe('ownsJid', () => {
    it('should return true for jids starting with mm:', () => {
      expect(channel.ownsJid('mm:channel123')).toBe(true);
    });

    it('should return false for jids not starting with mm:', () => {
      expect(channel.ownsJid('wa:123456789')).toBe(false);
      expect(channel.ownsJid('tg:123456789')).toBe(false);
      expect(channel.ownsJid('dc:123456789')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('should return false when not connected', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('connect', () => {
    it('should fetch bot user info and start polling', async () => {
      const mockUser = { id: 'bot123', username: 'test-bot' };
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockUser),
      });

      await channel.connect();

      expect(global.fetch).toHaveBeenCalledWith(
        'https://mattermost.example.com/api/v4/users/me',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-bot-token',
          }),
        })
      );
      expect(channel.isConnected()).toBe(true);
    });

    it('should throw error when API call fails', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(channel.connect()).rejects.toThrow('Mattermost API error');
    });
  });

  describe('sendMessage', () => {
    it('should send message to correct channel', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'post123' }),
      });

      await channel.sendMessage('mm:channel123', 'Hello world');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://mattermost.example.com/api/v4/posts',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            channel_id: 'channel123',
            message: 'Hello world',
          }),
        })
      );
    });

    it('should handle errors gracefully', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await channel.sendMessage('mm:channel123', 'Hello');
    });
  });

  describe('disconnect', () => {
    it('should clear poll interval', async () => {
      // First connect to set up
      const mockUser = { id: 'bot123', username: 'test-bot' };
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockUser),
      });
      await channel.connect();

      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('setTyping', () => {
    it('should be a no-op', async () => {
      // Should not throw
      await channel.setTyping('mm:channel123', true);
    });
  });
});
