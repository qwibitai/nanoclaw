import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// Mock canAccessAgentGroup — needed by requireAuth in router.js
vi.mock('../../modules/permissions/access.js', () => ({
  canAccessAgentGroup: vi.fn(() => ({ allowed: true, reason: 'owner' })),
}));

// Mock router.js register to avoid polluting the route table
vi.mock('../router.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../router.js')>();
  return {
    ...orig,
    register: vi.fn(),
  };
});

import http from 'http';
import { closeDb, initTestDb, runMigrations, getDb } from '../../db/index.js';
import { authMeHandler } from './auth-me.js';
import { requireAuth, registerCookieVerifier, clearCookieVerifier } from '../router.js';
import * as accessMod from '../../modules/permissions/access.js';

function now(): string {
  return new Date().toISOString();
}

function insertUser(id: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'dashboard', NULL, ?)")
    .run(id, now());
}

function insertAgentGroup(id: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)')
    .run(id, id, id, now());
}

function insertRole(userId: string, role: string, agentGroupId: string | null): void {
  if (agentGroupId !== null) {
    getDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)',
      )
      .run(userId, role, agentGroupId, now());
  } else {
    getDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, NULL, NULL, ?)',
      )
      .run(userId, role, now());
  }
}

function makeNodeCtx() {
  return {
    rawNodeReq: {} as http.IncomingMessage,
  };
}

function makeReq(cookieHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (cookieHeader) headers['cookie'] = cookieHeader;
  return new Request('http://localhost:3000/dashboard/api/auth/me', { headers });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  vi.mocked(accessMod.canAccessAgentGroup).mockReturnValue({ allowed: true, reason: 'owner' });
});

afterEach(() => {
  closeDb();
  clearCookieVerifier();
  vi.clearAllMocks();
});

const authedHandler = requireAuth(authMeHandler);

describe('authMeHandler', () => {
  it('test_authMe_no_cookie_401', async () => {
    // No verifier → null payload → 401
    const req = makeReq();
    const res = await authedHandler(req, {}, makeNodeCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe('unauthenticated');
  });

  it('test_authMe_owner_returns_no_filter', async () => {
    insertUser('u1');
    insertRole('u1', 'owner', null);
    registerCookieVerifier(() => ({ user_id: 'u1', expires_at: '2099-01-01T00:00:00Z' }));
    vi.mocked(accessMod.canAccessAgentGroup).mockReturnValue({ allowed: true, reason: 'owner' });

    const req = makeReq('spawn_board=token');
    const res = await authedHandler(req, {}, makeNodeCtx());
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      user_id: string;
      scopes: { role: string; no_filter: boolean; allowed_group_ids: string[] };
    };
    expect(body.user_id).toBe('u1');
    expect(body.scopes.role).toBe('owner');
    expect(body.scopes.no_filter).toBe(true);
    expect(body.scopes.allowed_group_ids).toEqual([]);
  });

  it('test_authMe_scoped_admin_returns_group_ids', async () => {
    insertUser('u1');
    insertAgentGroup('ag-1');
    insertAgentGroup('ag-2');
    insertRole('u1', 'admin', 'ag-1');
    insertRole('u1', 'admin', 'ag-2');
    registerCookieVerifier(() => ({ user_id: 'u1', expires_at: '2099-01-01T00:00:00Z' }));
    vi.mocked(accessMod.canAccessAgentGroup).mockReturnValue({ allowed: true, reason: 'admin_of_group' });

    const req = makeReq('spawn_board=token');
    const res = await authedHandler(req, {}, makeNodeCtx());
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { user_id: string; scopes: { role: string; allowed_group_ids: string[] } };
    expect(body.scopes.role).toBe('admin_of_group');
    expect([...body.scopes.allowed_group_ids].sort()).toEqual(['ag-1', 'ag-2']);
  });

  it('test_authMe_member_only', async () => {
    insertUser('u1');
    insertAgentGroup('ag-1');
    // 'member' is not a valid UserRoleKind but we insert directly to test the handler
    getDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)',
      )
      .run('u1', 'member', 'ag-1', now());
    registerCookieVerifier(() => ({ user_id: 'u1', expires_at: '2099-01-01T00:00:00Z' }));
    vi.mocked(accessMod.canAccessAgentGroup).mockReturnValue({ allowed: false, reason: 'not_member' });

    const req = makeReq('spawn_board=token');
    const res = await authedHandler(req, {}, makeNodeCtx());
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      user_id: string;
      scopes: { role: string; allowed_group_ids: string[]; no_filter: boolean };
    };
    expect(body.scopes.role).toBe('member');
    expect(body.scopes.allowed_group_ids).toEqual(['ag-1']);
    expect(body.scopes.no_filter).toBe(false);
  });
});
