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
import {
  createTestOpts,
  createTextCtx,
  triggerTextMessage,
} from './telegram-test-harness.js';

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

describe('text message handling', () => {
  it('delivers message for registered group', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({ text: 'Hello everyone' });
    await triggerTextMessage(ctx);

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'tg:100200300',
      expect.any(String),
      'Test Group',
      'telegram',
      true,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        id: '1',
        chat_jid: 'tg:100200300',
        sender: '99001',
        sender_name: 'Alice',
        content: 'Hello everyone',
        is_from_me: false,
      }),
    );
  });

  it('only emits metadata for unregistered chats', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
    await triggerTextMessage(ctx);

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'tg:999999',
      expect.any(String),
      'Test Group',
      'telegram',
      true,
    );
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('skips bot commands (/chatid, /ping, /model, /status, /compact, /clear) but passes other / messages through', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    // Bot commands should be skipped
    const ctx1 = createTextCtx({ text: '/chatid' });
    await triggerTextMessage(ctx1);
    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(opts.onChatMetadata).not.toHaveBeenCalled();

    const ctx2 = createTextCtx({ text: '/ping' });
    await triggerTextMessage(ctx2);
    expect(opts.onMessage).not.toHaveBeenCalled();

    // Non-bot /commands should flow through
    const ctx3 = createTextCtx({ text: '/remote-control' });
    await triggerTextMessage(ctx3);
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({ content: '/remote-control' }),
    );
  });

  it('extracts sender name from first_name', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({ sender_name: 'Bob' }),
    );
  });

  it('falls back to username when first_name missing', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({ text: 'Hi' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.from.first_name = undefined as any;
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({ sender_name: 'alice_user' }),
    );
  });

  it('falls back to user ID when name and username missing', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.from.first_name = undefined as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.from.username = undefined as any;
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({ sender_name: '42' }),
    );
  });

  it('uses sender name as chat name for private chats', async () => {
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => ({
        'tg:100200300': {
          name: 'Private',
          folder: 'private',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      })),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({
      text: 'Hello',
      chatType: 'private',
      firstName: 'Alice',
    });
    await triggerTextMessage(ctx);

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'tg:100200300',
      expect.any(String),
      'Alice', // Private chats use sender name
      'telegram',
      false,
    );
  });

  it('uses chat title as name for group chats', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({
      text: 'Hello',
      chatType: 'supergroup',
      chatTitle: 'Project Team',
    });
    await triggerTextMessage(ctx);

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'tg:100200300',
      expect.any(String),
      'Project Team',
      'telegram',
      true,
    );
  });

  it('converts message.date to ISO timestamp', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
    const ctx = createTextCtx({ text: 'Hello', date: unixTime });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
    );
  });
});

// --- @mention translation ---
