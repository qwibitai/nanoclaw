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

describe('/status command', () => {
  it('shows system status with usage data', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('status')!;
    const ctx = {
      chat: { id: 100200300 },
      reply: vi.fn(),
    };

    await handler(ctx);

    const replyText = ctx.reply.mock.calls[0][0];
    expect(replyText).toContain('Status: Online');
    expect(replyText).toContain('2h 34m');
    expect(replyText).toContain('Active containers: 1');
    expect(replyText).toContain('Context: 45k/200k');
    expect(replyText).toContain('Compactions: 2');
    expect(replyText).toContain('Weekly usage: 35%');
    expect(replyText).toContain('session-abc1');
  });

  it('shows "no usage data" when no usage available', async () => {
    const opts = createTestOpts({
      getStatus: vi.fn(() => ({
        activeContainers: 0,
        uptimeSeconds: 120,
        sessions: {},
        lastUsage: {},
        compactCount: {},
        lastRateLimit: {},
      })),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('status')!;
    const ctx = {
      chat: { id: 100200300 },
      reply: vi.fn(),
    };

    await handler(ctx);

    const replyText = ctx.reply.mock.calls[0][0];
    expect(replyText).toContain('no usage data');
    expect(replyText).toContain('Compactions: 0');
    expect(replyText).not.toContain('Weekly usage');
    expect(replyText).toContain('Session: none');
  });

  it('replies error for unregistered chat', async () => {
    const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('status')!;
    const ctx = { chat: { id: 999 }, reply: vi.fn() };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
  });

  it('/status is skipped by general message handler', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const ctx = createTextCtx({ text: '/status' });
    await triggerTextMessage(ctx);

    expect(opts.onMessage).not.toHaveBeenCalled();
  });
});

// --- /compact command ---

describe('/compact command', () => {
  it('sends compact via IPC when session is active', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('compact')!;
    const ctx = {
      chat: { id: 100200300 },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(opts.sendIpcMessage).toHaveBeenCalledWith(
      'tg:100200300',
      '/compact',
    );
    expect(ctx.reply).toHaveBeenCalledWith('Compact requested.');
  });

  it('shows error when no active session', async () => {
    const opts = createTestOpts({
      sendIpcMessage: vi.fn(() => false),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('compact')!;
    const ctx = {
      chat: { id: 100200300 },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('No active session to compact.');
  });

  it('replies error for unregistered chat', async () => {
    const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('compact')!;
    const ctx = { chat: { id: 999 }, reply: vi.fn() };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
  });
});

// --- /clear command ---

describe('/clear command', () => {
  it('clears session for registered group', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('clear')!;
    const ctx = {
      chat: { id: 100200300 },
      reply: vi.fn(),
    };

    await handler(ctx);

    expect(opts.clearSession).toHaveBeenCalledWith(
      'test-group',
      'tg:100200300',
    );
    expect(ctx.reply).toHaveBeenCalledWith('Session cleared.');
  });

  it('replies error for unregistered chat', async () => {
    const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    const handler = currentBot().commandHandlers.get('clear')!;
    const ctx = { chat: { id: 999 }, reply: vi.fn() };

    await handler(ctx);

    expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
    expect(opts.clearSession).not.toHaveBeenCalled();
  });
});

// --- /tasks command ---
