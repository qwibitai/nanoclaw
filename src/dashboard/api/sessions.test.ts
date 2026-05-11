import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { sessionsHandler } from './sessions.js';
import type { AuthedRequestContext } from '../router.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    heartbeatPath: vi.fn().mockImplementation((_ag: string, sessId: string) => `/tmp/hb-${sessId}`),
  };
});

vi.mock('fs', async () => {
  return {
    default: {
      statSync: vi.fn().mockImplementation(() => {
        throw new Error('ENOENT');
      }),
      existsSync: vi.fn().mockReturnValue(false),
    },
  };
});

import fs from 'fs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function makeCtx(
  userId: string,
  opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {},
): AuthedRequestContext {
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

function makeReq(url = 'http://localhost/dashboard/api/sessions'): Request {
  return new Request(url);
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function insertSession(sessId: string, agId: string, mgId: string | null = null): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    )
    .run(sessId, agId, mgId, now());
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sessionsHandler — D4', () => {
  beforeEach(() => {
    vi.mocked(fs.statSync).mockReset();
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    setupDb();
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  it('test_sessions_owner_no_filter', async () => {
    insertSession('sess-1', 'ag-1');
    insertSession('sess-2', 'ag-1');
    insertSession('sess-3', 'ag-2');
    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as { sessions: unknown[] };
    expect(body.sessions.length).toBe(3);
  });

  it('test_sessions_scoped_admin', async () => {
    insertSession('sess-1', 'ag-1');
    insertSession('sess-2', 'ag-2');
    const ctx = makeCtx('u1', { allowed_group_ids: ['ag-1'] });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as { sessions: Array<{ agent_group_id: string }> };
    expect(body.sessions.every((s) => s.agent_group_id === 'ag-1')).toBe(true);
  });

  it('test_sessions_container_status_derived_from_heartbeat', async () => {
    insertSession('sess-running', 'ag-1');
    insertSession('sess-idle', 'ag-1');
    insertSession('sess-stale', 'ag-1');
    insertSession('sess-unknown', 'ag-1');

    const nowMs = Date.now();
    vi.mocked(fs.statSync).mockImplementation((p) => {
      const pathStr = p as string;
      if (pathStr.includes('sess-running')) return { mtimeMs: nowMs - 10_000 } as fs.Stats;
      if (pathStr.includes('sess-idle')) return { mtimeMs: nowMs - 120_000 } as fs.Stats;
      if (pathStr.includes('sess-stale')) return { mtimeMs: nowMs - 400_000 } as fs.Stats;
      throw new Error('ENOENT');
    });

    const ctx = makeCtx('u1', { no_filter: true });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as { sessions: Array<{ session_id: string; container_status: string }> };

    const find = (id: string) => body.sessions.find((s) => s.session_id === id);
    expect(find('sess-running')?.container_status).toBe('running');
    expect(find('sess-idle')?.container_status).toBe('idle');
    expect(find('sess-stale')?.container_status).toBe('stale');
    expect(find('sess-unknown')?.container_status).toBe('unknown');
  });

  it('test_sessions_member_only_returns_member_groups', async () => {
    insertSession('sess-1', 'ag-1');
    insertSession('sess-2', 'ag-2');
    const ctx = makeCtx('u1', { allowed_group_ids: ['ag-1'] });
    const resp = await sessionsHandler(makeReq(), {}, ctx);
    const body = (await resp!.json()) as { sessions: unknown[] };
    expect(body.sessions.length).toBe(1);
  });
});
