/**
 * Disaster Recovery Simulation Tests
 *
 * Verifies crash-safety and dispatch idempotency by exercising the
 * governance building blocks: tryCreateDispatch, updateGovTask,
 * getDispatchableGovTasks, getReviewableGovTasks.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { _initTestDatabase } from './db.js';
import {
  createGovTask,
  getDispatchableGovTasks,
  getGovTaskById,
  getReviewableGovTasks,
  tryCreateDispatch,
  updateGovTask,
} from './gov-db.js';
import { logExtCall } from './ext-broker-db.js';
import { snapshotTableCounts } from './backup.js';
import { getDb } from './db.js';

const now = new Date().toISOString();

function seedTask(overrides: Partial<Parameters<typeof createGovTask>[0]>) {
  const id = overrides.id || `task-${Math.random().toString(36).slice(2, 8)}`;
  createGovTask({
    id,
    title: `DR Task ${id}`,
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

/** Simulate one dispatch cycle for READY tasks */
function dispatchReadyCycle() {
  const ready = getDispatchableGovTasks();
  let dispatched = 0;
  for (const task of ready) {
    const dispatchKey = `${task.id}:READY->DOING:v${task.version}`;
    const claimed = tryCreateDispatch({
      task_id: task.id,
      from_state: 'READY',
      to_state: 'DOING',
      dispatch_key: dispatchKey,
      group_jid: `${task.assigned_group}@jid`,
      status: 'ENQUEUED',
      created_at: now,
      updated_at: now,
    });
    if (claimed) {
      updateGovTask(task.id, task.version, { state: 'DOING' });
      dispatched++;
    }
  }
  return dispatched;
}

/** Simulate one dispatch cycle for REVIEW tasks */
function dispatchReviewCycle() {
  const reviewable = getReviewableGovTasks();
  let dispatched = 0;
  for (const task of reviewable) {
    const dispatchKey = `${task.id}:REVIEW->APPROVAL:v${task.version}`;
    const claimed = tryCreateDispatch({
      task_id: task.id,
      from_state: 'REVIEW',
      to_state: 'APPROVAL',
      dispatch_key: dispatchKey,
      group_jid: `security@jid`,
      status: 'ENQUEUED',
      created_at: now,
      updated_at: now,
    });
    if (claimed) {
      updateGovTask(task.id, task.version, { state: 'APPROVAL' });
      dispatched++;
    }
  }
  return dispatched;
}

beforeEach(() => {
  _initTestDatabase();
});

describe('disaster recovery simulation', () => {
  it('dispatches READY tasks exactly once across double-run', () => {
    seedTask({ id: 'dr-r1', state: 'READY', assigned_group: 'developer' });
    seedTask({ id: 'dr-r2', state: 'READY', assigned_group: 'developer' });
    seedTask({ id: 'dr-r3', state: 'READY', assigned_group: 'security' });
    seedTask({ id: 'dr-doing', state: 'DOING', assigned_group: 'developer' });
    seedTask({ id: 'dr-approval', state: 'APPROVAL', assigned_group: 'developer', gate: 'Security' });

    // First dispatch cycle
    const first = dispatchReadyCycle();
    expect(first).toBe(3);

    // Second cycle (simulates restart)
    const second = dispatchReadyCycle();
    expect(second).toBe(0);

    // All 3 READY tasks now in DOING
    expect(getGovTaskById('dr-r1')?.state).toBe('DOING');
    expect(getGovTaskById('dr-r2')?.state).toBe('DOING');
    expect(getGovTaskById('dr-r3')?.state).toBe('DOING');

    // Original DOING and APPROVAL unchanged
    expect(getGovTaskById('dr-doing')?.state).toBe('DOING');
    expect(getGovTaskById('dr-approval')?.state).toBe('APPROVAL');
  });

  it('tryCreateDispatch returns true first time, false second', () => {
    seedTask({ id: 'dr-idem', state: 'READY', assigned_group: 'developer' });
    const key = 'dr-idem:READY->DOING:v0';

    const first = tryCreateDispatch({
      task_id: 'dr-idem',
      from_state: 'READY',
      to_state: 'DOING',
      dispatch_key: key,
      group_jid: 'developer@jid',
      status: 'ENQUEUED',
      created_at: now,
      updated_at: now,
    });
    expect(first).toBe(true);

    const second = tryCreateDispatch({
      task_id: 'dr-idem',
      from_state: 'READY',
      to_state: 'DOING',
      dispatch_key: key,
      group_jid: 'developer@jid',
      status: 'ENQUEUED',
      created_at: now,
      updated_at: now,
    });
    expect(second).toBe(false);
  });

  it('version conflict blocks stale dispatch', () => {
    seedTask({ id: 'dr-stale', state: 'READY', assigned_group: 'developer' });
    const task = getGovTaskById('dr-stale')!;

    // First update succeeds
    const ok = updateGovTask('dr-stale', task.version, { state: 'DOING' });
    expect(ok).toBe(true);

    // Second update with stale version fails
    const stale = updateGovTask('dr-stale', task.version, { state: 'REVIEW' });
    expect(stale).toBe(false);

    // Task is still in DOING (first update won)
    expect(getGovTaskById('dr-stale')?.state).toBe('DOING');
  });

  it('REVIEW→APPROVAL dispatch is idempotent', () => {
    seedTask({ id: 'dr-rev', state: 'REVIEW', assigned_group: 'developer', gate: 'Security' });

    const first = dispatchReviewCycle();
    expect(first).toBe(1);

    const second = dispatchReviewCycle();
    expect(second).toBe(0);

    expect(getGovTaskById('dr-rev')?.state).toBe('APPROVAL');
  });

  it('full DR snapshot: table counts consistent before/after dispatch', () => {
    seedTask({ id: 'dr-s1', state: 'READY', assigned_group: 'developer' });
    seedTask({ id: 'dr-s2', state: 'READY', assigned_group: 'developer' });
    seedTask({ id: 'dr-s3', state: 'READY', assigned_group: 'security' });
    seedTask({ id: 'dr-s4', state: 'DOING', assigned_group: 'developer' });
    seedTask({ id: 'dr-s5', state: 'APPROVAL', assigned_group: 'developer', gate: 'Security' });

    logExtCall({
      request_id: 'dr-ext-1',
      group_folder: 'developer',
      provider: 'github',
      action: 'repo.list',
      access_level: 1,
      params_hmac: 'hmac',
      params_summary: null,
      status: 'executed',
      denial_reason: null,
      result_summary: null,
      response_data: null,
      task_id: 'dr-s4',
      idempotency_key: null,
      duration_ms: 50,
      created_at: now,
    });
    logExtCall({
      request_id: 'dr-ext-2',
      group_folder: 'security',
      provider: 'github',
      action: 'repo.get_file',
      access_level: 1,
      params_hmac: 'hmac',
      params_summary: null,
      status: 'executed',
      denial_reason: null,
      result_summary: null,
      response_data: null,
      task_id: 'dr-s5',
      idempotency_key: null,
      duration_ms: 75,
      created_at: now,
    });

    const db = getDb();
    const before = snapshotTableCounts(db);
    expect(before.gov_tasks).toBe(5);
    expect(before.ext_calls).toBe(2);
    expect(before.gov_dispatches).toBe(0);

    // Dispatch cycle
    dispatchReadyCycle();

    const after = snapshotTableCounts(db);
    expect(after.gov_tasks).toBe(5); // same task count (state changed, not added)
    expect(after.ext_calls).toBe(2); // ext_calls untouched
    expect(after.gov_dispatches).toBe(3); // exactly 3 dispatches (one per READY task)
  });
});
