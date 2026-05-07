import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMnemonIngestMigrations } from './019-mnemon-ingest-db.js';
import { runMnemonDaemonStateMigration } from './022-mnemon-daemon-state.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

const dbs: Database.Database[] = [];
function tracked(db: Database.Database): Database.Database {
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  dbs.length = 0;
});

describe('migration 022: mnemon-daemon-state', () => {
  it('test_daemon_state_table_created', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    runMnemonDaemonStateMigration(db);

    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='daemon_state'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('daemon_state');

    const versionRow = db
      .prepare(`SELECT name FROM schema_version WHERE name='mnemon-daemon-state-v1'`)
      .get() as { name: string } | undefined;
    expect(versionRow?.name).toBe('mnemon-daemon-state-v1');

    // Verify can insert and select
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      'lastNightlyAt',
      now,
      now,
    );
    const inserted = db
      .prepare(`SELECT key, value FROM daemon_state WHERE key=?`)
      .get('lastNightlyAt') as { key: string; value: string } | undefined;
    expect(inserted?.key).toBe('lastNightlyAt');
    expect(inserted?.value).toBe(now);
  });

  it('test_idempotent', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    runMnemonDaemonStateMigration(db);
    expect(() => runMnemonDaemonStateMigration(db)).not.toThrow();

    const count = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM schema_version WHERE name='mnemon-daemon-state-v1'`)
        .get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('test_no_fk_dependency_on_recall_feedback', () => {
    // daemon_state must be runnable without recall_feedback migration
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    // intentionally do NOT run runMnemonRecallFeedbackMigration
    expect(() => runMnemonDaemonStateMigration(db)).not.toThrow();

    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='daemon_state'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('daemon_state');
  });

  it('test_daemon_state_schema', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    runMnemonDaemonStateMigration(db);

    const cols = (db.prepare(`PRAGMA table_info(daemon_state)`).all() as { name: string; pk: number; notnull: number }[]);
    const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(colMap).toHaveProperty('key');
    expect(colMap).toHaveProperty('value');
    expect(colMap).toHaveProperty('updated_at');
    expect(colMap['key'].pk).toBe(1);
    expect(colMap['value'].notnull).toBe(1);
    expect(colMap['updated_at'].notnull).toBe(1);
  });
});
