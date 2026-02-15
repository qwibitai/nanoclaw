/**
 * External Access Broker — integration tests
 *
 * Tests the full auth flow: signature → backpressure → provider → capability →
 * expiry → access level → deny-wins → allowed list → L3 two-man → params →
 * idempotency → execute.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// vi.hoisted runs before vi.mock hoisting, so tmpDir is available
const { tmpDir } = vi.hoisted(() => {
  const _fs = require('fs');
  const _os = require('os');
  const _path = require('path');
  return { tmpDir: _fs.mkdtempSync(_path.join(_os.tmpdir(), 'nanoclaw-broker-test-')) };
});

vi.mock('./config.js', () => ({
  DATA_DIR: tmpDir,
  PROJECT_ROOT: tmpDir,
}));

import { _initTestDatabase } from './db.js';
import {
  grantCapability,
  getExtCallByRequestId,
  logExtCall,
  countPendingExtCalls,
} from './ext-broker-db.js';
import { registerProvider, type ExtProvider } from './ext-broker-providers.js';
import { processExtAccessIpc, type ExtAccessIpcData } from './ext-broker.js';
import { createGovApproval, createGovTask, createProduct } from './gov-db.js';

// --- Mock provider ---

const mockExecute = vi.fn().mockResolvedValue({
  ok: true,
  data: { result: 'test' },
  summary: 'Mock action executed',
});

const mockProvider: ExtProvider = {
  name: 'mock',
  requiredSecrets: [],
  actions: {
    read_stuff: {
      level: 1,
      description: 'Read stuff (L1)',
      params: z.object({ q: z.string().optional() }),
      execute: mockExecute,
      summarize: (p) => `read_stuff(${JSON.stringify(p)})`,
      idempotent: true,
    },
    write_stuff: {
      level: 2,
      description: 'Write stuff (L2)',
      params: z.object({ data: z.string() }),
      execute: mockExecute,
      summarize: (p) => `write_stuff(${JSON.stringify(p)})`,
      idempotent: false,
    },
    deploy_stuff: {
      level: 3,
      description: 'Deploy stuff (L3)',
      params: z.object({}),
      execute: mockExecute,
      summarize: () => 'deploy_stuff',
      idempotent: false,
    },
  },
};

// --- Helpers ---

function makeRequest(overrides?: Partial<ExtAccessIpcData>): ExtAccessIpcData {
  return {
    type: 'ext_call',
    request_id: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    provider: 'mock',
    action: 'read_stuff',
    params: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function grantMock(group: string, level: number, overrides?: Record<string, unknown>) {
  grantCapability({
    group_folder: group,
    provider: 'mock',
    access_level: level,
    allowed_actions: null,
    denied_actions: null,
    requires_task_gate: null,
    granted_by: 'main',
    granted_at: new Date().toISOString(),
    expires_at: null,
    active: 1,
    ...(overrides as Record<string, never>),
  });
}

function readResponse(group: string, requestId: string): Record<string, unknown> | null {
  const filePath = path.join(tmpDir, 'ipc', group, 'responses', `${requestId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeGroupSecret(group: string, secret: string) {
  const dir = path.join(tmpDir, 'ipc', group);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.ipc_secret'), secret);
}

function signRequest(data: ExtAccessIpcData, secret: string): string {
  const { sig: _sig, ...body } = data;
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

// --- Setup ---

function createSentinelTask() {
  const now = new Date().toISOString();
  createGovTask({
    id: '__ext_broker__',
    title: 'Sentinel',
    description: null,
    task_type: 'OPS',
    state: 'DONE',
    priority: 'P3',
    product: null,
    product_id: null,
    scope: 'COMPANY',
    assigned_group: 'main',
    executor: null,
    created_by: 'system',
    gate: 'None',
    dod_required: 0,
    metadata: null,
    created_at: now,
    updated_at: now,
  });
}

beforeEach(() => {
  _initTestDatabase();
  createSentinelTask();
  registerProvider(mockProvider);
  mockExecute.mockClear();
  mockExecute.mockResolvedValue({
    ok: true,
    data: { result: 'test' },
    summary: 'Mock action executed',
  });
  // Clear temp dirs
  const ipcDir = path.join(tmpDir, 'ipc');
  if (fs.existsSync(ipcDir)) {
    fs.rmSync(ipcDir, { recursive: true, force: true });
  }
  // Ensure EXT_REQUIRE_SIGNING is not set
  delete process.env.EXT_REQUIRE_SIGNING;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Smoke test ---

describe('ext_call smoke test', () => {
  it('executes a valid L1 call and writes response file', async () => {
    grantMock('developer', 1);

    const req = makeRequest({ request_id: 'ext-smoke-1' });
    await processExtAccessIpc(req, 'developer', false);

    // Check response file
    const response = readResponse('developer', 'ext-smoke-1');
    expect(response).not.toBeNull();
    expect(response!.status).toBe('executed');
    expect(response!.data).toEqual({ result: 'test' });

    // Check DB audit trail
    const call = getExtCallByRequestId('ext-smoke-1');
    expect(call).toBeDefined();
    expect(call!.status).toBe('executed');
    expect(call!.duration_ms).toBeGreaterThanOrEqual(0);

    // Provider execute was called
    expect(mockExecute).toHaveBeenCalledOnce();
  });
});

// --- Capability denial ---

describe('capability checks', () => {
  it('denies when no capability exists (L0 default)', async () => {
    const req = makeRequest({ request_id: 'ext-deny-nocap' });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-deny-nocap');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('No capability');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('denies when access level is insufficient', async () => {
    grantMock('developer', 1); // L1

    const req = makeRequest({
      request_id: 'ext-deny-level',
      action: 'write_stuff',
      params: { data: 'test' },
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-deny-level');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('Insufficient access');
  });

  it('denies when capability is expired', async () => {
    grantMock('developer', 2, {
      expires_at: new Date(Date.now() - 86_400_000).toISOString(), // expired yesterday
    });

    const req = makeRequest({ request_id: 'ext-deny-expired' });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-deny-expired');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('expired');
  });

  it('allows when capability is not yet expired', async () => {
    grantMock('developer', 1, {
      expires_at: new Date(Date.now() + 86_400_000).toISOString(), // tomorrow
    });

    const req = makeRequest({ request_id: 'ext-valid-expiry' });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-valid-expiry');
    expect(response!.status).toBe('executed');
  });
});

// --- Deny-wins (P0-5) ---

describe('deny-wins precedence (P0-5)', () => {
  it('denied_actions blocks even if action is in allowed_actions', async () => {
    grantMock('developer', 2, {
      allowed_actions: JSON.stringify(['read_stuff', 'write_stuff']),
      denied_actions: JSON.stringify(['read_stuff']),
    });

    const req = makeRequest({ request_id: 'ext-denywins' });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-denywins');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('explicitly denied');
  });

  it('allowed_actions restricts to listed actions', async () => {
    grantMock('developer', 2, {
      allowed_actions: JSON.stringify(['write_stuff']),
    });

    const req = makeRequest({
      request_id: 'ext-notallowed',
      action: 'read_stuff',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-notallowed');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('not in allowed list');
  });

  it('allowed_actions permits listed action', async () => {
    grantMock('developer', 1, {
      allowed_actions: JSON.stringify(['read_stuff']),
    });

    const req = makeRequest({ request_id: 'ext-allowed' });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-allowed');
    expect(response!.status).toBe('executed');
  });
});

// --- Backpressure (P0-1) ---

describe('backpressure (P0-1)', () => {
  it('denies with BUSY when pending count exceeds limit', async () => {
    grantMock('developer', 1);

    // Fill up pending slots (default MAX_PENDING_PER_GROUP = 5)
    for (let i = 0; i < 5; i++) {
      logExtCall({
        request_id: `ext-bp-fill-${i}`,
        group_folder: 'developer',
        provider: 'mock',
        action: 'read_stuff',
        access_level: 1,
        params_hmac: '',
        params_summary: null,
        status: 'processing',
        denial_reason: null,
        result_summary: null,
        response_data: null,
        task_id: null,
        idempotency_key: null,
        duration_ms: null,
        created_at: new Date().toISOString(),
      });
    }

    expect(countPendingExtCalls('developer')).toBe(5);

    const req = makeRequest({ request_id: 'ext-bp-rejected' });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-bp-rejected');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('BUSY');
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// --- L3 two-man rule (P0-2) ---

describe('L3 two-man rule (P0-2)', () => {
  beforeEach(() => {
    grantMock('developer', 3, { requires_task_gate: 'Security' });

    // Create a governance task for L3 reference
    createGovTask({
      id: 'gov-l3-test',
      title: 'L3 test task',
      description: null,
      task_type: 'FEATURE',
      state: 'APPROVAL',
      priority: 'P0',
      product: null,
      product_id: null,
      scope: 'COMPANY',
      assigned_group: 'developer',
      executor: null,
      created_by: 'main',
      gate: 'Security',
      dod_required: 0,
      metadata: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  it('denies L3 without task_id', async () => {
    const req = makeRequest({
      request_id: 'ext-l3-notask',
      action: 'deploy_stuff',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-l3-notask');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('requires task_id');
  });

  it('denies L3 without required gate approval', async () => {
    const req = makeRequest({
      request_id: 'ext-l3-nogate',
      action: 'deploy_stuff',
      task_id: 'gov-l3-test',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-l3-nogate');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('Security gate approval');
  });

  it('denies L3 with only 1 approver (need 2+)', async () => {
    createGovApproval({
      task_id: 'gov-l3-test',
      gate_type: 'Security',
      approved_by: 'security',
      approved_at: new Date().toISOString(),
      notes: 'LGTM',
    });

    const req = makeRequest({
      request_id: 'ext-l3-1approver',
      action: 'deploy_stuff',
      task_id: 'gov-l3-test',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-l3-1approver');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('two-man rule');
  });

  it('allows L3 with 2+ approvers from different groups', async () => {
    createGovApproval({
      task_id: 'gov-l3-test',
      gate_type: 'Security',
      approved_by: 'security',
      approved_at: new Date().toISOString(),
      notes: 'LGTM',
    });
    createGovApproval({
      task_id: 'gov-l3-test',
      gate_type: 'Product',
      approved_by: 'main',
      approved_at: new Date().toISOString(),
      notes: 'Approved',
    });

    const req = makeRequest({
      request_id: 'ext-l3-ok',
      action: 'deploy_stuff',
      task_id: 'gov-l3-test',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-l3-ok');
    expect(response!.status).toBe('executed');
    expect(mockExecute).toHaveBeenCalledOnce();
  });
});

// --- Broker coupling (task state + group validation) ---

describe('broker coupling', () => {
  function seedGovTask(id: string, state: string, assignedGroup: string, overrides?: Record<string, unknown>) {
    createGovTask({
      id,
      title: 'Coupling test',
      description: null,
      task_type: 'FEATURE',
      state: state as 'DOING',
      priority: 'P1',
      product: null,
      product_id: null,
      scope: 'COMPANY',
      assigned_group: assignedGroup,
      executor: null,
      created_by: 'main',
      gate: 'None',
      dod_required: 0,
      metadata: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    } as Parameters<typeof createGovTask>[0]);
  }

  it('allows L2 write when task is in DOING and group matches', async () => {
    grantMock('developer', 2);
    seedGovTask('task-doing', 'DOING', 'developer');

    const req = makeRequest({
      request_id: 'ext-coupling-ok',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'task-doing',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-coupling-ok');
    expect(response!.status).toBe('executed');
  });

  it('allows L2 write when task is in APPROVAL', async () => {
    grantMock('developer', 2);
    seedGovTask('task-approval', 'APPROVAL', 'developer');

    const req = makeRequest({
      request_id: 'ext-coupling-approval',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'task-approval',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-coupling-approval');
    expect(response!.status).toBe('executed');
  });

  it('denies L2 write when task is in INBOX (not active)', async () => {
    grantMock('developer', 2);
    seedGovTask('task-inbox', 'INBOX', 'developer');

    const req = makeRequest({
      request_id: 'ext-coupling-inbox',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'task-inbox',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-coupling-inbox');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('INBOX');
    expect(response!.error).toContain('DOING or APPROVAL');
  });

  it('denies L2 write when task is DONE (not active)', async () => {
    grantMock('developer', 2);
    seedGovTask('task-done', 'DONE', 'developer');

    const req = makeRequest({
      request_id: 'ext-coupling-done',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'task-done',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-coupling-done');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('DONE');
  });

  it('denies L2 write when group does not match assigned_group', async () => {
    grantMock('security', 2);
    seedGovTask('task-other-group', 'DOING', 'developer');

    const req = makeRequest({
      request_id: 'ext-coupling-wronggroup',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'task-other-group',
    });
    await processExtAccessIpc(req, 'security', false);

    const response = readResponse('security', 'ext-coupling-wronggroup');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('not assigned');
  });

  it('allows main group to write even when not assigned', async () => {
    grantMock('main', 2);
    seedGovTask('task-main-override', 'DOING', 'developer');

    const req = makeRequest({
      request_id: 'ext-coupling-main',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'task-main-override',
    });
    await processExtAccessIpc(req, 'main', true);

    const response = readResponse('main', 'ext-coupling-main');
    expect(response!.status).toBe('executed');
  });

  it('denies when task_id does not exist', async () => {
    grantMock('developer', 2);

    const req = makeRequest({
      request_id: 'ext-coupling-notask',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'nonexistent-task',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-coupling-notask');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('not found');
  });

  it('L1 read ignores task_id validation (coupling only for L2+)', async () => {
    grantMock('developer', 1);
    seedGovTask('task-for-read', 'DONE', 'developer');

    const req = makeRequest({
      request_id: 'ext-coupling-l1',
      action: 'read_stuff',
      task_id: 'task-for-read', // DONE state, but L1 should not care
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-coupling-l1');
    expect(response!.status).toBe('executed');
  });

  it('L2 write without task_id still works (coupling is opt-in)', async () => {
    grantMock('developer', 2);

    const req = makeRequest({
      request_id: 'ext-coupling-notaskid',
      action: 'write_stuff',
      params: { data: 'hello' },
      // no task_id
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-coupling-notaskid');
    expect(response!.status).toBe('executed');
  });
});

// --- Idempotency (P0-6) ---

describe('idempotency (P0-6)', () => {
  it('returns cached response for duplicate write with same idempotency_key', async () => {
    grantMock('developer', 2);

    // First call — executes
    const req1 = makeRequest({
      request_id: 'ext-idemp-first',
      action: 'write_stuff',
      params: { data: 'hello' },
      idempotency_key: 'key-42',
    });
    await processExtAccessIpc(req1, 'developer', false);
    expect(mockExecute).toHaveBeenCalledOnce();

    const resp1 = readResponse('developer', 'ext-idemp-first');
    expect(resp1!.status).toBe('executed');

    // Second call — should return cached
    mockExecute.mockClear();
    const req2 = makeRequest({
      request_id: 'ext-idemp-second',
      action: 'write_stuff',
      params: { data: 'hello' },
      idempotency_key: 'key-42',
    });
    await processExtAccessIpc(req2, 'developer', false);

    // Should NOT have called execute again
    expect(mockExecute).not.toHaveBeenCalled();

    const resp2 = readResponse('developer', 'ext-idemp-second');
    expect(resp2).not.toBeNull();
    // Cached response should contain the original data
    expect(resp2!.status).toBe('executed');
  });

  it('does not cache idempotent (read) actions', async () => {
    grantMock('developer', 1);

    // read_stuff is marked idempotent: true, so idempotency_key is ignored
    const req1 = makeRequest({
      request_id: 'ext-idemp-read1',
      idempotency_key: 'read-key',
    });
    await processExtAccessIpc(req1, 'developer', false);
    expect(mockExecute).toHaveBeenCalledOnce();

    mockExecute.mockClear();
    const req2 = makeRequest({
      request_id: 'ext-idemp-read2',
      idempotency_key: 'read-key',
    });
    await processExtAccessIpc(req2, 'developer', false);
    // Idempotent actions always execute (no caching)
    expect(mockExecute).toHaveBeenCalledOnce();
  });
});

// --- Request signing (P0-7) ---

describe('request signing (P0-7)', () => {
  it('denies unsigned request when group has secret', async () => {
    grantMock('developer', 1);
    writeGroupSecret('developer', 'my-secret-key');

    const req = makeRequest({ request_id: 'ext-unsigned' });
    // No sig field — should fail
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-unsigned');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('signature');
  });

  it('allows correctly signed request', async () => {
    grantMock('developer', 1);
    const secret = 'test-signing-key';
    writeGroupSecret('developer', secret);

    const req = makeRequest({ request_id: 'ext-signed-ok' });
    req.sig = signRequest(req, secret);

    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-signed-ok');
    expect(response!.status).toBe('executed');
  });

  it('denies request with wrong signature', async () => {
    grantMock('developer', 1);
    writeGroupSecret('developer', 'real-secret');

    const req = makeRequest({ request_id: 'ext-badsig' });
    req.sig = signRequest(req, 'wrong-secret');

    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-badsig');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('signature');
  });

  it('allows unsigned when no secret file exists (graceful mode)', async () => {
    grantMock('developer', 1);
    // No secret file created

    const req = makeRequest({ request_id: 'ext-nosecret' });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-nosecret');
    expect(response!.status).toBe('executed');
  });

  it('denies unsigned when EXT_REQUIRE_SIGNING=1 and no secret file', async () => {
    process.env.EXT_REQUIRE_SIGNING = '1';
    grantMock('developer', 1);

    const req = makeRequest({ request_id: 'ext-require-signing' });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-require-signing');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('signature');
  });
});

// --- Inflight lock (P0-8) ---

describe('inflight lock (P0-8)', () => {
  it('skips duplicate request_id silently', async () => {
    grantMock('developer', 1);

    // First call
    const req1 = makeRequest({ request_id: 'ext-inflight-1' });
    await processExtAccessIpc(req1, 'developer', false);
    expect(mockExecute).toHaveBeenCalledOnce();

    // Same request_id again — should be skipped
    mockExecute.mockClear();
    const req2 = makeRequest({ request_id: 'ext-inflight-1' });
    await processExtAccessIpc(req2, 'developer', false);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// --- Provider error handling ---

describe('provider error handling', () => {
  it('handles unknown provider', async () => {
    grantMock('developer', 1);

    const req = makeRequest({
      request_id: 'ext-unk-provider',
      provider: 'nonexistent',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-unk-provider');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('Unknown provider');
  });

  it('handles unknown action', async () => {
    grantMock('developer', 1);

    const req = makeRequest({
      request_id: 'ext-unk-action',
      action: 'nonexistent_action',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-unk-action');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('Unknown action');
  });

  it('handles invalid params (zod validation)', async () => {
    grantMock('developer', 2);

    const req = makeRequest({
      request_id: 'ext-bad-params',
      action: 'write_stuff',
      params: { /* missing required 'data' field */ },
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-bad-params');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('Invalid params');
  });

  it('handles provider execution failure', async () => {
    grantMock('developer', 1);
    mockExecute.mockResolvedValueOnce({
      ok: false,
      data: null,
      summary: 'API rate limited',
    });

    const req = makeRequest({ request_id: 'ext-provider-fail' });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-provider-fail');
    expect(response!.status).toBe('failed');

    const call = getExtCallByRequestId('ext-provider-fail');
    expect(call!.status).toBe('failed');
    expect(call!.result_summary).toBe('API rate limited');
  });

  it('handles provider execution exception', async () => {
    grantMock('developer', 1);
    mockExecute.mockRejectedValueOnce(new Error('Connection timeout'));

    const req = makeRequest({ request_id: 'ext-provider-throw' });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-provider-throw');
    expect(response!.status).toBe('failed');
    expect(response!.error).toContain('Connection timeout');

    const call = getExtCallByRequestId('ext-provider-throw');
    expect(call!.status).toBe('failed');
  });
});

