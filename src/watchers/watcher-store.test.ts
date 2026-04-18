import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/test-store',
  DATA_DIR: '/tmp/test-data',
  ASSISTANT_NAME: 'TestBot',
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import {
  addWatcher,
  getWatcher,
  listWatchers,
  listAllEnabledWatchers,
  updateWatcherValue,
  removeWatcher,
} from './watcher-store.js';

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  _closeDatabase();
});

describe('Watcher Store', () => {
  it('addWatcher inserts and returns with generated id', () => {
    const watcher = addWatcher({
      url: 'https://example.com/price',
      selector: '.price-value',
      groupId: 'main',
      intervalMs: 30000,
      label: 'Price tracker',
    });

    expect(watcher.id).toMatch(/^watcher-[a-f0-9]{8}$/);
    expect(watcher.url).toBe('https://example.com/price');
    expect(watcher.selector).toBe('.price-value');
    expect(watcher.groupId).toBe('main');
    expect(watcher.intervalMs).toBe(30000);
    expect(watcher.label).toBe('Price tracker');
    expect(watcher.lastValue).toBeNull();
    expect(watcher.checkedAt).toBeNull();
    expect(watcher.enabled).toBe(true);
    expect(watcher.createdAt).toBeGreaterThan(0);
  });

  it('getWatcher retrieves by id', () => {
    const created = addWatcher({
      url: 'https://example.com',
      selector: '#status',
      groupId: 'main',
    });

    const fetched = getWatcher(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.url).toBe('https://example.com');
    expect(fetched!.selector).toBe('#status');
    expect(fetched!.groupId).toBe('main');
    expect(fetched!.intervalMs).toBe(60000); // default
    expect(fetched!.label).toBe(''); // default
    expect(fetched!.enabled).toBe(true);
  });

  it('getWatcher returns undefined for unknown id', () => {
    const result = getWatcher('watcher-nonexistent');
    expect(result).toBeUndefined();
  });

  it('listWatchers returns all watchers for a group', () => {
    addWatcher({
      url: 'https://a.com',
      selector: '.a',
      groupId: 'group-1',
    });
    addWatcher({
      url: 'https://b.com',
      selector: '.b',
      groupId: 'group-1',
    });
    addWatcher({
      url: 'https://c.com',
      selector: '.c',
      groupId: 'group-2',
    });

    const group1 = listWatchers('group-1');
    expect(group1).toHaveLength(2);

    const group2 = listWatchers('group-2');
    expect(group2).toHaveLength(1);
  });

  it('listWatchers with enabledOnly=true excludes disabled', () => {
    const w1 = addWatcher({
      url: 'https://a.com',
      selector: '.a',
      groupId: 'main',
    });
    addWatcher({
      url: 'https://b.com',
      selector: '.b',
      groupId: 'main',
    });

    removeWatcher(w1.id);

    const all = listWatchers('main');
    expect(all).toHaveLength(2);

    const enabledOnly = listWatchers('main', true);
    expect(enabledOnly).toHaveLength(1);
    expect(enabledOnly[0].url).toBe('https://b.com');
  });

  it('listAllEnabledWatchers returns enabled watchers across groups', () => {
    addWatcher({
      url: 'https://a.com',
      selector: '.a',
      groupId: 'group-1',
    });
    const w2 = addWatcher({
      url: 'https://b.com',
      selector: '.b',
      groupId: 'group-2',
    });
    addWatcher({
      url: 'https://c.com',
      selector: '.c',
      groupId: 'group-3',
    });

    removeWatcher(w2.id);

    const enabled = listAllEnabledWatchers();
    expect(enabled).toHaveLength(2);
    expect(enabled.map((w) => w.groupId)).toContain('group-1');
    expect(enabled.map((w) => w.groupId)).toContain('group-3');
  });

  it('updateWatcherValue updates lastValue and checkedAt', () => {
    const watcher = addWatcher({
      url: 'https://example.com',
      selector: '.price',
      groupId: 'main',
    });

    expect(getWatcher(watcher.id)!.lastValue).toBeNull();
    expect(getWatcher(watcher.id)!.checkedAt).toBeNull();

    updateWatcherValue(watcher.id, '$42.99');

    const updated = getWatcher(watcher.id)!;
    expect(updated.lastValue).toBe('$42.99');
    expect(updated.checkedAt).toBeGreaterThan(0);
  });

  it('removeWatcher soft-deletes by setting enabled = 0', () => {
    const watcher = addWatcher({
      url: 'https://example.com',
      selector: '.status',
      groupId: 'main',
    });

    expect(getWatcher(watcher.id)!.enabled).toBe(true);

    removeWatcher(watcher.id);

    const removed = getWatcher(watcher.id)!;
    expect(removed).toBeDefined();
    expect(removed.enabled).toBe(false);
  });
});
