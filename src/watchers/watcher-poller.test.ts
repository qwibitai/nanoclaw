import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { eventBus } from '../event-bus.js';
import { _initTestDatabase, _closeDatabase } from '../db.js';
import { addWatcher, getWatcher, updateWatcherValue } from './watcher-store.js';
import { pollAllWatchers } from './watcher-poller.js';

const mockEmit = vi.mocked(eventBus.emit);

beforeEach(() => {
  _initTestDatabase();
  mockEmit.mockClear();
});

afterEach(() => {
  _closeDatabase();
});

describe('pollAllWatchers', () => {
  it('calls extract for each enabled watcher and updates lastValue on change', async () => {
    addWatcher({
      url: 'https://example.com/price',
      selector: '.price',
      groupId: 'main',
      intervalMs: 60_000,
    });

    const extract = vi.fn().mockResolvedValue('$42.00');

    const results = await pollAllWatchers(extract);

    expect(results).toHaveLength(1);
    expect(results[0].changed).toBe(true);
    expect(extract).toHaveBeenCalledWith('https://example.com/price', '.price');
  });

  it('skips watchers whose interval has not elapsed since last check', async () => {
    const watcher = addWatcher({
      url: 'https://example.com/price',
      selector: '.price',
      groupId: 'main',
      intervalMs: 60_000,
    });

    // Simulate a recent check by updating the value (which sets checkedAt to now)
    updateWatcherValue(watcher.id, '$40.00');

    const extract = vi.fn().mockResolvedValue('$42.00');

    const results = await pollAllWatchers(extract);

    expect(results).toHaveLength(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it('updates the stored lastValue after a successful extraction', async () => {
    const watcher = addWatcher({
      url: 'https://example.com/status',
      selector: '#status',
      groupId: 'main',
      intervalMs: 60_000,
    });

    const extract = vi.fn().mockResolvedValue('Online');

    await pollAllWatchers(extract);

    const updated = getWatcher(watcher.id);
    expect(updated).toBeDefined();
    expect(updated!.lastValue).toBe('Online');
  });

  it('emits watcher.changed event when value changes', async () => {
    addWatcher({
      url: 'https://example.com/price',
      selector: '.price',
      groupId: 'main',
      intervalMs: 60_000,
    });

    const extract = vi.fn().mockResolvedValue('$42.00');

    await pollAllWatchers(extract);

    expect(mockEmit).toHaveBeenCalledWith(
      'watcher.changed',
      expect.objectContaining({
        type: 'watcher.changed',
        payload: expect.objectContaining({
          newValue: '$42.00',
        }),
      }),
    );
  });

  it('handles extraction errors gracefully without crashing the poll loop', async () => {
    addWatcher({
      url: 'https://fail.com',
      selector: '.fail',
      groupId: 'main',
      intervalMs: 60_000,
    });
    addWatcher({
      url: 'https://success.com',
      selector: '.ok',
      groupId: 'main',
      intervalMs: 60_000,
    });

    const extract = vi.fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce('$42.00');

    const results = await pollAllWatchers(extract);

    expect(results).toHaveLength(2);
    expect(results[0].error).toBe('network timeout');
    expect(results[0].changed).toBe(false);
    expect(results[1].changed).toBe(true);
    expect(results[1].newValue).toBe('$42.00');
  });
});
