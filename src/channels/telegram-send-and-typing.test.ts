import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.registryMockFactory();
});
vi.mock('../env.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.envMockFactory();
});
vi.mock('../config.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.configMockFactory();
});
vi.mock('../live-location.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.liveLocationMockFactory();
});
vi.mock('../db.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.dbMockFactory();
});
vi.mock('../logger.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.loggerMockFactory();
});
vi.mock('../group-folder.js', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.groupFolderMockFactory();
});
vi.mock('grammy', async () => {
  const m = await import('./telegram-test-mocks.js');
  return m.grammyMockFactory();
});
import { TelegramChannel } from './telegram.js';
import { createTestOpts, currentBot } from './telegram-test-harness.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sendMessage', () => {
  it('sends message via bot API', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.sendMessage('tg:100200300', 'Hello');

    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
      '100200300',
      'Hello',
      { parse_mode: 'Markdown' },
    );
  });

  it('strips tg: prefix from JID', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.sendMessage('tg:-1001234567890', 'Group message');

    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
      '-1001234567890',
      'Group message',
      { parse_mode: 'Markdown' },
    );
  });

  it('splits messages exceeding 4096 characters', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const longText = 'x'.repeat(5000);
    await channel.sendMessage('tg:100200300', longText);

    expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
    expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
      1,
      '100200300',
      'x'.repeat(4096),
      { parse_mode: 'Markdown' },
    );
    expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
      2,
      '100200300',
      'x'.repeat(904),
      { parse_mode: 'Markdown' },
    );
  });

  it('sends exactly one message at 4096 characters', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const exactText = 'y'.repeat(4096);
    await channel.sendMessage('tg:100200300', exactText);

    expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('handles send failure gracefully', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    currentBot().api.sendMessage.mockRejectedValueOnce(
      new Error('Network error'),
    );

    // Should not throw
    await expect(
      channel.sendMessage('tg:100200300', 'Will fail'),
    ).resolves.toBeUndefined();
  });

  it('does nothing when bot is not initialized', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);

    // Don't connect — bot is null
    await channel.sendMessage('tg:100200300', 'No bot');

    // No error, no API call
  });
});

// --- sendPhoto ---

describe('sendPhoto', () => {
  it('sends photo with URL directly', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.sendPhoto(
      'tg:100200300',
      'https://example.com/photo.jpg',
      'A photo',
    );

    expect(currentBot().api.sendPhoto).toHaveBeenCalledWith(
      '100200300',
      'https://example.com/photo.jpg',
      { caption: 'A photo', parse_mode: 'Markdown' },
    );
  });

  it('wraps local file path with InputFile', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.sendPhoto('tg:100200300', '/tmp/photo.jpg');

    const call = currentBot().api.sendPhoto.mock.calls[0];
    expect(call[0]).toBe('100200300');
    // Second arg should be a MockInputFile instance with the path
    expect(call[1]).toEqual(
      expect.objectContaining({ path: '/tmp/photo.jpg' }),
    );
    // No caption — options should be empty
    expect(call[2]).toEqual({});
  });

  it('falls back to text on sendPhoto failure', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    currentBot().api.sendPhoto.mockRejectedValueOnce(
      new Error('Upload failed'),
    );

    await channel.sendPhoto(
      'tg:100200300',
      'https://example.com/big.jpg',
      'Fallback caption',
    );

    // Should have fallen back to sendMessage with caption
    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
      '100200300',
      'Fallback caption',
      { parse_mode: 'Markdown' },
    );
  });

  it('does nothing when bot is not initialized', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);

    // Don't connect — bot is null
    await channel.sendPhoto('tg:100200300', 'https://example.com/photo.jpg');

    // No error, no API call
  });
});

// --- ownsJid ---

describe('ownsJid', () => {
  it('owns tg: JIDs', () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    expect(channel.ownsJid('tg:123456')).toBe(true);
  });

  it('owns tg: JIDs with negative IDs (groups)', () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
  });

  it('does not own WhatsApp group JIDs', () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    expect(channel.ownsJid('12345@g.us')).toBe(false);
  });

  it('does not own WhatsApp DM JIDs', () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
  });

  it('does not own unknown JID formats', () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    expect(channel.ownsJid('random-string')).toBe(false);
  });
});

// --- setTyping ---

describe('setTyping', () => {
  it('sends typing action when isTyping is true', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.setTyping('tg:100200300', true);

    expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
      '100200300',
      'typing',
    );
  });

  it('does nothing when isTyping is false', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await channel.setTyping('tg:100200300', false);

    expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
  });

  it('does nothing when bot is not initialized', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);

    // Don't connect
    await channel.setTyping('tg:100200300', true);

    // No error, no API call
  });

  it('handles typing indicator failure gracefully', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    currentBot().api.sendChatAction.mockRejectedValueOnce(
      new Error('Rate limited'),
    );

    await expect(
      channel.setTyping('tg:100200300', true),
    ).resolves.toBeUndefined();
  });
});

// --- Bot commands ---
