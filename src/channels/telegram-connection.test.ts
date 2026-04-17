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

describe('TelegramChannel — connection lifecycle', () => {
  it('resolves connect() when bot starts', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
  });

  it('registers command and message handlers on connect', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    expect(currentBot().commandHandlers.has('chatid')).toBe(true);
    expect(currentBot().commandHandlers.has('ping')).toBe(true);
    expect(currentBot().commandHandlers.has('model')).toBe(true);
    expect(currentBot().commandHandlers.has('effort')).toBe(true);
    expect(currentBot().commandHandlers.has('status')).toBe(true);
    expect(currentBot().commandHandlers.has('compact')).toBe(true);
    expect(currentBot().commandHandlers.has('clear')).toBe(true);
    expect(currentBot().commandHandlers.has('tasks')).toBe(true);
    expect(currentBot().api.setMyCommands).toHaveBeenCalledWith([
      { command: 'chatid', description: 'Show chat ID for registration' },
      { command: 'ping', description: 'Check bot status' },
      {
        command: 'model',
        description: 'Configure model, effort, and thinking',
      },
      { command: 'status', description: 'Show system status' },
      { command: 'compact', description: 'Compact conversation context' },
      { command: 'clear', description: 'Clear conversation session' },
      { command: 'tasks', description: 'List scheduled tasks' },
    ]);
    expect(currentBot().api.deleteMyCommands).toHaveBeenCalledTimes(3);
    expect(currentBot().filterHandlers.has('message:text')).toBe(true);
    expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
    expect(currentBot().filterHandlers.has('message:video')).toBe(true);
    expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
    expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
    expect(currentBot().filterHandlers.has('message:document')).toBe(true);
    expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
    expect(currentBot().filterHandlers.has('message:location')).toBe(true);
    expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
  });

  it('registers error handler on connect', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();
    expect(currentBot().errorHandler).not.toBeNull();
  });

  it('disconnects cleanly', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();
    expect(channel.isConnected()).toBe(true);

    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('isConnected() returns false before connect', () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    expect(channel.isConnected()).toBe(false);
  });
});
