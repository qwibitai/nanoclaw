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
import {
  setGroupEffort,
  setGroupModel,
  setGroupThinkingBudget,
} from '../db.js';
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

describe('cfg: callback queries', () => {
  function findCfgCallbackHandler() {
    const bot = currentBot();
    const entry = bot.callbackQueryHandlers.find(
      (h: { pattern: RegExp | string }) =>
        h.pattern instanceof RegExp && h.pattern.source === /^cfg:/.source,
    );
    return entry?.handler;
  }

  it('registers the cfg: callback handler', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();

    expect(findCfgCallbackHandler()).toBeDefined();
  });

  it('cfg:mod:grp:<alias> sets the model and advances to effort', async () => {
    const groups: Record<
      string,
      {
        name: string;
        folder: string;
        trigger: string;
        added_at: string;
        model?: string;
      }
    > = {
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

    const handler = findCfgCallbackHandler()!;
    const ctx = {
      callbackQuery: { data: 'cfg:mod:grp:opus' },
      chat: { id: 100200300 },
      editMessageText: vi.fn(),
      answerCallbackQuery: vi.fn(),
    };

    await handler(ctx);

    expect(setGroupModel).toHaveBeenCalledWith(
      'tg:100200300',
      'claude-opus-4-20250514',
    );
    expect(groups['tg:100200300'].model).toBe('claude-opus-4-20250514');
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Effort'),
      expect.any(Object),
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('cfg:mod:grp:reset clears the model', async () => {
    const groups: Record<
      string,
      {
        name: string;
        folder: string;
        trigger: string;
        added_at: string;
        model?: string;
      }
    > = {
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

    const handler = findCfgCallbackHandler()!;
    const ctx = {
      callbackQuery: { data: 'cfg:mod:grp:reset' },
      chat: { id: 100200300 },
      editMessageText: vi.fn(),
      answerCallbackQuery: vi.fn(),
    };

    await handler(ctx);

    expect(setGroupModel).toHaveBeenCalledWith('tg:100200300', null);
    expect(groups['tg:100200300'].model).toBeUndefined();
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Effort'),
      expect.any(Object),
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('cfg: callback for unregistered chat replies error', async () => {
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => ({})),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = findCfgCallbackHandler()!;
    const ctx = {
      callbackQuery: { data: 'cfg:mod:grp:opus' },
      chat: { id: 999999 },
      editMessageText: vi.fn(),
      answerCallbackQuery: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith('Not registered.');
    expect(setGroupModel).not.toHaveBeenCalled();
  });

  it('cfg:eff:grp:<level> sets group effort and advances to thinking budget', async () => {
    const groups: Record<
      string,
      {
        name: string;
        folder: string;
        trigger: string;
        added_at: string;
        effort?: string;
      }
    > = {
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

    const handler = findCfgCallbackHandler()!;
    const ctx = {
      callbackQuery: { data: 'cfg:eff:grp:high' },
      chat: { id: 100200300 },
      editMessageText: vi.fn(),
      answerCallbackQuery: vi.fn(),
    };

    await handler(ctx);

    expect(setGroupEffort).toHaveBeenCalledWith('tg:100200300', 'high');
    expect(groups['tg:100200300'].effort).toBe('high');
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Thinking budget'),
      expect.any(Object),
    );
  });

  it('cfg:tb:grp:<preset> sets thinking budget and completes', async () => {
    const groups: Record<
      string,
      {
        name: string;
        folder: string;
        trigger: string;
        added_at: string;
        thinking_budget?: string;
      }
    > = {
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

    const handler = findCfgCallbackHandler()!;
    const ctx = {
      callbackQuery: { data: 'cfg:tb:grp:adaptive' },
      chat: { id: 100200300 },
      editMessageText: vi.fn(),
      answerCallbackQuery: vi.fn(),
    };

    await handler(ctx);

    expect(setGroupThinkingBudget).toHaveBeenCalledWith(
      'tg:100200300',
      'adaptive',
    );
    expect(groups['tg:100200300'].thinking_budget).toBe('adaptive');
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      'Configuration complete.',
      expect.any(Object),
    );
  });

  it('cfg:tgt:task shows task picker', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();

    const handler = findCfgCallbackHandler()!;
    const ctx = {
      callbackQuery: { data: 'cfg:tgt:task' },
      chat: { id: 100200300 },
      editMessageText: vi.fn(),
      answerCallbackQuery: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      'Select a task:',
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });
});