// --- ext_grant ---

describe('ext_grant', () => {
  it('main can grant capability', async () => {
    await processExtAccessIpc(
      {
        type: 'ext_grant',
        group_folder: 'developer',
        provider: 'mock',
        access_level: 1,
      },
      'main',
      true,
    );

    const cap = (await import('./ext-broker-db.js')).getCapability('developer', 'mock');
    expect(cap).toBeDefined();
    expect(cap!.access_level).toBe(1);
  });

  it('non-main cannot grant', async () => {
    await processExtAccessIpc(
      {
        type: 'ext_grant',
        group_folder: 'security',
        provider: 'mock',
        access_level: 1,
      },
      'developer',
      false,
    );

    const cap = (await import('./ext-broker-db.js')).getCapability('security', 'mock');
    expect(cap).toBeUndefined();
  });

  it('L2 grant auto-sets expires_at', async () => {
    await processExtAccessIpc(
      {
        type: 'ext_grant',
        group_folder: 'developer',
        provider: 'mock',
        access_level: 2,
      },
      'main',
      true,
    );

    const cap = (await import('./ext-broker-db.js')).getCapability('developer', 'mock');
    expect(cap).toBeDefined();
    expect(cap!.expires_at).not.toBeNull();
    // Should expire ~7 days from now
    const expiryMs = new Date(cap!.expires_at!).getTime() - Date.now();
    expect(expiryMs).toBeGreaterThan(6 * 86_400_000);
    expect(expiryMs).toBeLessThan(8 * 86_400_000);
  });
});

