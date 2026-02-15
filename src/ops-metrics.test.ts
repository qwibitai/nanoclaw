import { beforeEach, describe, expect, it } from 'vitest';
import { _initTestDatabase } from './db.js';
import { createGovTask, createProduct, tryCreateDispatch, updateDispatchStatus } from './gov-db.js';
import { logExtCall } from './ext-broker-db.js';
import {
  countTasksByState,
  countTasksByProduct,
  countExtCallsByProvider,
  getWipLoad,
  getFailedDispatches,
  getL3CallsLast24h,
} from './ops-metrics.js';

const now = new Date().toISOString();

function makeTask(overrides: Partial<Parameters<typeof createGovTask>[0]> = {}) {
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  createGovTask({
    id,
    title: 'Test task',
    description: null,
    task_type: 'Feature',
    state: 'INBOX',
    priority: 'P2',
    product: null,
    product_id: null,
    scope: 'COMPANY',
    assigned_group: null,
    executor: null,
    created_by: 'main',
    gate: 'None',
    dod_required: 0,
    metadata: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
  return id;
}

function makeExtCall(overrides: Partial<Parameters<typeof logExtCall>[0]> = {}) {
  const requestId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  logExtCall({
    request_id: requestId,
    group_folder: 'developer',
    provider: 'github',
    action: 'repo.list',
    access_level: 1,
    params_hmac: 'test-hmac',
    params_summary: null,
    status: 'executed',
    denial_reason: null,
    result_summary: null,
    response_data: null,
    task_id: null,
    idempotency_key: null,
    duration_ms: 100,
    created_at: now,
    ...overrides,
  });
  return requestId;
}

beforeEach(() => {
  _initTestDatabase();
});

describe('countTasksByState', () => {
  it('returns correct counts after seeding', () => {
    makeTask({ state: 'READY' });
    makeTask({ state: 'READY' });
    makeTask({ state: 'READY' });
    makeTask({ state: 'DOING', assigned_group: 'developer' });
    makeTask({ state: 'DOING', assigned_group: 'developer' });
    makeTask({ state: 'DONE' });

    const counts = countTasksByState();
    const byState = Object.fromEntries(counts.map((c) => [c.state, c.count]));
    expect(byState.READY).toBe(3);
    expect(byState.DOING).toBe(2);
    expect(byState.DONE).toBe(1);
  });

  it('returns empty array when no tasks', () => {
    expect(countTasksByState()).toEqual([]);
  });
});

describe('countTasksByProduct', () => {
  it('groups by product_id including null', () => {
    createProduct({
      id: 'prod-a',
      name: 'Product A',
      status: 'active',
      risk_level: 'normal',
      created_at: now,
      updated_at: now,
    });
    makeTask({ product_id: 'prod-a', scope: 'PRODUCT' });
    makeTask({ product_id: 'prod-a', scope: 'PRODUCT' });
    makeTask({ product_id: null, scope: 'COMPANY' });

    const counts = countTasksByProduct();
    expect(counts.length).toBe(2);

    const prodA = counts.find((c) => c.product_id === 'prod-a');
    expect(prodA?.count).toBe(2);
    expect(prodA?.product_name).toBe('Product A');

    const nullProd = counts.find((c) => c.product_id === null);
    expect(nullProd?.count).toBe(1);
  });

  it('returns empty array when no tasks', () => {
    expect(countTasksByProduct()).toEqual([]);
  });
});

describe('countExtCallsByProvider', () => {
  it('counts across providers', () => {
    makeExtCall({ provider: 'github' });
    makeExtCall({ provider: 'github' });
    makeExtCall({ provider: 'cloud-logs', action: 'logs.query' });

    const counts = countExtCallsByProvider();
    expect(counts.length).toBe(2);

    const gh = counts.find((c) => c.provider === 'github');
    expect(gh?.count).toBe(2);

    const cl = counts.find((c) => c.provider === 'cloud-logs');
    expect(cl?.count).toBe(1);
  });

  it('returns empty array when no ext_calls', () => {
    expect(countExtCallsByProvider()).toEqual([]);
  });
});

describe('getWipLoad', () => {
  it('returns DOING count per group', () => {
    makeTask({ state: 'DOING', assigned_group: 'developer' });
    makeTask({ state: 'DOING', assigned_group: 'developer' });
    makeTask({ state: 'DOING', assigned_group: 'security' });
    makeTask({ state: 'READY', assigned_group: 'developer' }); // not DOING

    const wip = getWipLoad();
    const dev = wip.find((w) => w.group === 'developer');
    expect(dev?.doing_count).toBe(2);

    const sec = wip.find((w) => w.group === 'security');
    expect(sec?.doing_count).toBe(1);
  });

  it('excludes non-DOING states', () => {
    makeTask({ state: 'READY', assigned_group: 'developer' });
    makeTask({ state: 'INBOX' });
    expect(getWipLoad()).toEqual([]);
  });
});

describe('getFailedDispatches', () => {
  it('returns FAILED dispatches in desc order', () => {
    const earlier = '2026-02-14T10:00:00.000Z';
    const later = '2026-02-14T12:00:00.000Z';
    makeTask({ state: 'READY', assigned_group: 'developer' });

    tryCreateDispatch({
      task_id: 'task-fail-1',
      from_state: 'READY',
      to_state: 'DOING',
      dispatch_key: 'fail-1',
      group_jid: 'developer@jid',
      status: 'ENQUEUED',
      created_at: earlier,
      updated_at: earlier,
    });
    updateDispatchStatus('fail-1', 'FAILED');

    tryCreateDispatch({
      task_id: 'task-fail-2',
      from_state: 'READY',
      to_state: 'DOING',
      dispatch_key: 'fail-2',
      group_jid: 'developer@jid',
      status: 'ENQUEUED',
      created_at: later,
      updated_at: later,
    });
    updateDispatchStatus('fail-2', 'FAILED');

    const failed = getFailedDispatches();
    expect(failed.length).toBe(2);
    expect(failed[0].dispatch_key).toBe('fail-2'); // later first
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      tryCreateDispatch({
        task_id: `task-lim-${i}`,
        from_state: 'READY',
        to_state: 'DOING',
        dispatch_key: `lim-${i}`,
        group_jid: 'developer@jid',
        status: 'ENQUEUED',
        created_at: now,
        updated_at: now,
      });
      updateDispatchStatus(`lim-${i}`, 'FAILED');
    }
    expect(getFailedDispatches(3).length).toBe(3);
  });
});

describe('getL3CallsLast24h', () => {
  it('returns L3 calls within 24h window', () => {
    makeExtCall({ access_level: 3, created_at: new Date().toISOString() });
    makeExtCall({ access_level: 3, created_at: new Date().toISOString() });

    const l3 = getL3CallsLast24h();
    expect(l3.length).toBe(2);
  });

  it('excludes L1/L2 calls and old L3 calls', () => {
    makeExtCall({ access_level: 1 });
    makeExtCall({ access_level: 2 });
    // Old L3 call (2 days ago)
    const oldDate = new Date(Date.now() - 2 * 86_400_000).toISOString();
    makeExtCall({ access_level: 3, created_at: oldDate });

    expect(getL3CallsLast24h().length).toBe(0);
  });
});
