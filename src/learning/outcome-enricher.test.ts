import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockQueryRules = vi.fn();
const mockMarkMatched = vi.fn();

vi.mock('./rules-engine.js', () => ({
  queryRules: (...args: unknown[]) => mockQueryRules(...args),
  markMatched: (...args: unknown[]) => mockMarkMatched(...args),
}));

import { inferActionClasses, buildRulesBlock } from './outcome-enricher.js';

describe('inferActionClasses', () => {
  it('maps email keywords to email action classes', () => {
    const classes = inferActionClasses(
      'check my gmail inbox for unread messages',
    );
    expect(classes).toContain('email.read');
    expect(classes).toContain('email.send');
  });
  it('maps github keywords to github action classes', () => {
    const classes = inferActionClasses(
      'what is the status of my PR on github?',
    );
    expect(classes).toContain('github.read');
  });
  it('maps browser keywords to browser action classes', () => {
    const classes = inferActionClasses(
      'navigate to the website and click login',
    );
    expect(classes).toContain('browser.read');
  });
  it('maps schedule keywords to task.schedule', () => {
    const classes = inferActionClasses(
      'remind me to check the schedule tomorrow',
    );
    expect(classes).toContain('task.schedule');
  });
  it('returns empty array for unrecognized message', () => {
    const classes = inferActionClasses('hello world');
    expect(classes).toEqual([]);
  });
});

describe('buildRulesBlock', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no rules found', () => {
    mockQueryRules.mockReturnValue([]);
    const result = buildRulesBlock('check my email', 'g1');
    expect(result).toBeNull();
  });
  it('formats rules as a compact block', () => {
    mockQueryRules.mockReturnValue([
      {
        id: 'r1',
        rule: 'Refresh OAuth tokens before email ops',
        source: 'outcome_pattern',
        actionClasses: ['email.read'],
        groupId: 'g1',
        confidence: 0.8,
        evidenceCount: 3,
        createdAt: new Date().toISOString(),
        lastMatchedAt: new Date().toISOString(),
      },
    ]);
    const result = buildRulesBlock('check my email', 'g1');
    expect(result).not.toBeNull();
    expect(result).toContain('## Learned Rules');
    expect(result).toContain('Refresh OAuth tokens before email ops');
  });
  it('calls markMatched for each injected rule', () => {
    mockQueryRules.mockReturnValue([
      {
        id: 'r1',
        rule: 'Use API not browser',
        source: 'outcome_pattern',
        actionClasses: ['github.read'],
        groupId: 'g1',
        confidence: 0.7,
        evidenceCount: 2,
        createdAt: new Date().toISOString(),
        lastMatchedAt: new Date().toISOString(),
      },
    ]);
    buildRulesBlock('check PR status', 'g1');
    expect(mockMarkMatched).toHaveBeenCalledWith('r1');
  });
  it('truncates block to 500 characters', () => {
    const longRule = 'A'.repeat(200);
    mockQueryRules.mockReturnValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `r${i}`,
        rule: longRule,
        source: 'outcome_pattern',
        actionClasses: ['email.read'],
        groupId: 'g1',
        confidence: 0.8,
        evidenceCount: 1,
        createdAt: new Date().toISOString(),
        lastMatchedAt: new Date().toISOString(),
      })),
    );
    const result = buildRulesBlock('check email', 'g1');
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(500);
  });
});
