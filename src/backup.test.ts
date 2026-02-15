import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { _initTestDatabase, getDb } from './db.js';
import {
  createGovTask,
  createGovApproval,
  createProduct,
  logGovActivity,
  tryCreateDispatch,
} from './gov-db.js';
import { grantCapability, logExtCall } from './ext-broker-db.js';
import { snapshotTableCounts, exportGovData, importGovData } from './backup.js';
import { createGovSchema } from './gov-db.js';
import { createExtAccessSchema } from './ext-broker-db.js';

const now = new Date().toISOString();

beforeEach(() => {
  _initTestDatabase();
});

function seedFullData() {
  // Product
  createProduct({
    id: 'prod-backup',
    name: 'Backup Test Product',
    status: 'active',
    risk_level: 'normal',
    created_at: now,
    updated_at: now,
  });

  // Gov tasks
  createGovTask({
    id: 'task-1',
    title: 'Task One',
    description: null,
    task_type: 'Feature',
    state: 'DOING',
    priority: 'P1',
    product: null,
    product_id: 'prod-backup',
    scope: 'PRODUCT',
    assigned_group: 'developer',
    executor: null,
    created_by: 'main',
    gate: 'Security',
    dod_required: 0,
    metadata: null,
    created_at: now,
    updated_at: now,
  });
  createGovTask({
    id: 'task-2',
    title: 'Task Two',
    description: null,
    task_type: 'BUG',
    state: 'REVIEW',
    priority: 'P2',
    product: null,
    product_id: null,
    scope: 'COMPANY',
    assigned_group: 'developer',
    executor: null,
    created_by: 'main',
    gate: 'None',
    dod_required: 0,
    metadata: null,
    created_at: now,
    updated_at: now,
  });

  // Activity
  logGovActivity({
    task_id: 'task-1',
    action: 'transition',
    from_state: 'READY',
    to_state: 'DOING',
    actor: 'developer',
    reason: 'Starting work',
    created_at: now,
  });

  // Approval
  createGovApproval({
    task_id: 'task-1',
    gate_type: 'Security',
    approved_by: 'security',
    approved_at: now,
    notes: 'Looks good',
  });

  // Dispatch
  tryCreateDispatch({
    task_id: 'task-1',
    from_state: 'READY',
    to_state: 'DOING',
    dispatch_key: 'task-1:READY->DOING:v0',
    group_jid: 'developer@jid',
    status: 'DONE',
    created_at: now,
    updated_at: now,
  });

  // Ext capability
  grantCapability({
    group_folder: 'developer',
    provider: 'github',
    access_level: 2,
    allowed_actions: null,
    denied_actions: null,
    requires_task_gate: 'Security',
    granted_by: 'main',
    granted_at: now,
    expires_at: null,
    active: 1,
  });

  // Ext call
  logExtCall({
    request_id: 'ext-backup-1',
    group_folder: 'developer',
    provider: 'github',
    action: 'repo.list',
    access_level: 1,
    params_hmac: 'hmac-test',
    params_summary: null,
    status: 'executed',
    denial_reason: null,
    result_summary: 'Listed 3 repos',
    response_data: null,
    task_id: 'task-1',
    idempotency_key: null,
    duration_ms: 100,
    created_at: now,
  });
}

describe('snapshotTableCounts', () => {
  it('returns 0 for empty tables', () => {
    const counts = snapshotTableCounts(getDb());
    expect(counts.products).toBe(0);
    expect(counts.gov_tasks).toBe(0);
    expect(counts.gov_activities).toBe(0);
    expect(counts.gov_approvals).toBe(0);
    expect(counts.gov_dispatches).toBe(0);
    expect(counts.ext_capabilities).toBe(0);
    expect(counts.ext_calls).toBe(0);
  });

  it('returns correct counts after seeding', () => {
    seedFullData();
    const counts = snapshotTableCounts(getDb());
    expect(counts.products).toBe(1);
    expect(counts.gov_tasks).toBe(2);
    expect(counts.gov_activities).toBe(1);
    expect(counts.gov_approvals).toBe(1);
    expect(counts.gov_dispatches).toBe(1);
    expect(counts.ext_capabilities).toBe(1);
    expect(counts.ext_calls).toBe(1);
  });

  it('covers all 7 governance tables', () => {
    const counts = snapshotTableCounts(getDb());
    expect(Object.keys(counts).length).toBe(7);
    expect(Object.keys(counts).sort()).toEqual([
      'ext_calls',
      'ext_capabilities',
      'gov_activities',
      'gov_approvals',
      'gov_dispatches',
      'gov_tasks',
      'products',
    ]);
  });
});

describe('exportGovData + importGovData round-trip', () => {
  it('preserves counts after export→import', () => {
    seedFullData();
    const sourceDb = getDb();
    const exported = exportGovData(sourceDb);
    const sourceCounts = snapshotTableCounts(sourceDb);

    // Create fresh target DB
    const targetDb = new Database(':memory:');
    createGovSchema(targetDb);
    createExtAccessSchema(targetDb);

    importGovData(targetDb, exported);
    const targetCounts = snapshotTableCounts(targetDb);

    expect(targetCounts).toEqual(sourceCounts);
    targetDb.close();
  });

  it('preserves approval records exactly', () => {
    seedFullData();
    const sourceDb = getDb();
    const exported = exportGovData(sourceDb);

    const targetDb = new Database(':memory:');
    createGovSchema(targetDb);
    createExtAccessSchema(targetDb);
    importGovData(targetDb, exported);

    const approvals = targetDb.prepare('SELECT * FROM gov_approvals').all() as Record<string, unknown>[];
    expect(approvals.length).toBe(1);
    expect(approvals[0].gate_type).toBe('Security');
    expect(approvals[0].approved_by).toBe('security');
    expect(approvals[0].notes).toBe('Looks good');
    targetDb.close();
  });

  it('preserves ext_call records', () => {
    seedFullData();
    const sourceDb = getDb();
    const exported = exportGovData(sourceDb);

    const targetDb = new Database(':memory:');
    createGovSchema(targetDb);
    createExtAccessSchema(targetDb);
    importGovData(targetDb, exported);

    const calls = targetDb.prepare('SELECT * FROM ext_calls').all() as Record<string, unknown>[];
    expect(calls.length).toBe(1);
    expect(calls[0].request_id).toBe('ext-backup-1');
    expect(calls[0].provider).toBe('github');
    expect(calls[0].result_summary).toBe('Listed 3 repos');
    targetDb.close();
  });

  it('handles empty database gracefully', () => {
    const exported = exportGovData(getDb());
    for (const rows of Object.values(exported)) {
      expect(rows).toEqual([]);
    }
  });

  it('is idempotent — importing same data twice produces same counts', () => {
    seedFullData();
    const sourceDb = getDb();
    const exported = exportGovData(sourceDb);

    const targetDb = new Database(':memory:');
    createGovSchema(targetDb);
    createExtAccessSchema(targetDb);
    importGovData(targetDb, exported);
    const firstCounts = snapshotTableCounts(targetDb);

    importGovData(targetDb, exported); // second import
    const secondCounts = snapshotTableCounts(targetDb);

    expect(secondCounts).toEqual(firstCounts);
    targetDb.close();
  });
});
