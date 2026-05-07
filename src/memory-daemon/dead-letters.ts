import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { openMnemonIngestDb } from '../db/migrations/019-mnemon-ingest-db.js';

export type DeadLetterItemType = 'turn-pair' | 'source-file' | 'recall-judge';

export interface DeadLetterRow {
  id: string;
  itemType: DeadLetterItemType;
  itemKey: string;
  agentGroupId: string;
  failureCount: number;
  lastError: string;
  lastAttemptedAt: string;
  nextRetryAt: string | null;
  poisonedAt: string | null;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = openMnemonIngestDb();
  }
  return _db;
}

/** For tests: inject a pre-opened DB (typically in-memory). */
export function setDeadLettersDb(db: Database.Database): void {
  _db = db;
}

function backoffSeconds(failureCount: number): number | null {
  if (failureCount === 1) return 60;
  if (failureCount === 2) return 300;
  return null;
}

function toRow(raw: Record<string, unknown>): DeadLetterRow {
  return {
    id: raw.id as string,
    itemType: raw.item_type as DeadLetterItemType,
    itemKey: raw.item_key as string,
    agentGroupId: raw.agent_group_id as string,
    failureCount: raw.failure_count as number,
    lastError: raw.last_error as string,
    lastAttemptedAt: raw.last_attempted_at as string,
    nextRetryAt: (raw.next_retry_at as string | null) ?? null,
    poisonedAt: (raw.poisoned_at as string | null) ?? null,
  };
}

export function recordOrIncrementFailure(opts: {
  itemType: DeadLetterItemType;
  itemKey: string;
  agentGroupId: string;
  error: string;
}): { poisoned: boolean; failureCount: number } {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();

  const existing = db
    .prepare(`SELECT * FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`)
    .get(opts.itemKey, opts.agentGroupId) as Record<string, unknown> | undefined;

  if (!existing) {
    const nextSecs = backoffSeconds(1);
    const nextRetryAt = nextSecs ? new Date(now.getTime() + nextSecs * 1000).toISOString() : null;
    db.prepare(
      `
      INSERT INTO dead_letters (id, item_type, item_key, agent_group_id, failure_count, last_error, last_attempted_at, next_retry_at, poisoned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(randomUUID(), opts.itemType, opts.itemKey, opts.agentGroupId, 1, opts.error, nowIso, nextRetryAt, null);
    return { poisoned: false, failureCount: 1 };
  }

  const newCount = (existing.failure_count as number) + 1;

  if (newCount >= 3) {
    db.prepare(
      `
      UPDATE dead_letters
      SET failure_count = ?, last_error = ?, last_attempted_at = ?, next_retry_at = NULL, poisoned_at = ?
      WHERE item_key = ? AND agent_group_id = ?
    `,
    ).run(newCount, opts.error, nowIso, nowIso, opts.itemKey, opts.agentGroupId);
    return { poisoned: true, failureCount: newCount };
  }

  const nextSecs = backoffSeconds(newCount);
  const nextRetryAt = nextSecs ? new Date(now.getTime() + nextSecs * 1000).toISOString() : null;
  db.prepare(
    `
    UPDATE dead_letters
    SET failure_count = ?, last_error = ?, last_attempted_at = ?, next_retry_at = ?, poisoned_at = NULL
    WHERE item_key = ? AND agent_group_id = ?
  `,
  ).run(newCount, opts.error, nowIso, nextRetryAt, opts.itemKey, opts.agentGroupId);
  return { poisoned: false, failureCount: newCount };
}

export function getDueRetries(agentGroupId: string, now: Date): DeadLetterRow[] {
  const db = getDb();
  const nowIso = now.toISOString();
  const rows = db
    .prepare(
      `
      SELECT * FROM dead_letters
      WHERE agent_group_id = ? AND poisoned_at IS NULL AND next_retry_at <= ?
      ORDER BY next_retry_at
    `,
    )
    .all(agentGroupId, nowIso) as Record<string, unknown>[];
  return rows.map(toRow);
}

export function deleteAfterSuccess(itemKey: string, agentGroupId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`).run(itemKey, agentGroupId);
}

export function getPoisonedSummary(agentGroupId: string): {
  count: number;
  oldestPoisonedAt: string | null;
} {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS count, MIN(poisoned_at) AS oldest
      FROM dead_letters
      WHERE agent_group_id = ? AND poisoned_at IS NOT NULL
    `,
    )
    .get(agentGroupId) as { count: number; oldest: string | null };
  return { count: row.count, oldestPoisonedAt: row.oldest };
}
