/**
 * Watcher Store — CRUD for browser watcher configurations.
 *
 * Stores watcher configs in the `browser_watchers` SQLite table.
 * Each watcher monitors a URL + CSS selector for changes on a polling interval.
 */

import { randomUUID } from 'crypto';

import { getDb } from '../db.js';
import { logger } from '../logger.js';

export interface StoredWatcher {
  id: string;
  url: string;
  selector: string;
  groupId: string;
  intervalMs: number;
  label: string;
  lastValue: string | null;
  checkedAt: number | null;
  enabled: boolean;
  createdAt: number;
}

export interface AddWatcherInput {
  url: string;
  selector: string;
  groupId: string;
  intervalMs?: number;
  label?: string;
}

interface WatcherRow {
  id: string;
  url: string;
  selector: string;
  group_id: string;
  interval_ms: number;
  label: string;
  last_value: string | null;
  checked_at: number | null;
  enabled: number;
  created_at: number;
}

function rowToWatcher(row: WatcherRow): StoredWatcher {
  return {
    id: row.id,
    url: row.url,
    selector: row.selector,
    groupId: row.group_id,
    intervalMs: row.interval_ms,
    label: row.label,
    lastValue: row.last_value,
    checkedAt: row.checked_at,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

/**
 * Insert a new watcher and return the stored record.
 */
export function addWatcher(input: AddWatcherInput): StoredWatcher {
  const db = getDb();
  const id = `watcher-${randomUUID().slice(0, 8)}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO browser_watchers (id, url, selector, group_id, interval_ms, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.url,
    input.selector,
    input.groupId,
    input.intervalMs ?? 60000,
    input.label ?? '',
    now,
  );

  logger.debug({ id, url: input.url }, 'Added browser watcher');

  return {
    id,
    url: input.url,
    selector: input.selector,
    groupId: input.groupId,
    intervalMs: input.intervalMs ?? 60000,
    label: input.label ?? '',
    lastValue: null,
    checkedAt: null,
    enabled: true,
    createdAt: now,
  };
}

/**
 * Get a single watcher by id.
 */
export function getWatcher(id: string): StoredWatcher | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM browser_watchers WHERE id = ?')
    .get(id) as WatcherRow | undefined;
  return row ? rowToWatcher(row) : undefined;
}

/**
 * List watchers for a group. Optionally filter to enabled only.
 */
export function listWatchers(
  groupId: string,
  enabledOnly?: boolean,
): StoredWatcher[] {
  const db = getDb();

  if (enabledOnly) {
    const rows = db
      .prepare(
        'SELECT * FROM browser_watchers WHERE group_id = ? AND enabled = 1 ORDER BY created_at',
      )
      .all(groupId) as WatcherRow[];
    return rows.map(rowToWatcher);
  }

  const rows = db
    .prepare(
      'SELECT * FROM browser_watchers WHERE group_id = ? ORDER BY created_at',
    )
    .all(groupId) as WatcherRow[];
  return rows.map(rowToWatcher);
}

/**
 * List all enabled watchers across all groups.
 */
export function listAllEnabledWatchers(): StoredWatcher[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM browser_watchers WHERE enabled = 1 ORDER BY created_at',
    )
    .all() as WatcherRow[];
  return rows.map(rowToWatcher);
}

/**
 * Update the last observed value and check timestamp.
 * Logs a warning if the watcher ID does not exist.
 */
export function updateWatcherValue(id: string, value: string): void {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      'UPDATE browser_watchers SET last_value = ?, checked_at = ? WHERE id = ?',
    )
    .run(value, now, id);
  if (result.changes === 0) {
    logger.warn({ id }, 'updateWatcherValue: no watcher found');
  }
}

/**
 * Soft-delete a watcher by setting enabled = 0.
 * Returns true if a watcher was disabled, false if ID not found.
 */
export function removeWatcher(id: string): boolean {
  const db = getDb();
  const result = db
    .prepare('UPDATE browser_watchers SET enabled = 0 WHERE id = ?')
    .run(id);
  if (result.changes > 0) {
    logger.info({ id }, 'Browser watcher disabled');
    return true;
  }
  logger.warn({ id }, 'removeWatcher: no watcher found');
  return false;
}
