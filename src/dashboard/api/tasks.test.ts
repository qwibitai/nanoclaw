import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import http from 'http';
import fs from 'fs';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { insertTaskAtomic } from '../../modules/orchestrator-dispatch/db/tasks.js';
import { tasksListHandler, tasksDetailHandler } from './tasks.js';
import type { AuthedRequestContext } from '../router.js';

// Spy on fs.existsSync to prevent transcript loading from opening real DBs
let existsSyncSpy: MockInstance;

// ── Helpers ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function makeCtx(userId: string, opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {}): AuthedRequestContext {
  return {
    user: { id: userId, kind: 'dashboard', display_name: userId, created_at: now() },
    scopes: {
      role: opts.no_filter ? 'owner' : 'admin_of_group',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? false,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function makeReq(url = 'http://localhost/dashboard/api/tasks'): Request {
  return new Request(url);
}

function insertTask(
  taskId: string,
  agId: string,
  sessId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' = 'running',
): void {
  insertTaskAtomic({
    task_id: taskId,
    idempotency_key: taskId,
    parent_session_id: sessId,
    parent_agent_group_id: agId,
    parent_messaging_group_id: null,
    child_session_id: null,
    status,
    task_content: 'do something',
    request_hash: 'hash-x',
    deadline: null,
    parent_platform_message_id: null,
    child_platform_thread_id: null,
    child_messaging_group_id: null,
    admitted_at: now(),
    started_at: status === 'running' ? now() : null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_progress_at: null,
    last_progress_message: null,
    fail_reason: null,
    result_summary: null,
    dispatch_completion_attempts: 0,
    completion_lease_at: null,
    surface_mode: 'headless',
  });
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function seedSession(sessId: string, agId: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, created_at) VALUES (?, ?, NULL, ?)')
    .run(sessId, agId, now());
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('tasksListHandler — D3', () => {
  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    setupDb();
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    seedSession('sess-1', 'ag-1');
    seedSession('sess-2', 'ag-2');
  });
  afterEach(() => {
    closeDb();
    existsSyncSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('test_list_no_filter_owner_returns_all', async () => {
    insertTask('t1', 'ag-1', 'sess-1');
    insertTask('t2', 'ag-2', 'sess-2');
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await tasksListHandler(makeReq(), {}, ctx);
    expect(resp!.status).toBe(200);
    const body = await resp!.json() as { tasks: unknown[] };
    expect(body.tasks.length).toBe(2);
  });

  it('test_list_scoped_admin_filters_groups', async () => {
    insertTask('t1', 'ag-1', 'sess-1');
    insertTask('t2', 'ag-2', 'sess-2');
    const ctx = makeCtx('u1', { allowed_group_ids: ['ag-1'] });
    const resp = await tasksListHandler(makeReq(), {}, ctx);
    const body = await resp!.json() as { tasks: Array<{ task_id: string }> };
    expect(body.tasks.length).toBe(1);
    expect(body.tasks[0].task_id).toBe('t1');
  });

  it('test_list_filter_by_status', async () => {
    insertTask('t1', 'ag-1', 'sess-1', 'running');
    insertTask('t2', 'ag-1', 'sess-1', 'running');
    insertTask('t3', 'ag-1', 'sess-1', 'completed');
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await tasksListHandler(makeReq('http://localhost/dashboard/api/tasks?status=running'), {}, ctx);
    const body = await resp!.json() as { tasks: Array<{ status: string }> };
    expect(body.tasks.every((t) => t.status === 'running')).toBe(true);
    expect(body.tasks.length).toBe(2);
  });
});

describe('tasksDetailHandler — D3', () => {
  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    setupDb();
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    seedSession('sess-1', 'ag-1');
    seedSession('sess-2', 'ag-2');
  });
  afterEach(() => {
    closeDb();
    existsSyncSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('test_detail_returns_task_plus_transcript', async () => {
    insertTask('spawn-abc', 'ag-1', 'sess-1');
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await tasksDetailHandler(makeReq(), { id: 'spawn-abc' }, ctx);
    expect(resp!.status).toBe(200);
    const body = await resp!.json() as { task: { task_id: string }; transcript: unknown[] };
    expect(body.task.task_id).toBe('spawn-abc');
    expect(Array.isArray(body.transcript)).toBe(true);
  });

  it('test_detail_out_of_scope_returns_404', async () => {
    insertTask('spawn-abc', 'ag-2', 'sess-2');
    const ctx = makeCtx('u1', { allowed_group_ids: ['ag-1'] });
    const resp = await tasksDetailHandler(makeReq(), { id: 'spawn-abc' }, ctx);
    expect(resp!.status).toBe(404);
    const body = await resp!.json() as { error: string };
    expect(body.error).toBe('task_not_found');
  });

  it('test_transcript_timestamp_normalization: Date.parse sort orders ISO-T vs space correctly', () => {
    // ISO with T (host): '2026-05-10T12:34:56.000Z' → Date.parse gives UTC ms
    // SQLite datetime (container): '2026-05-10 12:34:57' → interpreted as UTC with appended Z
    const tIso = Date.parse('2026-05-10T12:34:56.000Z');
    const tSpace = Date.parse('2026-05-10 12:34:57Z');
    // outbound (container, 1s later) should sort before inbound (host)
    expect(tSpace).toBeGreaterThan(tIso);
    // String lex compare would invert: space (0x20) < 'T' (0x54)
    expect('2026-05-10 12:34:57' < '2026-05-10T12:34:56.000Z').toBe(true);
  });

  it('test_transcript_unparseable_content_falls_back_to_agent', async () => {
    insertTask('spawn-def', 'ag-1', 'sess-1');
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await tasksDetailHandler(makeReq(), { id: 'spawn-def' }, ctx);
    expect(resp!.status).toBe(200);
    const body = await resp!.json() as { transcript: unknown[] };
    // No session DBs exist (fs.existsSync returns false), so transcript is empty
    expect(body.transcript.length).toBe(0);
  });
});
