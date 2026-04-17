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
import { updateTask } from '../db.js';
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

describe('/tasks command', () => {
  it('lists tasks for registered group', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('tasks')!;
    const ctx = {
      chat: { id: 100200300 },
      reply: vi.fn(),
    };

    await handler(ctx);

    const replyText = ctx.reply.mock.calls[0][0];
    expect(replyText).toContain('task-123');
    expect(replyText).toContain('task-456');
    expect(replyText).toContain('claude-haiku-4-20250514');
    expect(replyText).toContain('(default)');
    expect(replyText).toContain('Last:');
    expect(replyText).toContain('Next:');
    expect(replyText).toContain('Effort:');
    expect(replyText).toContain('Thinking:');
  });

  it('shows empty message when no tasks', async () => {
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => ({
        'tg:100200300': {
          name: 'Empty Group',
          folder: 'empty-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      })),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('tasks')!;
    const ctx = { chat: { id: 100200300 }, reply: vi.fn() };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('No tasks for this group.');
  });

  it('replies error for unregistered chat', async () => {
    const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('tasks')!;
    const ctx = { chat: { id: 999 }, reply: vi.fn() };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
  });
});

// --- /model task subcommand ---

describe('/model task subcommand', () => {
  it('sets model for a task', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/model task task-123 haiku' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(updateTask).toHaveBeenCalledWith('task-123', {
      model: 'claude-haiku-4-20250514',
    });
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('claude-haiku-4-20250514'),
      expect.any(Object),
    );
  });

  it('resets task model', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/model task task-123 reset' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(updateTask).toHaveBeenCalledWith('task-123', { model: null });
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('reset to default'),
      expect.any(Object),
    );
  });

  it('shows error for unknown task', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/model task nonexistent haiku' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
      expect.any(Object),
    );
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('shows usage when args missing', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('model')!;
    const ctx = {
      chat: { id: 100200300 },
      message: { text: '/model task' },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Usage'),
      expect.any(Object),
    );
  });
});

// --- /effort command (deprecated) ---
