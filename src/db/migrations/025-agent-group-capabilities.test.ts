import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration025 } from './025-agent-group-capabilities.js';

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
  // Set up minimal schema that migration 025 depends on (agent_groups, users)
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
  `);
  return d;
}

describe('025-agent-group-capabilities', () => {
  it('test_migration_creates_table_and_index', () => {
    db = makeDb();
    migration025.up(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_group_capabilities'`)
      .all() as { name: string }[];
    expect(tables.length).toBe(1);

    const cols = db.prepare(`PRAGMA table_info(agent_group_capabilities)`).all() as {
      name: string;
      notnull: number;
    }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('agent_group_id');
    expect(colNames).toContain('role');
    expect(colNames).toContain('config_json');
    expect(colNames).toContain('granted_by');
    expect(colNames).toContain('granted_at');

    // agent_group_id must be NOT NULL
    const agCol = cols.find((c) => c.name === 'agent_group_id');
    expect(agCol?.notnull).toBe(1);

    // Index exists
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_group_capabilities_role'`)
      .all() as { name: string }[];
    expect(indexes.length).toBe(1);
  });

  it('test_migration_pk_rejects_duplicate_capability', () => {
    db = makeDb();
    migration025.up(db);

    db.exec(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-x', 'X', 'x', '2026-01-01T00:00:00Z')`);
    db.exec(`INSERT INTO agent_group_capabilities (agent_group_id, role, granted_at) VALUES ('ag-x', 'orchestrator', '2026-01-01T00:00:00Z')`);

    expect(() => {
      db!.exec(`INSERT INTO agent_group_capabilities (agent_group_id, role, granted_at) VALUES ('ag-x', 'orchestrator', '2026-01-01T00:00:00Z')`);
    }).toThrow();
  });

  it('test_migration_idempotent', () => {
    db = makeDb();
    migration025.up(db);
    // Second run should not throw (uses IF NOT EXISTS)
    expect(() => migration025.up(db!)).not.toThrow();
  });
});
