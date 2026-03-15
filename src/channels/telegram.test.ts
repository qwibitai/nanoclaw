import { describe, it, expect, vi, beforeEach } from 'vitest';

import { TelegramChannel } from './telegram.js';
import type { TelegramChannelOpts } from './telegram.js';

// Track all created bot instances for assertions
let lastBotInstance: any = null;

vi.mock('grammy', () => {
  class MockBot {
    api = {
      sendMessage: vi.fn().mockResolvedValue({}),
      sendChatAction: vi.fn().mockResolvedValue(true),
      setWebhook: vi.fn().mockResolvedValue(true),
      deleteWebhook: vi.fn().mockResolvedValue(true),
    };
    botInfo = { username: 'test_bot', id: 123 };
    command = vi.fn();
    on = vi.fn();
    catch = vi.fn();
    start = vi.fn(({ onStart }: any) => {
      onStart({ username: 'test_bot', id: 123 });
    });
    stop = vi.fn();
    init = vi.fn().mockResolvedValue(undefined);

    constructor() {
      lastBotInstance = this;
    }
  }

  return {
    Bot: MockBot,
    Api: vi.fn(),
    webhookCallback: vi.fn(() => vi.fn()),
  };
});

function makeOpts(): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

describe('TelegramChannel', () => {
  beforeEach(() => {
    lastBotInstance = null;
  });

  describe('constructor', () => {
    it('defaults to polling mode when no webhook URL', () => {
      const ch = new TelegramChannel('token123', makeOpts());
      expect(ch.name).toBe('telegram');
    });

    it('enables webhook mode when webhook URL is provided', () => {
      const ch = new TelegramChannel(
        'token123',
        makeOpts(),
        'https://example.com/telegram',
      );
      expect(ch.name).toBe('telegram');
    });
  });

  describe('ownsJid', () => {
    it('returns true for tg: prefixed JIDs', () => {
      const ch = new TelegramChannel('token', makeOpts());
      expect(ch.ownsJid('tg:12345')).toBe(true);
    });

    it('returns false for non-tg JIDs', () => {
      const ch = new TelegramChannel('token', makeOpts());
      expect(ch.ownsJid('wa:12345')).toBe(false);
      expect(ch.ownsJid('slack:C123')).toBe(false);
    });
  });

  describe('polling mode', () => {
    it('connects using bot.start() in polling mode', async () => {
      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      expect(lastBotInstance.api.deleteWebhook).toHaveBeenCalled();
      expect(lastBotInstance.start).toHaveBeenCalled();
      expect(lastBotInstance.init).not.toHaveBeenCalled();
      expect(ch.isConnected()).toBe(true);
    });

    it('stops polling on disconnect', async () => {
      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();
      await ch.disconnect();

      expect(lastBotInstance.stop).toHaveBeenCalled();
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('webhook mode', () => {
    it('connects using bot.init() and setWebhook in webhook mode', async () => {
      const { webhookCallback } = await import('grammy');
      const ch = new TelegramChannel(
        'token123',
        makeOpts(),
        'https://example.com/telegram',
      );
      await ch.connect();

      expect(lastBotInstance.init).toHaveBeenCalled();
      expect(lastBotInstance.start).not.toHaveBeenCalled();
      expect(lastBotInstance.api.setWebhook).toHaveBeenCalledWith(
        'https://example.com/telegram',
        expect.objectContaining({ secret_token: expect.any(String) }),
      );
      expect(webhookCallback).toHaveBeenCalledWith(
        lastBotInstance,
        'http',
        expect.objectContaining({ secretToken: expect.any(String) }),
      );
      expect(ch.isConnected()).toBe(true);

      // Clean up the server
      await ch.disconnect();
    });

    it('deletes webhook and closes server on disconnect', async () => {
      const ch = new TelegramChannel(
        'token123',
        makeOpts(),
        'https://example.com/telegram',
      );
      await ch.connect();
      await ch.disconnect();

      expect(lastBotInstance.api.deleteWebhook).toHaveBeenCalled();
      // bot.stop() should NOT be called in webhook mode
      expect(lastBotInstance.stop).not.toHaveBeenCalled();
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      await ch.sendMessage('tg:12345', 'Hello');

      expect(lastBotInstance.api.sendMessage).toHaveBeenCalledWith(
        '12345',
        'Hello',
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('splits long messages at 4096 char boundary', async () => {
      const ch = new TelegramChannel('token123', makeOpts());
      await ch.connect();

      const longText = 'x'.repeat(5000);
      await ch.sendMessage('tg:12345', longText);

      // Should be called twice: 4096 + 904
      expect(lastBotInstance.api.sendMessage).toHaveBeenCalledTimes(2);
    });
  });
});
