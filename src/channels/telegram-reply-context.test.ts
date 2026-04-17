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

describe('reply context', () => {
  it('extracts reply_to fields when replying to a text message', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({
      text: 'Yes, on my way!',
      reply_to_message: {
        message_id: 42,
        text: 'Are you coming tonight?',
        from: { id: 777, first_name: 'Bob', username: 'bob_user' },
      },
    });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: 'Yes, on my way!',
        reply_to_message_id: '42',
        reply_to_message_content: 'Are you coming tonight?',
        reply_to_sender_name: 'Bob',
      }),
    );
  });

  it('uses caption when reply has no text (media reply)', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({
      text: 'Nice photo!',
      reply_to_message: {
        message_id: 50,
        caption: 'Check this out',
        from: { id: 888, first_name: 'Carol' },
      },
    });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        reply_to_message_content: 'Check this out',
      }),
    );
  });

  it('falls back to Unknown when reply sender has no from', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({
      text: 'Interesting',
      reply_to_message: {
        message_id: 60,
        text: 'Channel post',
      },
    });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        reply_to_message_id: '60',
        reply_to_sender_name: 'Unknown',
      }),
    );
  });

  it('does not set reply fields when no reply_to_message', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({ text: 'Just a normal message' });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        reply_to_message_id: undefined,
        reply_to_message_content: undefined,
        reply_to_sender_name: undefined,
      }),
    );
  });
});

// --- Non-text messages ---
