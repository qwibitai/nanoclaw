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

describe('bot commands', () => {
  it('/chatid replies with chat ID and metadata', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('chatid')!;
    const ctx = {
      chat: { id: 100200300, type: 'group' as const },
      from: { first_name: 'Alice' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('tg:100200300'),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
  });

  it('/chatid shows chat type', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('chatid')!;
    const ctx = {
      chat: { id: 555, type: 'private' as const },
      from: { first_name: 'Bob' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('private'),
      expect.any(Object),
    );
  });

  it('/ping replies with bot status', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('ping')!;
    const ctx = { reply: vi.fn() };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
  });
});

// --- /model command ---

describe('/effort command (deprecated)', () => {
  it('registers the effort command', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();

    expect(currentBot().commandHandlers.has('effort')).toBe(true);
  });

  it('/effort shows deprecation message', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();

    const handler = currentBot().commandHandlers.get('effort')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/effort' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('/model'));
  });
});

// --- Channel properties ---

describe('channel properties', () => {
  it('has name "telegram"', () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    expect(channel.name).toBe('telegram');
  });
});

// --- editMessage retry logic (#27) ---
