import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCentralProjection } from './per-agent-projections.js';
import { migration025 } from './migrations/025-agent-group-capabilities.js';
import { migration026 } from './migrations/026-tasks-and-dispatch-routing.js';

const tmpFiles: string[] = [];

function tmpPath(label: string): string {
  const p = path.join(os.tmpdir(), `ncproj-${label}-${process.pid}-${Date.now()}.db`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  tmpFiles.length = 0;
});

function makeSrcFile(label: string): string {
  const p = tmpPath(label);
  const db = new Database(p);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
      messaging_group_id TEXT, thread_id TEXT, agent_provider TEXT,
      status TEXT DEFAULT 'active', container_status TEXT DEFAULT 'stopped',
      last_active TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
      name TEXT, is_group INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'strict', created_at TEXT NOT NULL,
      UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE backlog_items (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, priority TEXT, tags TEXT,
      status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL,
      updated_at TEXT, resolved_at TEXT, notes TEXT
    );
    CREATE TABLE ship_log (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, pr_url TEXT, branch TEXT, tags TEXT, shipped_at TEXT NOT NULL
    );
  `);
  migration025.up(db);
  migration026.up(db);
  db.close();
  return p;
}

function withDb(p: string, fn: (db: Database.Database) => void): void {
  const db = new Database(p);
  db.pragma('foreign_keys = ON');
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function addAgent(p: string, agId: string): void {
  withDb(p, (db) => {
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')`,
    ).run(agId, agId, agId);
  });
}

function addSession(p: string, sessId: string, agId: string): void {
  withDb(p, (db) => {
    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')`,
    ).run(sessId, agId);
  });
}

function addTask(p: string, taskId: string, parentAgId: string, parentSessId: string, targetAgId: string): void {
  withDb(p, (db) => {
    db.prepare(
      `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
         target_agent_group_id, task_content, request_hash, admitted_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'content', 'hash', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(taskId, taskId, parentSessId, parentAgId, targetAgId);
  });
}

function addCapability(p: string, agId: string): void {
  // FK enforcement is ON when writing to src — but agent_group exists so it's fine
  withDb(p, (db) => {
    db.prepare(
      `INSERT INTO agent_group_capabilities (agent_group_id, role, config_json, granted_at)
       VALUES (?, 'orchestrator', '{}', '2026-01-01T00:00:00Z')`,
    ).run(agId);
  });
}

function countRows(p: string, table: string): number {
  const db = new Database(p, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function tableExists(p: string, table: string): boolean {
  const db = new Database(p, { readonly: true });
  try {
    return (
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table) !== undefined
    );
  } finally {
    db.close();
  }
}

describe('buildCentralProjection', () => {
  it('test_projection_copies_tasks_for_orchestrator', () => {
    const src = makeSrcFile('p1s');
    addAgent(src, 'ag-orch');
    addAgent(src, 'ag-target');
    addAgent(src, 'other-group');
    addSession(src, 'sess-orch', 'ag-orch');
    addSession(src, 'sess-other', 'other-group');
    addTask(src, 'task-orch', 'ag-orch', 'sess-orch', 'ag-target');
    addTask(src, 'task-other', 'other-group', 'sess-other', 'ag-target');
    addCapability(src, 'ag-orch');

    const dst = tmpPath('p1d');
    buildCentralProjection(src, dst, 'ag-orch');

    expect(countRows(dst, 'tasks')).toBe(1);
    expect(countRows(dst, 'agent_group_capabilities')).toBe(1);

    const db = new Database(dst, { readonly: true });
    try {
      const task = db.prepare(`SELECT task_id FROM tasks`).get() as { task_id: string } | undefined;
      expect(task?.task_id).toBe('task-orch');
    } finally {
      db.close();
    }
  });

  it('test_projection_excludes_other_orchestrators_tasks', () => {
    const src = makeSrcFile('p2s');
    addAgent(src, 'ag-orch');
    addAgent(src, 'ag-target');
    addAgent(src, 'other-group');
    addSession(src, 'sess-orch', 'ag-orch');
    addSession(src, 'sess-other', 'other-group');
    addTask(src, 'task-orch', 'ag-orch', 'sess-orch', 'ag-target');
    addTask(src, 'task-other', 'other-group', 'sess-other', 'ag-target');
    addCapability(src, 'ag-orch');

    const dst = tmpPath('p2d');
    buildCentralProjection(src, dst, 'other-group');

    expect(countRows(dst, 'tasks')).toBe(1);
    const db = new Database(dst, { readonly: true });
    try {
      const task = db.prepare(`SELECT task_id FROM tasks`).get() as { task_id: string } | undefined;
      expect(task?.task_id).toBe('task-other');
    } finally {
      db.close();
    }
    expect(countRows(dst, 'agent_group_capabilities')).toBe(0);
  });

  it('test_projection_works_with_no_data_rows', () => {
    const src = makeSrcFile('p3s');
    const dst = tmpPath('p3d');

    expect(() => buildCentralProjection(src, dst, 'ag-none')).not.toThrow();

    expect(tableExists(dst, 'tasks')).toBe(true);
    expect(tableExists(dst, 'agent_group_capabilities')).toBe(true);
    expect(tableExists(dst, 'backlog_items')).toBe(true);
    expect(tableExists(dst, 'ship_log')).toBe(true);
    expect(countRows(dst, 'tasks')).toBe(0);
    expect(countRows(dst, 'agent_group_capabilities')).toBe(0);
  });

  it('test_existing_backlog_and_shiplog_still_copied', () => {
    const src = makeSrcFile('p4s');
    addAgent(src, 'ag-1');
    withDb(src, (db) => {
      db.prepare(
        `INSERT INTO backlog_items (id, agent_group_id, title, status, created_at)
         VALUES ('b1', 'ag-1', 'Fix bug', 'open', '2026-01-01')`,
      ).run();
      db.prepare(
        `INSERT INTO ship_log (id, agent_group_id, title, shipped_at)
         VALUES ('s1', 'ag-1', 'Ship v1', '2026-01-01')`,
      ).run();
    });

    const dst = tmpPath('p4d');
    buildCentralProjection(src, dst, 'ag-1');

    expect(countRows(dst, 'backlog_items')).toBe(1);
    expect(countRows(dst, 'ship_log')).toBe(1);
  });
});
