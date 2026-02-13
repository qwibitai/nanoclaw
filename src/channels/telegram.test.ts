import { afterEach, describe, expect, it, vi } from 'vitest';

import { TelegramChannel } from './telegram.js';

function createOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

describe('TelegramChannel', () => {
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('rejects connect without TELEGRAM_BOT_TOKEN', async () => {
    const channel = new TelegramChannel(createOpts());
    await expect(channel.connect()).rejects.toThrow(
      'TELEGRAM_BOT_TOKEN is required',
    );
  });

  it('owns numeric Telegram chat IDs', () => {
    const channel = new TelegramChannel(createOpts());
    expect(channel.ownsJid('123456')).toBe(true);
    expect(channel.ownsJid('-1001234567890')).toBe(true);
    expect(channel.ownsJid('abc123')).toBe(false);
  });

  it('infers negative IDs as group chats', () => {
    const channel = new TelegramChannel(createOpts());
    expect(channel.isGroupChat('-1001234567890')).toBe(true);
    expect(channel.isGroupChat('123456')).toBe(false);
  });

  it('authorizes inbound messages against canonical registered IDs', async () => {
    const opts = {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: vi.fn(() => ({
        'telegram://-1001234567890': {
          name: 'tg-group',
          folder: 'tg-group',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      })),
    };
    const channel = new TelegramChannel(opts);

    await (channel as any).handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        text: 'hello',
        from: { id: 42, first_name: 'Alice' },
        chat: { id: -1001234567890, type: 'supergroup', title: 'TG' },
      },
    });

    expect(opts.onMessage).toHaveBeenCalledWith(
      '-1001234567890',
      expect.objectContaining({ content: 'hello' }),
    );
  });
});
