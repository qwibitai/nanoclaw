import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration025 } from './025-agent-group-capabilities.js';
import { migration026 } from './026-tasks-and-dispatch-routing.js';
import { migration027 } from './027-drop-tasks-target-agent-group-id.js';

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
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
      messaging_group_id TEXT, thread_id TEXT, agent_provider TEXT,
      status TEXT, container_status TEXT, last_active TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
      name TEXT, is_group INTEGER, unknown_sender_policy TEXT, created_at TEXT NOT NULL,
      UNIQUE(channel_type, platform_id)
    );
  `);
  migration025.up(d);
  migration026.up(d);
  return d;
}

describe('027-drop-tasks-target-agent-group-id', () => {
  it('drops the target_agent_group_id column from tasks', () => {
    db = makeDb();

    // Pre-state: column exists from migration 026
    const before = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    expect(before.map((c) => c.name)).toContain('target_agent_group_id');

    migration027.up(db);

    const after = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    expect(after.map((c) => c.name)).not.toContain('target_agent_group_id');
  });

  it('drops the idx_tasks_target_group index', () => {
    db = makeDb();
    expect(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_target_group'`)
          .all() as Array<{ name: string }>
      ).length,
    ).toBe(1);

    migration027.up(db);

    expect(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_target_group'`)
          .all() as Array<{ name: string }>
      ).length,
    ).toBe(0);
  });

  it('preserves the other tasks columns (parent_session_id, parent_agent_group_id)', () => {
    db = makeDb();
    migration027.up(db);

    const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('task_id');
    expect(cols).toContain('parent_session_id');
    expect(cols).toContain('parent_agent_group_id');
    expect(cols).toContain('status');
    expect(cols).toContain('admitted_at');
  });
});
