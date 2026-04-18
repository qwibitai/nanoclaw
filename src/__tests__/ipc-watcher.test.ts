import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/test-store',
  DATA_DIR: '/tmp/test-data',
  ASSISTANT_NAME: 'TestBot',
  GROUPS_DIR: '/tmp/test-groups',
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { listAllEnabledWatchers } from '../watchers/watcher-store.js';
import { handleWatchPageIpc } from '../ipc.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('watch_page IPC handler', () => {
  it('creates a watcher from IPC task data', () => {
    const taskData = {
      type: 'watch_page',
      url: 'https://example.com/status',
      selector: '.status-badge',
      label: 'Service status',
      intervalMs: 120000,
    };

    const result = handleWatchPageIpc(taskData, 'telegram_main');

    expect(result.success).toBe(true);
    expect(result.watcherId).toMatch(/^watcher-/);

    const watchers = listAllEnabledWatchers();
    expect(watchers).toHaveLength(1);
    expect(watchers[0].url).toBe('https://example.com/status');
    expect(watchers[0].groupId).toBe('telegram_main');
  });

  it('uses default intervalMs when not provided', () => {
    const taskData = {
      type: 'watch_page',
      url: 'https://example.com',
      selector: '.price',
      label: 'Price tracker',
    };

    const result = handleWatchPageIpc(taskData, 'telegram_main');
    expect(result.success).toBe(true);

    const watchers = listAllEnabledWatchers();
    expect(watchers[0].intervalMs).toBe(300000); // 5 min default
  });

  it('rejects missing url or selector', () => {
    const result1 = handleWatchPageIpc(
      { type: 'watch_page', selector: '.x', label: 'test' },
      'telegram_main',
    );
    expect(result1.success).toBe(false);
    expect(result1.error).toContain('url');

    const result2 = handleWatchPageIpc(
      { type: 'watch_page', url: 'https://x.com', label: 'test' },
      'telegram_main',
    );
    expect(result2.success).toBe(false);
    expect(result2.error).toContain('selector');
  });
});
