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
import { RegisteredGroup } from '../types.js';
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

describe('pendingModelNotice', () => {
  it('/model <alias> sets pendingModelNotice when model changes', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    };
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => groups),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/model opus' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(groups['tg:100200300'].pendingModelNotice).toContain(
      'model has switched from',
    );
    expect(groups['tg:100200300'].pendingModelNotice).toContain(
      'claude-opus-4-20250514',
    );
  });

  it('/model does not set notice when switching to same model', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        model: 'claude-opus-4-20250514',
      },
    };
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => groups),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/model opus' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(groups['tg:100200300'].pendingModelNotice).toBeUndefined();
  });

  it('/model reset sets notice when model was non-default', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        model: 'claude-opus-4-20250514',
      },
    };
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => groups),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/model reset' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(groups['tg:100200300'].pendingModelNotice).toContain(
      'model has switched from claude-opus-4-20250514',
    );
  });

  it('callback cfg:mod:grp sets pendingModelNotice', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    };
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => groups),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const entry = currentBot().callbackQueryHandlers.find(
      (h: { pattern: RegExp | string }) =>
        h.pattern instanceof RegExp && h.pattern.source === /^cfg:/.source,
    );
    const handler = entry!.handler;
    const ctx = {
      callbackQuery: { data: 'cfg:mod:grp:opus' },
      chat: { id: 100200300 },
      editMessageText: vi.fn(),
      answerCallbackQuery: vi.fn(),
    };

    await handler(ctx);

    expect(groups['tg:100200300'].pendingModelNotice).toContain(
      'model has switched from',
    );
  });

  it('callback cfg:mod:grp:reset sets pendingModelNotice when model was non-default', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        model: 'claude-opus-4-20250514',
      },
    };
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => groups),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const entry = currentBot().callbackQueryHandlers.find(
      (h: { pattern: RegExp | string }) =>
        h.pattern instanceof RegExp && h.pattern.source === /^cfg:/.source,
    );
    const handler = entry!.handler;
    const ctx = {
      callbackQuery: { data: 'cfg:mod:grp:reset' },
      chat: { id: 100200300 },
      editMessageText: vi.fn(),
      answerCallbackQuery: vi.fn(),
    };

    await handler(ctx);

    expect(groups['tg:100200300'].pendingModelNotice).toContain(
      'model has switched from claude-opus-4-20250514',
    );
  });
});
