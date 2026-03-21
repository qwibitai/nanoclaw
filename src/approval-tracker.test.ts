import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalTracker } from './approval-tracker.js';
import type { TrustDecision } from './approval-tracker.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS trust_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_source TEXT NOT NULL,
    routing TEXT NOT NULL,
    trust_rule_id TEXT,
    classification_summary TEXT,
    classification_importance REAL,
    classification_urgency TEXT,
    user_response TEXT,
    user_feedback TEXT,
    responded_at TEXT,
    telegram_msg_id TEXT
  );
`;

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.prepare(SCHEMA).run();
  return db;
}

const sampleDecision: TrustDecision = {
  eventType: 'email',
  eventSource: 'inbox',
  routing: 'draft',
  trustRuleId: 'rule-a',
  classificationSummary: 'Grant application deadline',
  classificationImportance: 0.9,
  classificationUrgency: 'high',
};

let db: InstanceType<typeof Database>;
let tracker: ApprovalTracker;

beforeEach(() => {
  db = createTestDb();
  tracker = new ApprovalTracker(db);
});

describe('recordDecision', () => {
  it('returns a positive integer ID', () => {
    const id = tracker.recordDecision(sampleDecision);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('increments ID on subsequent inserts', () => {
    const id1 = tracker.recordDecision(sampleDecision);
    const id2 = tracker.recordDecision(sampleDecision);
    expect(id2).toBeGreaterThan(id1);
  });
});

describe('recordResponse', () => {
  it('stores approved response', () => {
    const id = tracker.recordDecision(sampleDecision);
    tracker.recordResponse(id, 'approved');
    const rows = tracker.getRecentDecisions(10);
    const row = rows.find((r) => r.id === id);
    expect(row?.user_response).toBe('approved');
    expect(row?.responded_at).toBeTruthy();
  });

  it('stores rejected response', () => {
    const id = tracker.recordDecision(sampleDecision);
    tracker.recordResponse(id, 'rejected');
    const rows = tracker.getRecentDecisions(10);
    const row = rows.find((r) => r.id === id);
    expect(row?.user_response).toBe('rejected');
  });

  it('stores optional feedback', () => {
    const id = tracker.recordDecision(sampleDecision);
    tracker.recordResponse(id, 'approved', 'looks good');
    const rows = tracker.getRecentDecisions(10);
    const row = rows.find((r) => r.id === id);
    expect(row?.user_feedback).toBe('looks good');
  });
});

describe('getPendingApprovals', () => {
  it('returns only routing=draft with null user_response', () => {
    const id1 = tracker.recordDecision({ ...sampleDecision, routing: 'draft' });
    const id2 = tracker.recordDecision({ ...sampleDecision, routing: 'draft' });
    tracker.recordDecision({ ...sampleDecision, routing: 'send' });

    tracker.recordResponse(id2, 'approved');

    const pending = tracker.getPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id1);
    expect(pending[0].routing).toBe('draft');
    expect(pending[0].user_response).toBeNull();
  });

  it('returns empty when no pending decisions', () => {
    const id = tracker.recordDecision(sampleDecision);
    tracker.recordResponse(id, 'rejected');
    expect(tracker.getPendingApprovals()).toHaveLength(0);
  });
});

describe('getApprovalStats', () => {
  it('groups by trust_rule_id and computes rate', () => {
    const idA1 = tracker.recordDecision({ ...sampleDecision, trustRuleId: 'rule-a' });
    const idA2 = tracker.recordDecision({ ...sampleDecision, trustRuleId: 'rule-a' });
    const idB1 = tracker.recordDecision({ ...sampleDecision, trustRuleId: 'rule-b' });

    tracker.recordResponse(idA1, 'approved');
    tracker.recordResponse(idA2, 'rejected');
    tracker.recordResponse(idB1, 'approved');

    const stats = tracker.getApprovalStats(30);
    const statA = stats.find((s) => s.trustRuleId === 'rule-a');
    const statB = stats.find((s) => s.trustRuleId === 'rule-b');

    expect(statA).toBeDefined();
    expect(statA!.total).toBe(2);
    expect(statA!.approved).toBe(1);
    expect(statA!.rate).toBeCloseTo(0.5);

    expect(statB).toBeDefined();
    expect(statB!.total).toBe(1);
    expect(statB!.approved).toBe(1);
    expect(statB!.rate).toBeCloseTo(1.0);
  });

  it('excludes expired decisions from denominator', () => {
    const idA = tracker.recordDecision({ ...sampleDecision, trustRuleId: 'rule-c' });
    const idB = tracker.recordDecision({ ...sampleDecision, trustRuleId: 'rule-c' });

    tracker.recordResponse(idA, 'approved');
    tracker.recordResponse(idB, 'expired');

    const stats = tracker.getApprovalStats(30);
    const stat = stats.find((s) => s.trustRuleId === 'rule-c');

    // expired is excluded, so only idA counts
    expect(stat?.total).toBe(1);
    expect(stat?.approved).toBe(1);
    expect(stat?.rate).toBeCloseTo(1.0);
  });

  it('excludes pending (null) decisions from stats', () => {
    // pending decision with no response — should not appear in stats
    tracker.recordDecision({ ...sampleDecision, trustRuleId: 'rule-d' });

    const stats = tracker.getApprovalStats(30);
    const stat = stats.find((s) => s.trustRuleId === 'rule-d');
    expect(stat).toBeUndefined();
  });
});

describe('setTelegramMsgId and findByTelegramMsgId', () => {
  it('stores and retrieves decision by Telegram msg ID', () => {
    const id = tracker.recordDecision(sampleDecision);
    tracker.setTelegramMsgId(id, 'tg-msg-999');

    const found = tracker.findByTelegramMsgId('tg-msg-999');
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
    expect(found!.telegram_msg_id).toBe('tg-msg-999');
  });

  it('returns undefined for unknown Telegram msg ID', () => {
    const found = tracker.findByTelegramMsgId('nonexistent');
    expect(found).toBeUndefined();
  });
});

describe('expireStaleApprovals', () => {
  it('expires old pending decisions', () => {
    const id = tracker.recordDecision({ ...sampleDecision, routing: 'draft' });

    // Manually back-date the timestamp to 25 hours ago
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE trust_decisions SET timestamp = ? WHERE id = ?').run(staleTime, id);

    const expired = tracker.expireStaleApprovals(24);
    expect(expired).toBe(1);

    const pending = tracker.getPendingApprovals();
    expect(pending).toHaveLength(0);

    const rows = tracker.getRecentDecisions(10);
    const row = rows.find((r) => r.id === id);
    expect(row?.user_response).toBe('expired');
  });

  it('does not expire recent pending decisions', () => {
    tracker.recordDecision({ ...sampleDecision, routing: 'draft' });

    const expired = tracker.expireStaleApprovals(24);
    expect(expired).toBe(0);

    expect(tracker.getPendingApprovals()).toHaveLength(1);
  });

  it('does not expire already-responded decisions', () => {
    const id = tracker.recordDecision({ ...sampleDecision, routing: 'draft' });
    tracker.recordResponse(id, 'approved');

    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE trust_decisions SET timestamp = ? WHERE id = ?').run(staleTime, id);

    const expired = tracker.expireStaleApprovals(24);
    expect(expired).toBe(0);
  });
});
