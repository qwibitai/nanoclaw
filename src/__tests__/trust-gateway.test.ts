import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _initTestDatabase,
  _closeDatabase,
  getTrustApproval,
  resolveTrustApproval,
  upsertTrustLevel,
  getAllTrustLevels,
} from '../db.js';
import { startTrustGateway } from '../trust-gateway.js';
import { eventBus } from '../event-bus.js';

let gateway: { close: () => void };
let port: number;

async function findFreePort(): Promise<number> {
  const { createServer } = await import('http');
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function get(path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, data: await res.json() };
}

beforeEach(async () => {
  _initTestDatabase();
  port = await findFreePort();
  gateway = startTrustGateway(port);
  // Give server a tick to bind
  await new Promise((r) => setTimeout(r, 50));
});

afterEach(() => {
  gateway.close();
  eventBus.removeAllListeners();
  _closeDatabase();
});

describe('POST /trust/evaluate', () => {
  it('returns approved for auto-approved action (high confidence)', async () => {
    // Set up trust level with high confidence so it auto-approves
    upsertTrustLevel({
      action_class: 'info.read',
      group_id: 'group1',
      approvals: 10,
      denials: 0,
      confidence: 0.92,
      threshold: 0.7,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    });

    const { status, data } = await post('/trust/evaluate', {
      action_class: 'info.read',
      tool_name: 'web_search',
      description: 'Search for weather',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });

    expect(status).toBe(200);
    expect(data.decision).toBe('approved');
    expect(data.reason).toContain('confidence');
  });

  it('returns pending for needs-approval action (cold start)', async () => {
    const events: unknown[] = [];
    eventBus.on('trust.request', (e) => events.push(e));

    const { status, data } = await post('/trust/evaluate', {
      action_class: 'health.write',
      tool_name: 'request_refill',
      description: 'Refill prescription',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });

    expect(status).toBe(200);
    expect(data.decision).toBe('pending');
    expect(data.approval_id).toBeDefined();
    expect(typeof data.approval_id).toBe('string');
    expect(data.timeout_s).toBe(1800);
    expect(events.length).toBe(1);
  });

  it('returns 400 for missing fields', async () => {
    const { status, data } = await post('/trust/evaluate', {
      tool_name: 'web_search',
      // missing group_id, chat_jid
    });

    expect(status).toBe(400);
    expect(data.error).toBeDefined();
  });

  it('returns 400 for empty body', async () => {
    const { status } = await post('/trust/evaluate', {});
    expect(status).toBe(400);
  });
});

describe('GET /trust/approval/:id', () => {
  it('returns pending when not yet resolved', async () => {
    // Create a pending approval via evaluate
    const { data: evalData } = await post('/trust/evaluate', {
      action_class: 'health.write',
      tool_name: 'request_refill',
      description: 'Refill prescription',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });

    const { status, data } = await get(
      `/trust/approval/${evalData.approval_id}`,
    );

    expect(status).toBe(200);
    expect(data.decision).toBe('pending');
  });

  it('returns approved after resolution', async () => {
    // Create a pending approval
    const { data: evalData } = await post('/trust/evaluate', {
      action_class: 'health.write',
      tool_name: 'request_refill',
      description: 'Refill prescription',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });

    // Resolve it
    resolveTrustApproval(evalData.approval_id, 'approved');

    const { status, data } = await get(
      `/trust/approval/${evalData.approval_id}`,
    );

    expect(status).toBe(200);
    expect(data.decision).toBe('approved');
  });

  it('returns 404 for unknown approval id', async () => {
    const { status, data } = await get('/trust/approval/nonexistent');

    expect(status).toBe(404);
    expect(data.error).toBeDefined();
  });
});

describe('GET /trust/status', () => {
  it('returns trust levels', async () => {
    upsertTrustLevel({
      action_class: 'info.read',
      group_id: 'group1',
      approvals: 5,
      denials: 0,
      confidence: 0.83,
      threshold: 0.7,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    });

    const { status, data } = await get('/trust/status?group_id=group1');

    expect(status).toBe(200);
    expect(data.levels).toBeDefined();
    expect(Array.isArray(data.levels)).toBe(true);
    expect(data.levels.length).toBe(1);
    expect(data.levels[0].action_class).toBe('info.read');
  });

  it('returns empty array when no levels exist', async () => {
    const { status, data } = await get('/trust/status?group_id=nonexistent');

    expect(status).toBe(200);
    expect(data.levels).toEqual([]);
  });
});

describe('timeout checker', () => {
  it('resolves expired approvals as timeout', async () => {
    // Create a pending approval that's already expired via evaluate
    // We'll manipulate the DB directly to set expires_at in the past
    const { data: evalData } = await post('/trust/evaluate', {
      action_class: 'health.write',
      tool_name: 'request_refill',
      description: 'Refill prescription',
      group_id: 'group1',
      chat_jid: 'tg:123',
    });

    // Manually set expires_at to the past
    const { getDb } = await import('../db.js');
    getDb()
      .prepare(`UPDATE trust_approvals SET expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), evalData.approval_id);

    // Trigger the timeout checker manually via the exported function
    const { checkExpiredApprovals } = await import('../trust-gateway.js');
    checkExpiredApprovals();

    // Verify it was resolved as timeout
    const approval = getTrustApproval(evalData.approval_id);
    expect(approval!.status).toBe('timeout');
  });
});
