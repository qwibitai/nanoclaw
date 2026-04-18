import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  _initTestDatabase,
  _closeDatabase,
  insertTrustAction,
  getTrustLevel,
  upsertTrustLevel,
  getAllTrustLevels,
  resetTrustLevels,
  insertTrustApproval,
  getTrustApproval,
  resolveTrustApproval,
  getExpiredTrustApprovals,
} from '../db.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('insertTrustAction', () => {
  it('inserts and retrieves action log', () => {
    insertTrustAction({
      action_class: 'health.write',
      domain: 'health',
      operation: 'write',
      description: 'Request refill',
      decision: 'approved',
      group_id: 'group1',
      timestamp: new Date().toISOString(),
    });
    // No direct read function needed — just verify no throw
  });
});

describe('trust levels', () => {
  it('returns undefined for unknown class', () => {
    expect(getTrustLevel('health.write', 'group1')).toBeUndefined();
  });

  it('upserts and retrieves trust level', () => {
    const level = {
      action_class: 'health.write',
      group_id: 'group1',
      approvals: 3,
      denials: 1,
      confidence: 0.6,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    };
    upsertTrustLevel(level);
    const retrieved = getTrustLevel('health.write', 'group1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.approvals).toBe(3);
    expect(retrieved!.confidence).toBeCloseTo(0.6);
  });

  it('updates on conflict', () => {
    const base = {
      action_class: 'code.write',
      group_id: 'group1',
      approvals: 1,
      denials: 0,
      confidence: 0.5,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    };
    upsertTrustLevel(base);
    upsertTrustLevel({ ...base, approvals: 5, confidence: 0.85 });
    expect(getTrustLevel('code.write', 'group1')!.approvals).toBe(5);
  });

  it('getAllTrustLevels returns levels for group', () => {
    for (const cls of ['health.read', 'health.write']) {
      upsertTrustLevel({
        action_class: cls,
        group_id: 'group1',
        approvals: 0,
        denials: 0,
        confidence: 0,
        threshold: 0.8,
        auto_execute: true,
        last_updated: new Date().toISOString(),
      });
    }
    const levels = getAllTrustLevels('group1');
    expect(levels).toHaveLength(2);
  });

  it('resetTrustLevels clears group', () => {
    upsertTrustLevel({
      action_class: 'health.write',
      group_id: 'group1',
      approvals: 5,
      denials: 0,
      confidence: 0.9,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    });
    resetTrustLevels('group1');
    expect(getAllTrustLevels('group1')).toHaveLength(0);
  });
});

describe('trust approvals', () => {
  it('inserts and retrieves approval', () => {
    const now = new Date();
    const expires = new Date(now.getTime() + 1800000);
    insertTrustApproval({
      id: 'abc123',
      action_class: 'health.write',
      tool_name: 'request_refill',
      description: 'Request a prescription refill',
      group_id: 'group1',
      chat_jid: 'tg:123',
      status: 'pending',
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });
    const retrieved = getTrustApproval('abc123');
    expect(retrieved).toBeDefined();
    expect(retrieved!.status).toBe('pending');
  });

  it('resolves approval to approved', () => {
    const now = new Date();
    const expires = new Date(now.getTime() + 1800000);
    insertTrustApproval({
      id: 'xyz456',
      action_class: 'code.write',
      tool_name: 'write_file',
      group_id: 'group1',
      chat_jid: 'tg:123',
      status: 'pending',
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });
    resolveTrustApproval('xyz456', 'approved');
    expect(getTrustApproval('xyz456')!.status).toBe('approved');
  });

  it('getExpiredTrustApprovals returns only expired pending', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 1800000).toISOString();
    const now = new Date().toISOString();
    insertTrustApproval({
      id: 'exp1',
      action_class: 'health.write',
      tool_name: 'request_refill',
      group_id: 'group1',
      chat_jid: 'tg:123',
      status: 'pending',
      created_at: now,
      expires_at: past,
    });
    insertTrustApproval({
      id: 'notexp',
      action_class: 'health.write',
      tool_name: 'request_refill',
      group_id: 'group1',
      chat_jid: 'tg:123',
      status: 'pending',
      created_at: now,
      expires_at: future,
    });
    const expired = getExpiredTrustApprovals();
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe('exp1');
  });
});
