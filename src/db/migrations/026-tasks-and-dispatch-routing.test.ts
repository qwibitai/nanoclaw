import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration025 } from './025-agent-group-capabilities.js';
import { migration026 } from './026-tasks-and-dispatch-routing.js';
import { INBOUND_SCHEMA } from '../schema.js';

let db: Database.Database | null = null;

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
});

function makeDb(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
    CREATE TABLE agent_groups (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      folder     TEXT NOT NULL UNIQUE,
      agent_provider TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE users (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      display_name TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id                 TEXT PRIMARY KEY,
      agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
      messaging_group_id TEXT,
      thread_id          TEXT,
      agent_provider     TEXT,
      status             TEXT DEFAULT 'active',
      container_status   TEXT DEFAULT 'stopped',
      last_active        TEXT,
      created_at         TEXT NOT NULL
    );
    CREATE TABLE messaging_groups (
      id                    TEXT PRIMARY KEY,
      channel_type          TEXT NOT NULL,
      platform_id           TEXT NOT NULL,
      name                  TEXT,
      is_group              INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
      created_at            TEXT NOT NULL,
      UNIQUE(channel_type, platform_id)
    );
  `);
  migration025.up(d);
  return d;
}

function seedSession(d: Database.Database, agId: string, sessId: string): void {
  d.exec(
    `INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('${agId}', 'AG', 'folder-${agId}', '2026-01-01T00:00:00Z')`,
  );
  d.exec(
    `INSERT INTO sessions (id, agent_group_id, created_at) VALUES ('${sessId}', '${agId}', '2026-01-01T00:00:00Z')`,
  );
}

describe('026-tasks-and-dispatch-routing', () => {
  it('test_tasks_table_columns', () => {
    db = makeDb();
    seedSession(db, 'ag-1', 'sess-1');
    migration026.up(db);

    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

    // Required columns present
    expect(colMap['task_id']).toBeDefined();
    expect(colMap['idempotency_key']).toBeDefined();
    expect(colMap['parent_session_id']).toBeDefined();
    expect(colMap['parent_agent_group_id']).toBeDefined();
    expect(colMap['target_agent_group_id']).toBeDefined();
    expect(colMap['status']).toBeDefined();
    expect(colMap['task_content']).toBeDefined();
    expect(colMap['request_hash']).toBeDefined();
    expect(colMap['admitted_at']).toBeDefined();
    expect(colMap['surface_mode']).toBeDefined();
    expect(colMap['completion_lease_at']).toBeDefined();
    expect(colMap['dispatch_completion_attempts']).toBeDefined();
    expect(colMap['created_at']).toBeDefined();

    // admitted_at must be NOT NULL
    expect(colMap['admitted_at']!.notnull).toBe(1);

    // request_hash must be NOT NULL
    expect(colMap['request_hash']!.notnull).toBe(1);

    // dispatch_completion_attempts default 0
    expect(colMap['dispatch_completion_attempts']!.dflt_value).toBe('0');

    // No dispatch_state column (rejected Option B)
    expect(colMap['dispatch_state']).toBeUndefined();

    // status column exists (rejected Option C)
    expect(colMap['status']).toBeDefined();
  });

  it('test_tasks_unique_idempotency_constraint', () => {
    db = makeDb();
    seedSession(db, 'ag-1', 'sess-1');
    seedSession(db, 'ag-2', 'sess-2');
    migration026.up(db);

    db.exec(`
      INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
        target_agent_group_id, task_content, request_hash, admitted_at, created_at)
      VALUES ('t1', 'k1', 'sess-1', 'ag-1', 'ag-2', 'content', 'hash1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `);

    expect(() => {
      db!.exec(`
        INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          target_agent_group_id, task_content, request_hash, admitted_at, created_at)
        VALUES ('t2', 'k1', 'sess-1', 'ag-1', 'ag-2', 'content2', 'hash2', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      `);
    }).toThrow();
  });

  it('test_tasks_surface_mode_check', () => {
    db = makeDb();
    seedSession(db, 'ag-1', 'sess-1');
    seedSession(db, 'ag-2', 'sess-2');
    migration026.up(db);

    expect(() => {
      db!.exec(`
        INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          target_agent_group_id, task_content, request_hash, admitted_at, surface_mode, created_at)
        VALUES ('t1', 'k1', 'sess-1', 'ag-1', 'ag-2', 'content', 'hash1', '2026-01-01T00:00:00Z', 'invalid_mode', '2026-01-01T00:00:00Z')
      `);
    }).toThrow();
  });

  it('test_inbound_schema_has_dispatch_task_id', () => {
    const inboundDb = new Database(':memory:');
    try {
      inboundDb.exec(INBOUND_SCHEMA);
      const cols = inboundDb.prepare(`PRAGMA table_info(session_routing)`).all() as { name: string }[];
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('dispatch_task_id');
    } finally {
      inboundDb.close();
    }
  });

  it('test_partial_index_pending_admitted_created', () => {
    db = makeDb();
    seedSession(db, 'ag-1', 'sess-1');
    migration026.up(db);

    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_pending_admitted'`)
      .all() as { name: string }[];
    expect(idx.length).toBe(1);
  });

  it('test_unique_index_caller_idempotency_created', () => {
    db = makeDb();
    seedSession(db, 'ag-1', 'sess-1');
    migration026.up(db);

    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='uq_tasks_caller_idempotency'`)
      .all() as { name: string }[];
    expect(idx.length).toBe(1);
  });
});
