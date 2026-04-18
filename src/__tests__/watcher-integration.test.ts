import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/test-store',
  DATA_DIR: '/tmp/test-data',
  ASSISTANT_NAME: 'TestBot',
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { addWatcher, getWatcher } from '../watchers/watcher-store.js';
import { pollAllWatchers } from '../watchers/watcher-poller.js';
import { eventBus } from '../event-bus.js';

const mockEmit = vi.mocked(eventBus.emit);

beforeEach(() => {
  _initTestDatabase();
  mockEmit.mockClear();
});
afterEach(() => _closeDatabase());

describe('Browser Watcher Integration', () => {
  it('full lifecycle: add → first poll detects value → second poll detects change → event emitted twice', async () => {
    // 1. Add a watcher
    const w = addWatcher({
      url: 'https://shop.example.com/product',
      selector: '.current-price',
      groupId: 'telegram_main',
      intervalMs: 1, // 1ms interval so second poll isn't skipped
      label: 'Product price',
    });

    // 2. First poll — should detect initial value (previousValue is null)
    const extract1 = vi.fn().mockResolvedValue('$99.99');
    const results1 = await pollAllWatchers(extract1);

    expect(results1).toHaveLength(1);
    expect(results1[0].changed).toBe(true);
    expect(results1[0].previousValue).toBeNull();
    expect(results1[0].newValue).toBe('$99.99');

    // Verify stored value updated
    const after1 = getWatcher(w.id)!;
    expect(after1.lastValue).toBe('$99.99');

    // 3. Second poll — value changed
    const extract2 = vi.fn().mockResolvedValue('$79.99');
    // Wait 2ms to pass the 1ms interval
    await new Promise((r) => setTimeout(r, 2));
    const results2 = await pollAllWatchers(extract2);

    expect(results2).toHaveLength(1);
    expect(results2[0].changed).toBe(true);
    expect(results2[0].previousValue).toBe('$99.99');
    expect(results2[0].newValue).toBe('$79.99');

    // Verify event bus emitted watcher.changed twice (once per change)
    const watcherEvents = mockEmit.mock.calls.filter(
      ([type]) => type === 'watcher.changed',
    );
    expect(watcherEvents).toHaveLength(2);

    // Verify second event payload
    const secondPayload = watcherEvents[1][1].payload;
    expect(secondPayload.previousValue).toBe('$99.99');
    expect(secondPayload.newValue).toBe('$79.99');
  });

  it('no event emitted when value stays the same', async () => {
    addWatcher({
      url: 'https://shop.example.com/product',
      selector: '.current-price',
      groupId: 'telegram_main',
      intervalMs: 1,
      label: 'Product price',
    });

    // First poll sets baseline
    await pollAllWatchers(vi.fn().mockResolvedValue('$99.99'));
    mockEmit.mockClear();

    // Second poll — same value
    await new Promise((r) => setTimeout(r, 2));
    await pollAllWatchers(vi.fn().mockResolvedValue('$99.99'));

    const watcherEvents = mockEmit.mock.calls.filter(
      ([type]) => type === 'watcher.changed',
    );
    expect(watcherEvents).toHaveLength(0);
  });

  it('extraction error does not crash poll and no event is emitted', async () => {
    addWatcher({
      url: 'https://shop.example.com/product',
      selector: '.current-price',
      groupId: 'telegram_main',
      intervalMs: 60_000,
      label: 'Product price',
    });

    const extract = vi
      .fn()
      .mockRejectedValue(new Error('DNS resolution failed'));
    const results = await pollAllWatchers(extract);

    expect(results).toHaveLength(1);
    expect(results[0].changed).toBe(false);
    expect(results[0].error).toBe('DNS resolution failed');

    const watcherEvents = mockEmit.mock.calls.filter(
      ([type]) => type === 'watcher.changed',
    );
    expect(watcherEvents).toHaveLength(0);
  });
});
