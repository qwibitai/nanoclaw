// src/event-log.ts
import { getDb } from './db.js';
import { eventBus, EventBus } from './event-bus.js';
import { logger } from './logger.js';
import type { NanoClawEvent } from './events.js';

/**
 * Log an event to the event_log table.
 */
export function logEvent(event: NanoClawEvent): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO event_log (event_type, source, group_id, payload, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    event.type,
    event.source,
    event.groupId ?? null,
    JSON.stringify(event.payload),
    event.timestamp,
  );
}

/**
 * Query events by time range and optional type filter.
 */
export function queryEvents(opts: {
  since: number;
  until?: number;
  type?: string;
  groupId?: string;
  limit?: number;
}): Array<{
  id: number;
  event_type: string;
  source: string;
  group_id: string | null;
  payload: Record<string, unknown>;
  timestamp: number;
}> {
  const db = getDb();
  const conditions: string[] = ['timestamp >= ?'];
  const params: unknown[] = [opts.since];

  if (opts.until !== undefined) {
    conditions.push('timestamp <= ?');
    params.push(opts.until);
  }

  if (opts.type !== undefined) {
    conditions.push('event_type = ?');
    params.push(opts.type);
  }

  if (opts.groupId !== undefined) {
    conditions.push('group_id = ?');
    params.push(opts.groupId);
  }

  const limit = opts.limit ?? 100;
  const sql = `SELECT id, event_type, source, group_id, payload, timestamp
               FROM event_log
               WHERE ${conditions.join(' AND ')}
               ORDER BY timestamp DESC
               LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    event_type: string;
    source: string;
    group_id: string | null;
    payload: string;
    timestamp: number;
  }>;

  return rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}

/**
 * Delete events older than the retention period.
 */
export function pruneOldEvents(
  retentionMs: number = 30 * 24 * 60 * 60 * 1000,
): number {
  const db = getDb();
  const cutoff = Date.now() - retentionMs;
  const result = db
    .prepare('DELETE FROM event_log WHERE timestamp < ?')
    .run(cutoff);
  return result.changes;
}

/**
 * Start the event log subscriber. Call once at startup.
 * Subscribes to all events via onAny() and logs them.
 * Accepts an optional EventBus for testing; defaults to the singleton.
 */
export function startEventLog(bus?: EventBus): () => void {
  const target = bus ?? eventBus;
  return target.onAny((event) => {
    try {
      logEvent(event);
    } catch (err) {
      logger.error({ err, eventType: event.type }, 'Failed to log event');
    }
  });
}
