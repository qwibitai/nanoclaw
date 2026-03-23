import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MattermostChannel } from './mattermost.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeMockOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({}),
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

describe('MattermostChannel', () => {
  let channel: MattermostChannel;
  let opts: ReturnType<typeof makeMockOpts>;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = makeMockOpts();
    channel = new MattermostChannel(
      'https://mm.example.com',
      'test-token',
      opts,
    );
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  describe('connect', () => {
    it('authenticates and starts polling', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot123', username: 'testbot' }),
      );

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://mm.example.com/api/v4/users/me',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    });

    it('throws on auth failure', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ message: 'Unauthorized' }, 401),
      );

      await expect(channel.connect()).rejects.toThrow(
        'Mattermost API error: 401',
      );
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot123', username: 'testbot' }),
      );
      await channel.connect();
      mockFetch.mockClear();
    });

    it('sends a message to the correct channel', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'post1' }));

      await channel.sendMessage('mm:channel123', 'Hello!');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://mm.example.com/api/v4/posts',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            channel_id: 'channel123',
            message: 'Hello!',
          }),
        }),
      );
    });

    it('splits long messages', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'post1' }));

      const longMessage = 'x'.repeat(20000);
      await channel.sendMessage('mm:channel123', longMessage);

      // Should be split into 2 messages (16383 + 3617)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('ownsJid', () => {
    it('owns mm: prefixed JIDs', () => {
      expect(channel.ownsJid('mm:channel123')).toBe(true);
    });

    it('does not own other JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('stops polling and clears state', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot123', username: 'testbot' }),
      );
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('setTyping', () => {
    it('is a no-op', async () => {
      // Should not throw
      await channel.setTyping('mm:channel123', true);
      await channel.setTyping('mm:channel123', false);
    });
  });
});
