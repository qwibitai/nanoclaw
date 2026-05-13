import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleRecurrence } from './host-sweep.js';
import type { Session } from './types.js';
import { log } from './log.js';

const SCHEMA = `
  CREATE TABLE messages_in (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    platform_id TEXT,
    channel_type TEXT,
    thread_id TEXT,
    content TEXT NOT NULL,
    process_after TEXT,
    recurrence TEXT
  );
`;

function newDb(): { db: Database.Database; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sweep-'));
  const db = new Database(path.join(tmpDir, 'inbound.db'));
  db.exec(SCHEMA);
  return { db, tmpDir };
}

function insertCompletedRecurring(
  db: Database.Database,
  id: string,
  seq: number,
  recurrence: string,
  content = '{"prompt":"test"}',
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, process_after, recurrence)
     VALUES (?, ?, 'task', datetime('now'), 'completed', ?, '2026-01-01 00:00:00', ?)`,
  ).run(id, seq, content, recurrence);
}

const stubSession: Session = {
  id: 'sess-test',
  agent_group_id: 'test',
  messaging_group_id: null,
  agent_provider: null,
  platform_id: null,
  thread_id: null,
  status: 'active',
  container_status: 'running',
  last_active: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
} as Session;

describe('handleRecurrence', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    const created = newDb();
    db = created.db;
    tmpDir = created.tmpDir;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by test
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is synchronous — does not return a Promise (Bug B)', () => {
    insertCompletedRecurring(db, 'orig-1', 2, '0 8 * * *');

    const result = handleRecurrence(db, stubSession);

    // After handleRecurrence returns, db must still be usable — that proves
    // the function ran to completion synchronously (no pending await).
    expect(result === undefined || typeof (result as { then?: unknown }).then !== 'function').toBe(true);
    // Sanity: db still queryable
    const count = (db.prepare('SELECT COUNT(*) AS c FROM messages_in').get() as { c: number }).c;
    expect(count).toBeGreaterThan(0);
  });

  it('respawn schema: inserts new pending row with SQLite-friendly UTC process_after (Bug C)', () => {
    insertCompletedRecurring(db, 'orig-1', 2, '0 8 * * *');

    handleRecurrence(db, stubSession);

    const rows = db
      .prepare('SELECT id, kind, status, process_after, recurrence, content, seq FROM messages_in ORDER BY rowid')
      .all() as Array<{
      id: string;
      kind: string;
      status: string;
      process_after: string;
      recurrence: string | null;
      content: string;
      seq: number;
    }>;

    expect(rows).toHaveLength(2);

    const original = rows.find((r) => r.id === 'orig-1')!;
    const respawn = rows.find((r) => r.id !== 'orig-1')!;

    // Original: recurrence cleared
    expect(original.recurrence).toBeNull();
    expect(original.status).toBe('completed');

    // Respawn: same kind, recurrence, content; new id; SQLite UTC format
    expect(respawn.kind).toBe('task');
    expect(respawn.recurrence).toBe('0 8 * * *');
    expect(respawn.content).toBe('{"prompt":"test"}');
    expect(respawn.status).toBe('pending');
    // CRITICAL: format must be 'YYYY-MM-DD HH:MM:SS' (NOT ISO with T and Z)
    expect(respawn.process_after).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(respawn.process_after).not.toMatch(/T|Z/);
    // Seq: next even after the original's
    expect(respawn.seq).toBe(4);
  });

  it('handles multiple completed recurring rows in one call', () => {
    insertCompletedRecurring(db, 'orig-sweep', 2, '0 8-22 * * *');
    insertCompletedRecurring(db, 'orig-daily', 4, '0 8 * * *');
    insertCompletedRecurring(db, 'orig-weekly', 6, '0 19 * * 0');

    handleRecurrence(db, stubSession);

    const allRows = db.prepare('SELECT id, recurrence, status FROM messages_in').all() as Array<{
      id: string;
      recurrence: string | null;
      status: string;
    }>;

    // 3 originals (recurrence cleared) + 3 respawns (status pending, recurrence preserved)
    expect(allRows).toHaveLength(6);

    const originals = allRows.filter((r) => r.id.startsWith('orig-'));
    expect(originals).toHaveLength(3);
    for (const o of originals) {
      expect(o.recurrence).toBeNull();
      expect(o.status).toBe('completed');
    }

    const respawns = allRows.filter((r) => !r.id.startsWith('orig-'));
    expect(respawns).toHaveLength(3);
    for (const r of respawns) {
      expect(r.recurrence).not.toBeNull();
      expect(r.status).toBe('pending');
    }
  });

  it('invalid recurrence string: catches + logs error, continues to next row', () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    insertCompletedRecurring(db, 'orig-bad', 2, 'not a cron expr');
    insertCompletedRecurring(db, 'orig-good', 4, '0 8 * * *');

    handleRecurrence(db, stubSession);

    // The bad row's recurrence should NOT have been cleared (insert failed before clearRecurrence)
    const bad = db.prepare("SELECT recurrence FROM messages_in WHERE id='orig-bad'").get() as {
      recurrence: string | null;
    };
    expect(bad.recurrence).toBe('not a cron expr');

    // The good row should have been processed normally
    const good = db.prepare("SELECT recurrence FROM messages_in WHERE id='orig-good'").get() as {
      recurrence: string | null;
    };
    expect(good.recurrence).toBeNull();

    // error logged at least once
    expect(errSpy).toHaveBeenCalled();
    const firstCall = errSpy.mock.calls[0];
    expect(firstCall[0]).toBe('Failed to compute next recurrence');

    errSpy.mockRestore();
  });

  it('SQLite UTC regression guard: respawned row compares correctly with datetime(now)', () => {
    // Use a recurrence that fires very soon (every minute) so the next occurrence
    // is within ~60s — the test still asserts on the format, not the wall clock.
    insertCompletedRecurring(db, 'orig-1', 2, '* * * * *');

    handleRecurrence(db, stubSession);

    const respawn = db.prepare("SELECT id, process_after FROM messages_in WHERE id != 'orig-1'").get() as {
      id: string;
      process_after: string;
    };

    // The format itself is the regression guard: if ISO format crept back in,
    // 'T' > ' ' would break this comparison. The respawn's process_after is
    // in the future (next cron tick), so this query returns nothing — which
    // is the correct behavior for "not yet due".
    const futureDue = db
      .prepare("SELECT id FROM messages_in WHERE process_after <= datetime('now') AND id = ?")
      .get(respawn.id);
    expect(futureDue).toBeUndefined();

    // And if we manipulate it backward to a known past time and re-check,
    // the same query MUST return the row (proves the comparison works).
    db.prepare("UPDATE messages_in SET process_after = '2026-01-01 00:00:00' WHERE id = ?").run(respawn.id);
    const pastDue = db
      .prepare("SELECT id FROM messages_in WHERE process_after <= datetime('now') AND id = ?")
      .get(respawn.id);
    expect(pastDue).toBeDefined();
  });

  it('cron expressions are interpreted in America/Sao_Paulo timezone', () => {
    // Yearly recurrence pinned to Jan 1, 12:30. Distant enough that whichever
    // year/month is "next" is unambiguous — the only thing that varies between
    // UTC and BRT interpretation is the hour-of-day in the resulting UTC
    // timestamp:
    //
    //   UTC interp: '2027-01-01 12:30:00' (next 12:30 UTC after now)
    //   BRT interp: '2027-01-01 15:30:00' (next 12:30 BRT = 15:30 UTC after now)
    //
    // If the test ever runs after 2027-01-01 12:30 BRT, the year shifts to
    // 2028 but the hour assertion is the actual regression guard.
    insertCompletedRecurring(db, 'orig-tz', 2, '30 12 1 1 *');

    handleRecurrence(db, stubSession);

    const respawn = db.prepare("SELECT process_after FROM messages_in WHERE id != 'orig-tz'").get() as {
      process_after: string;
    };

    // 12:30 BRT = 15:30 UTC year-round (Brazil has no DST since 2019).
    expect(respawn.process_after).toMatch(/ 15:30:00$/);
    // Sanity: NOT the UTC-interp hour.
    expect(respawn.process_after).not.toMatch(/ 12:30:00$/);
  });
});
