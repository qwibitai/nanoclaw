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

describe('@mention translation', () => {
  it('translates @bot_username mention to trigger format', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({
      text: '@andy_ai_bot what time is it?',
      entities: [{ type: 'mention', offset: 0, length: 12 }],
    });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: '@Andy @andy_ai_bot what time is it?',
      }),
    );
  });

  it('does not translate if message already matches trigger', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({
      text: '@Andy @andy_ai_bot hello',
      entities: [{ type: 'mention', offset: 6, length: 12 }],
    });
    await triggerTextMessage(ctx);

    // Should NOT double-prepend — already starts with @Andy
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: '@Andy @andy_ai_bot hello',
      }),
    );
  });

  it('does not translate mentions of other bots', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({
      text: '@some_other_bot hi',
      entities: [{ type: 'mention', offset: 0, length: 15 }],
    });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: '@some_other_bot hi', // No translation
      }),
    );
  });

  it('handles mention in middle of message', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({
      text: 'hey @andy_ai_bot check this',
      entities: [{ type: 'mention', offset: 4, length: 12 }],
    });
    await triggerTextMessage(ctx);

    // Bot is mentioned, message doesn't match trigger → prepend trigger
    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: '@Andy hey @andy_ai_bot check this',
      }),
    );
  });

  it('handles message with no entities', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({ text: 'plain message' });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: 'plain message',
      }),
    );
  });

  it('ignores non-mention entities', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({
      text: 'check https://example.com',
      entities: [{ type: 'url', offset: 6, length: 19 }],
    });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:100200300',
      expect.objectContaining({
        content: 'check https://example.com',
      }),
    );
  });
});

// --- Reply context ---
