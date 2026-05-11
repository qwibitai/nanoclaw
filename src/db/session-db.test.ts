/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { getInboundSourceSessionId, migrateMessagesInTable, sessionInboundHasMessage, upsertSessionRouting } from './session-db.js';
import { INBOUND_SCHEMA } from './schema.js';
import { DATA_DIR } from '../config.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

describe('upsertSessionRouting — spawn_task_id + session_id columns', () => {
  function makeInboundDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    return db;
  }

  it('test_upsert_writes_session_id_and_spawn_task_id', () => {
    const db = makeInboundDb();
    try {
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: 't1',
        session_id: 'sess-1',
        spawn_task_id: 'spawn-x',
      });
      const row = db
        .prepare(
          'SELECT channel_type, platform_id, thread_id, session_id, spawn_task_id FROM session_routing WHERE id = 1',
        )
        .get() as {
        channel_type: string;
        platform_id: string;
        thread_id: string;
        session_id: string;
        spawn_task_id: string;
      };
      expect(row.channel_type).toBe('slack');
      expect(row.platform_id).toBe('C1');
      expect(row.thread_id).toBe('t1');
      expect(row.session_id).toBe('sess-1');
      expect(row.spawn_task_id).toBe('spawn-x');
    } finally {
      db.close();
    }
  });

  it('test_upsert_coalesce_preserves_existing_spawn_task_id', () => {
    const db = makeInboundDb();
    try {
      // First write: set spawn_task_id
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: null,
        session_id: 'sess-1',
        spawn_task_id: 'spawn-x',
      });
      // Second write: routine wake — no spawn_task_id provided
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: null,
        session_id: 'sess-1',
      });
      const row = db.prepare('SELECT spawn_task_id, session_id FROM session_routing WHERE id = 1').get() as {
        spawn_task_id: string | null;
        session_id: string | null;
      };
      expect(row.spawn_task_id).toBe('spawn-x');
      expect(row.session_id).toBe('sess-1');
    } finally {
      db.close();
    }
  });

  it('test_upsert_coalesce_preserves_existing_session_id_on_routine_wake', () => {
    const db = makeInboundDb();
    try {
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: null,
        session_id: 'sess-1',
      });
      // Explicit null session_id — should not clobber via COALESCE
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: null,
        session_id: null,
      });
      const row = db.prepare('SELECT session_id FROM session_routing WHERE id = 1').get() as {
        session_id: string | null;
      };
      expect(row.session_id).toBe('sess-1');
    } finally {
      db.close();
    }
  });

  it('test_upsert_renames_legacy_dispatch_task_id_column', () => {
    // Phase-1 inbound.db has dispatch_task_id; upsert must rename it to spawn_task_id.
    const db = new Database(':memory:');
    db.pragma('journal_mode = DELETE');
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_routing (
        id               INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type     TEXT,
        platform_id      TEXT,
        thread_id        TEXT,
        dispatch_task_id TEXT,
        session_id       TEXT
      );
      INSERT INTO session_routing (id, channel_type, platform_id, thread_id, dispatch_task_id, session_id)
        VALUES (1, 'slack', 'C1', 't1', 'dispatch-legacy', 'sess-legacy');
    `);
    try {
      // Routine upsert should trigger the rename and preserve the old value
      upsertSessionRouting(db, {
        channel_type: 'slack',
        platform_id: 'C1',
        thread_id: 't1',
        session_id: 'sess-legacy',
      });
      const cols = (db.prepare(`PRAGMA table_info(session_routing)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toContain('spawn_task_id');
      expect(cols).not.toContain('dispatch_task_id');
      const row = db.prepare('SELECT spawn_task_id FROM session_routing WHERE id = 1').get() as {
        spawn_task_id: string | null;
      };
      // Renamed column carries the original value forward
      expect(row.spawn_task_id).toBe('dispatch-legacy');
    } finally {
      db.close();
    }
  });

  it('test_upsert_works_on_legacy_db_without_new_columns', () => {
    // Simulate an old inbound.db that predates migration 026
    const db = new Database(':memory:');
    db.pragma('journal_mode = DELETE');
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_routing (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type TEXT,
        platform_id  TEXT,
        thread_id    TEXT
      );
    `);
    try {
      // Should not throw — migrateSessionRoutingTable adds missing columns
      expect(() =>
        upsertSessionRouting(db, {
          channel_type: 'slack',
          platform_id: 'C1',
          thread_id: null,
          session_id: 'sess-1',
          spawn_task_id: 'spawn-x',
        }),
      ).not.toThrow();
      const row = db.prepare('SELECT session_id, spawn_task_id FROM session_routing WHERE id = 1').get() as {
        session_id: string | null;
        spawn_task_id: string | null;
      };
      expect(row.session_id).toBe('sess-1');
      expect(row.spawn_task_id).toBe('spawn-x');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// sessionInboundHasMessage
// ---------------------------------------------------------------------------

describe('sessionInboundHasMessage', () => {
  const TEST_GROUP = 'test-group-has-msg';
  const TEST_SESSION = 'test-session-has-msg';

  function sessionDbPath(): string {
    return path.join(DATA_DIR, 'v2-sessions', TEST_GROUP, TEST_SESSION, 'inbound.db');
  }

  afterEach(() => {
    const dir = path.join(DATA_DIR, 'v2-sessions', TEST_GROUP);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  it('test_sessionInboundHasMessage_present', () => {
    const dbPath = sessionDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('msg-1', 2);
    db.close();

    expect(sessionInboundHasMessage(TEST_GROUP, TEST_SESSION, 'msg-1')).toBe(true);
  });

  it('test_sessionInboundHasMessage_absent', () => {
    const dbPath = sessionDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.exec(INBOUND_SCHEMA);
    db.close();

    expect(sessionInboundHasMessage(TEST_GROUP, TEST_SESSION, 'msg-2')).toBe(false);
  });

  it('test_sessionInboundHasMessage_no_db', () => {
    expect(sessionInboundHasMessage(TEST_GROUP, 'nonexistent-session', 'msg-1')).toBe(false);
  });
});
