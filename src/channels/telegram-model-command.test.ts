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
import { setGroupModel } from '../db.js';
import { TelegramChannel } from './telegram.js';
import {
  createTestOpts,
  createTextCtx,
  currentBot,
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

describe('/model command', () => {
  it('registers the model command handler', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    expect(currentBot().commandHandlers.has('model')).toBe(true);
  });

  it('/model shows current model and target selection when no args', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/model' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('claude-sonnet-4-20250514'),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Select target'),
      expect.any(Object),
    );
  });

  it('/model shows current model when per-group model is set', async () => {
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => ({
        'tg:100200300': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          model: 'claude-opus-4-20250514',
        },
      })),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/model' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('claude-opus-4-20250514'),
      expect.any(Object),
    );
    // Should NOT show "(default)" when a per-group model is set
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.not.stringContaining('(default)'),
      expect.any(Object),
    );
  });

  it('/model with no args shows target selection keyboard', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/model' },
      reply: vi.fn(),
    };

    await handler(ctx);

    const replyOpts = ctx.reply.mock.calls[0][1];
    expect(replyOpts.reply_markup).toBeDefined();
    const buttons = replyOpts.reply_markup.buttons.flat() as Array<{
      text: string;
      callback_data: string;
    }>;
    expect(buttons).toHaveLength(2);
    expect(buttons[0].text).toBe('This group');
    expect(buttons[0].callback_data).toBe('cfg:tgt:grp');
    expect(buttons[1].text).toBe('Task');
    expect(buttons[1].callback_data).toBe('cfg:tgt:task');
  });

  it('/model <alias> sets model and preserves session', async () => {
    const groups = {
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

    expect(setGroupModel).toHaveBeenCalledWith(
      'tg:100200300',
      'claude-opus-4-20250514',
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('claude-opus-4-20250514'),
      expect.any(Object),
    );
  });

  it('/model <full-id> sets model with full model ID', async () => {
    const groups = {
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
      message: { text: '/model claude-opus-4-20250514' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(setGroupModel).toHaveBeenCalledWith(
      'tg:100200300',
      'claude-opus-4-20250514',
    );
  });

  it('/model reset clears per-group model and preserves session', async () => {
    const groups = {
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

    expect(setGroupModel).toHaveBeenCalledWith('tg:100200300', null);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('default'),
      expect.any(Object),
    );
  });

  it('/model replies error for unregistered chat', async () => {
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => ({})),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 999999 },
      message: { text: '/model' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
    expect(setGroupModel).not.toHaveBeenCalled();
  });

  it('/model is skipped by general message handler', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({ text: '/model opus' });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});
