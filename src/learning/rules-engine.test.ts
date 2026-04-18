import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockDb = {
  exec: vi.fn(),
  prepare: vi.fn(),
};

vi.mock('../db.js', () => ({ getDb: vi.fn(() => mockDb) }));

import {
  initRulesStore,
  addRule,
  queryRules,
  markMatched,
  pruneStaleRules,
  deleteRule,
  decayConfidence,
} from './rules-engine.js';

describe('initRulesStore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates learned_rules table and FTS index', () => {
    initRulesStore();
    expect(mockDb.exec).toHaveBeenCalledOnce();
    const sql = mockDb.exec.mock.calls[0][0] as string;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS learned_rules');
    expect(sql).toContain('fts5');
  });
});

describe('addRule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts rule and returns generated id', () => {
    const mockRun = vi.fn().mockReturnValue({ lastInsertRowid: 1 });
    const mockInsertStmt = { run: mockRun };
    const mockFtsStmt = { run: vi.fn() };
    let callCount = 0;
    mockDb.prepare.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? mockInsertStmt : mockFtsStmt;
    });

    const id = addRule({
      rule: 'Refresh OAuth before email ops',
      source: 'outcome_pattern',
      actionClasses: ['email.read'],
      groupId: 'g1',
      confidence: 0.5,
      evidenceCount: 2,
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(mockRun).toHaveBeenCalledOnce();
  });
});

describe('queryRules', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns rules matching action classes and group', () => {
    const rows = [
      {
        id: 'abc',
        rule: 'Use API not browser',
        source: 'outcome_pattern',
        action_classes: '["github.read"]',
        group_id: 'g1',
        confidence: 0.7,
        evidence_count: 3,
        created_at: new Date().toISOString(),
        last_matched_at: new Date().toISOString(),
      },
    ];
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue(rows) });

    const results = queryRules(['github.read'], 'g1');
    expect(results).toHaveLength(1);
    expect(results[0].actionClasses).toEqual(['github.read']);
  });

  it('returns empty array when no rules found', () => {
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([]) });
    const results = queryRules(['email.send'], 'g1');
    expect(results).toEqual([]);
  });
});

describe('markMatched', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates last_matched_at for the rule', () => {
    const mockRun = vi.fn();
    mockDb.prepare.mockReturnValue({ run: mockRun });
    markMatched('rule-id-1');
    expect(mockRun).toHaveBeenCalledWith(expect.any(String), 'rule-id-1');
  });
});

describe('pruneStaleRules', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes rules with confidence below 0.1 and returns count', () => {
    const mockRun = vi.fn().mockReturnValue({ changes: 3 });
    mockDb.prepare.mockReturnValue({ run: mockRun });
    const count = pruneStaleRules();
    expect(count).toBe(3);
  });
});

describe('deleteRule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes rule by id (trigger handles FTS cleanup)', () => {
    const mockRun = vi.fn();
    mockDb.prepare.mockReturnValue({ run: mockRun });
    deleteRule('rule-id-1');
    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});

describe('decayConfidence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reduces confidence for rules not matched in 30 days', () => {
    const mockRun = vi.fn().mockReturnValue({ changes: 2 });
    mockDb.prepare.mockReturnValue({ run: mockRun });
    const count = decayConfidence();
    expect(count).toBe(2);
  });
});
