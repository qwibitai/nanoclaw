import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockAddRule = vi.fn().mockReturnValue('rule-id-1');
const mockQueryRules = vi.fn().mockReturnValue([]);

vi.mock('./rules-engine.js', () => ({
  addRule: (...args: unknown[]) => mockAddRule(...args),
  queryRules: (...args: unknown[]) => mockQueryRules(...args),
}));

vi.mock('./outcome-enricher.js', () => ({
  inferActionClasses: vi.fn().mockReturnValue([]),
}));

import { detectFeedback, saveFeedbackAsRule } from './feedback-capture.js';

describe('detectFeedback', () => {
  const now = Date.now();
  const recentBotTs = now - 60_000; // 1 minute ago

  it('detects correction keywords', () => {
    const result = detectFeedback(
      "that's wrong, use the API instead",
      recentBotTs,
      'g1',
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('correction');
  });

  it('detects positive keywords', () => {
    const result = detectFeedback(
      'perfect, that worked exactly right',
      recentBotTs,
      'g1',
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('positive');
  });

  it('returns null when message is outside 2-minute window', () => {
    const oldBotTs = now - 3 * 60_000;
    const result = detectFeedback("that's wrong", oldBotTs, 'g1');
    expect(result).toBeNull();
  });

  it('returns null for neutral messages', () => {
    const result = detectFeedback('okay thanks', recentBotTs, 'g1');
    expect(result).toBeNull();
  });

  it('returns null when lastBotTimestamp is 0 (no prior bot message)', () => {
    const result = detectFeedback("that's wrong", 0, 'g1');
    expect(result).toBeNull();
  });
});

describe('saveFeedbackAsRule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls addRule with user_feedback source and 0.9 confidence', () => {
    saveFeedbackAsRule(
      { type: 'correction', text: 'Use API not browser for GitHub' },
      'g1',
    );
    expect(mockAddRule).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'user_feedback',
        confidence: 0.9,
        rule: 'Use API not browser for GitHub',
        groupId: 'g1',
      }),
    );
  });

  it('returns the rule id from addRule', () => {
    mockAddRule.mockReturnValue('new-rule-id');
    const id = saveFeedbackAsRule(
      { type: 'correction', text: 'Do not use browser' },
      'g1',
    );
    expect(id).toBe('new-rule-id');
  });
});