// --- ext_revoke ---

describe('ext_revoke', () => {
  it('main can revoke capability', async () => {
    grantMock('developer', 1);

    await processExtAccessIpc(
      {
        type: 'ext_revoke',
        group_folder: 'developer',
        provider: 'mock',
      },
      'main',
      true,
    );

    const cap = (await import('./ext-broker-db.js')).getCapability('developer', 'mock');
    expect(cap).toBeUndefined();
  });

  it('non-main cannot revoke', async () => {
    grantMock('developer', 1);

    await processExtAccessIpc(
      {
        type: 'ext_revoke',
        group_folder: 'developer',
        provider: 'mock',
      },
      'developer',
      false,
    );

    // Should still exist
    const cap = (await import('./ext-broker-db.js')).getCapability('developer', 'mock');
    expect(cap).toBeDefined();
  });
});

// --- Missing fields ---

describe('missing fields', () => {
  it('ignores ext_call with no request_id', async () => {
    await processExtAccessIpc(
      { type: 'ext_call', provider: 'mock', action: 'read_stuff' },
      'developer',
      false,
    );
    // No crash, no response file
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('ignores ext_call with no provider', async () => {
    await processExtAccessIpc(
      { type: 'ext_call', request_id: 'ext-noprov', action: 'read_stuff' },
      'developer',
      false,
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// --- Sprint 2: Product scoping enforcement ---

describe('product scoping enforcement (Sprint 2)', () => {
  const now = new Date().toISOString();

  beforeEach(() => {
    createProduct({ id: 'ritmo', name: 'Ritmo', status: 'active', risk_level: 'normal', created_at: now, updated_at: now });
  });

  function seedProductTask(id: string, state: string, assignedGroup: string, productId: string | null, scope: string) {
    createGovTask({
      id,
      title: 'Product scoping test',
      description: null,
      task_type: 'FEATURE',
      state: state as 'DOING',
      priority: 'P1',
      product: null,
      product_id: productId,
      scope: scope as 'COMPANY',
      assigned_group: assignedGroup,
      executor: null,
      created_by: 'main',
      gate: 'None',
      dod_required: 0,
      metadata: null,
      created_at: now,
      updated_at: now,
    });
  }

  it('denies PRODUCT scope task without product_id (PRODUCT_SCOPE_REQUIRES_PRODUCT_ID)', async () => {
    grantMock('developer', 2);
    seedProductTask('ps-no-pid', 'DOING', 'developer', null, 'PRODUCT');

    const req = makeRequest({
      request_id: 'ext-ps-nopid',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'ps-no-pid',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-ps-nopid');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('PRODUCT_SCOPE_REQUIRES_PRODUCT_ID');
  });

  it('denies when capability product_id does not match task product_id (CAPABILITY_PRODUCT_MISMATCH)', async () => {
    createProduct({ id: 'other-prod', name: 'Other', status: 'active', risk_level: 'normal', created_at: now, updated_at: now });
    grantMock('developer', 2, { product_id: 'other-prod' });
    seedProductTask('ps-mismatch', 'DOING', 'developer', 'ritmo', 'PRODUCT');

    const req = makeRequest({
      request_id: 'ext-ps-mismatch',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'ps-mismatch',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-ps-mismatch');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('CAPABILITY_PRODUCT_MISMATCH');
  });

  it('denies non-main group using company-wide capability for PRODUCT task', async () => {
    grantMock('developer', 2); // company-wide (product_id=null)
    seedProductTask('ps-company-cap', 'DOING', 'developer', 'ritmo', 'PRODUCT');

    const req = makeRequest({
      request_id: 'ext-ps-companycap',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'ps-company-cap',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-ps-companycap');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('CAPABILITY_PRODUCT_MISMATCH');
  });

  it('allows main group to use company-wide capability for PRODUCT task', async () => {
    grantMock('main', 2); // company-wide (product_id=null)
    seedProductTask('ps-main-override', 'DOING', 'developer', 'ritmo', 'PRODUCT');

    const req = makeRequest({
      request_id: 'ext-ps-mainok',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'ps-main-override',
    });
    await processExtAccessIpc(req, 'main', true);

    const response = readResponse('main', 'ext-ps-mainok');
    expect(response!.status).toBe('executed');
  });

  it('allows product-specific capability matching task product_id', async () => {
    grantMock('developer', 2, { product_id: 'ritmo' });
    seedProductTask('ps-match', 'DOING', 'developer', 'ritmo', 'PRODUCT');

    const req = makeRequest({
      request_id: 'ext-ps-match',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'ps-match',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-ps-match');
    expect(response!.status).toBe('executed');
  });

  it('COMPANY scope task works with company-wide capability', async () => {
    grantMock('developer', 2); // company-wide
    seedProductTask('ps-company', 'DOING', 'developer', null, 'COMPANY');

    const req = makeRequest({
      request_id: 'ext-ps-company',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'ps-company',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-ps-company');
    expect(response!.status).toBe('executed');
  });

  it('stores product_id and scope on ext_call record', async () => {
    grantMock('developer', 2, { product_id: 'ritmo' });
    seedProductTask('ps-audit', 'DOING', 'developer', 'ritmo', 'PRODUCT');

    const req = makeRequest({
      request_id: 'ext-ps-audit',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'ps-audit',
    });
    await processExtAccessIpc(req, 'developer', false);

    const call = getExtCallByRequestId('ext-ps-audit');
    expect(call).toBeDefined();
    expect(call!.product_id).toBe('ritmo');
    expect(call!.scope).toBe('PRODUCT');
  });

  it('stores null product_id and scope for COMPANY task', async () => {
    grantMock('developer', 2);
    seedProductTask('ps-audit-comp', 'DOING', 'developer', null, 'COMPANY');

    const req = makeRequest({
      request_id: 'ext-ps-audit-comp',
      action: 'write_stuff',
      params: { data: 'hello' },
      task_id: 'ps-audit-comp',
    });
    await processExtAccessIpc(req, 'developer', false);

    const call = getExtCallByRequestId('ext-ps-audit-comp');
    expect(call).toBeDefined();
    expect(call!.product_id).toBeNull();
    expect(call!.scope).toBe('COMPANY');
  });
});

// --- Sprint 3: Enterprise multi-product guardrails ---

describe('enterprise multi-product guardrails (Sprint 3)', () => {
  const now = new Date().toISOString();

  beforeEach(() => {
    createProduct({ id: 'prod-alpha', name: 'Alpha', status: 'active', risk_level: 'high', created_at: now, updated_at: now });
    createProduct({ id: 'prod-beta', name: 'Beta', status: 'active', risk_level: 'normal', created_at: now, updated_at: now });
  });

  function seedProductTask(id: string, state: string, assignedGroup: string, productId: string | null, scope: string) {
    createGovTask({
      id,
      title: 'Enterprise guardrail test',
      description: null,
      task_type: 'FEATURE',
      state: state as 'DOING',
      priority: 'P1',
      product: null,
      product_id: productId,
      scope: scope as 'COMPANY',
      assigned_group: assignedGroup,
      executor: null,
      created_by: 'main',
      gate: 'Security',
      dod_required: 0,
      metadata: null,
      created_at: now,
      updated_at: now,
    });
  }

  it('cross-product denial: task prod-alpha cannot use capability for prod-beta', async () => {
    grantMock('developer', 2, { product_id: 'prod-beta' });
    seedProductTask('ent-cross', 'DOING', 'developer', 'prod-alpha', 'PRODUCT');

    const req = makeRequest({
      request_id: 'ext-ent-cross',
      action: 'write_stuff',
      params: { data: 'cross' },
      task_id: 'ent-cross',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-ent-cross');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('CAPABILITY_PRODUCT_MISMATCH');
    expect(response!.error).toContain('prod-beta');
    expect(response!.error).toContain('prod-alpha');
  });

  it('main override logs product_id from task on ext_call record', async () => {
    grantMock('main', 2); // company-wide cap
    seedProductTask('ent-main-audit', 'DOING', 'developer', 'prod-alpha', 'PRODUCT');

    const req = makeRequest({
      request_id: 'ext-ent-main-audit',
      action: 'write_stuff',
      params: { data: 'override' },
      task_id: 'ent-main-audit',
    });
    await processExtAccessIpc(req, 'main', true);

    const response = readResponse('main', 'ext-ent-main-audit');
    expect(response!.status).toBe('executed');

    const call = getExtCallByRequestId('ext-ent-main-audit');
    expect(call!.product_id).toBe('prod-alpha');
    expect(call!.scope).toBe('PRODUCT');
  });

  it('L3 COMPANY scope two-man rule: denied without approvals, allowed with 2', async () => {
    grantMock('developer', 3, { requires_task_gate: 'Security' });
    seedProductTask('ent-l3-company', 'APPROVAL', 'developer', null, 'COMPANY');

    // Attempt without approvals — denied
    const req1 = makeRequest({
      request_id: 'ext-ent-l3-noapp',
      action: 'deploy_stuff',
      task_id: 'ent-l3-company',
    });
    await processExtAccessIpc(req1, 'developer', false);
    const resp1 = readResponse('developer', 'ext-ent-l3-noapp');
    expect(resp1!.status).toBe('denied');
    expect(resp1!.error).toContain('gate approval');

    // Add 2 approvals from different groups
    createGovApproval({ task_id: 'ent-l3-company', gate_type: 'Security', approved_by: 'security', approved_at: now, notes: null });
    createGovApproval({ task_id: 'ent-l3-company', gate_type: 'Product', approved_by: 'main', approved_at: now, notes: null });

    // Now allowed
    const req2 = makeRequest({
      request_id: 'ext-ent-l3-ok',
      action: 'deploy_stuff',
      task_id: 'ent-l3-company',
    });
    await processExtAccessIpc(req2, 'developer', false);
    const resp2 = readResponse('developer', 'ext-ent-l3-ok');
    expect(resp2!.status).toBe('executed');
  });

  it('cross-product isolation end-to-end: cap for alpha, task for beta → denied', async () => {
    grantMock('developer', 2, { product_id: 'prod-alpha' });
    seedProductTask('ent-iso', 'DOING', 'developer', 'prod-beta', 'PRODUCT');

    const req = makeRequest({
      request_id: 'ext-ent-iso',
      action: 'write_stuff',
      params: { data: 'isolated' },
      task_id: 'ent-iso',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-ent-iso');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('CAPABILITY_PRODUCT_MISMATCH');
  });

  it('non-main with company-wide cap denied for PRODUCT task (isolation)', async () => {
    grantMock('security', 2); // company-wide
    seedProductTask('ent-nonmain', 'DOING', 'security', 'prod-alpha', 'PRODUCT');

    const req = makeRequest({
      request_id: 'ext-ent-nonmain',
      action: 'write_stuff',
      params: { data: 'attempt' },
      task_id: 'ent-nonmain',
    });
    await processExtAccessIpc(req, 'security', false);

    const response = readResponse('security', 'ext-ent-nonmain');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('company-wide capability cannot be used for PRODUCT task');
  });

  it('L3 with COMPANY scope still enforces two-man rule', async () => {
    grantMock('developer', 3, { requires_task_gate: 'Security' });
    seedProductTask('ent-l3-twoman', 'APPROVAL', 'developer', null, 'COMPANY');

    // Only 1 approval — denied
    createGovApproval({ task_id: 'ent-l3-twoman', gate_type: 'Security', approved_by: 'security', approved_at: now, notes: null });

    const req = makeRequest({
      request_id: 'ext-ent-l3-1only',
      action: 'deploy_stuff',
      task_id: 'ent-l3-twoman',
    });
    await processExtAccessIpc(req, 'developer', false);

    const response = readResponse('developer', 'ext-ent-l3-1only');
    expect(response!.status).toBe('denied');
    expect(response!.error).toContain('two-man rule');
  });
});
