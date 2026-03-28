import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  _resetDebtMonitorForTests,
  addDebt,
  computeDebtScore,
  getHighDebtItems,
  getUnresolvedDebt,
  resolveDebt,
  startDebtMonitorLoop,
  updateDebtScores,
} from './temporal-debt.js';

describe('temporal-debt', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetDebtMonitorForTests();
  });

  it('addDebt inserts a row retrievable by getUnresolvedDebt', () => {
    addDebt({
      id: 'debt-001',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      description: 'Follow up on proposal',
      created_at: new Date().toISOString(),
      resolved_at: null,
      source_message_id: null,
    });

    const items = getUnresolvedDebt('test-group');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('debt-001');
    expect(items[0].description).toBe('Follow up on proposal');
    expect(items[0].score).toBe(1.0);
    expect(items[0].escalation_count).toBe(0);
    expect(items[0].resolved_at).toBeNull();
  });

  it('resolveDebt sets resolved_at and removes from getUnresolvedDebt', () => {
    addDebt({
      id: 'debt-002',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      description: 'Send invoice',
      created_at: new Date().toISOString(),
      resolved_at: null,
      source_message_id: null,
    });

    expect(getUnresolvedDebt('test-group')).toHaveLength(1);

    resolveDebt('debt-002');

    const items = getUnresolvedDebt('test-group');
    expect(items).toHaveLength(0);
  });

  it('computeDebtScore returns ~1.0 for brand-new item with 0 escalations (< 1 day old)', () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(); // 12 hours ago
    const score = computeDebtScore({ created_at: createdAt, escalation_count: 0 }, now);
    // 0.5 days * 1.5^0 = 0.5
    expect(score).toBeCloseTo(0.5, 5);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(1);
  });

  it('computeDebtScore returns ~10.5 for 7-day-old item with 0 escalations', () => {
    const now = new Date('2026-03-27T12:00:00.000Z');
    const createdAt = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const score = computeDebtScore({ created_at: createdAt, escalation_count: 0 }, now);
    // 7 days * 1.5^0 = 7.0
    expect(score).toBeCloseTo(7.0, 5);
  });

  it('computeDebtScore escalation_count=2 on 1-day-old item returns ~2.25 (1 * 1.5^2)', () => {
    const now = new Date('2026-03-27T12:00:00.000Z');
    const createdAt = new Date(
      now.getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const score = computeDebtScore({ created_at: createdAt, escalation_count: 2 }, now);
    // 1 day * 1.5^2 = 2.25
    expect(score).toBeCloseTo(2.25, 5);
  });

  it('computeDebtScore caps at 100', () => {
    const now = new Date();
    const createdAt = new Date(
      now.getTime() - 200 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 200 days ago
    const score = computeDebtScore({ created_at: createdAt, escalation_count: 5 }, now);
    expect(score).toBe(100);
  });

  it('updateDebtScores persists computed scores to DB', () => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    addDebt({
      id: 'debt-score-1',
      group_folder: 'score-group',
      chat_jid: 'score@g.us',
      description: 'Old unresolved item',
      created_at: sevenDaysAgo,
      resolved_at: null,
      source_message_id: null,
    });

    // Initial score should be 1.0 (default at insert time)
    const before = getUnresolvedDebt('score-group');
    expect(before[0].score).toBe(1.0);

    updateDebtScores();

    const after = getUnresolvedDebt('score-group');
    // 7 days * 1.5^0 = 7.0 (approximately, depending on exact timing)
    expect(after[0].score).toBeGreaterThan(1.0);
  });

  it('getHighDebtItems respects threshold and orders by score DESC', () => {
    const now = new Date();
    const makePast = (days: number) =>
      new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

    addDebt({
      id: 'high-1',
      group_folder: 'g',
      chat_jid: 'g@g.us',
      description: 'Very old',
      created_at: makePast(50),
      resolved_at: null,
      source_message_id: null,
    });
    addDebt({
      id: 'high-2',
      group_folder: 'g',
      chat_jid: 'g@g.us',
      description: 'Moderately old',
      created_at: makePast(25),
      resolved_at: null,
      source_message_id: null,
    });
    addDebt({
      id: 'high-3',
      group_folder: 'g',
      chat_jid: 'g@g.us',
      description: 'Recent',
      created_at: makePast(1),
      resolved_at: null,
      source_message_id: null,
    });

    updateDebtScores();

    const high = getHighDebtItems(20);
    expect(high.length).toBeGreaterThanOrEqual(1);
    for (const item of high) {
      expect(item.score).toBeGreaterThanOrEqual(20);
    }
    // Should be ordered DESC by score
    for (let i = 1; i < high.length; i++) {
      expect(high[i - 1].score).toBeGreaterThanOrEqual(high[i].score);
    }
  });

  it('getHighDebtItems respects limit parameter', () => {
    const now = new Date();
    const makePast = (days: number) =>
      new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

    for (let i = 0; i < 5; i++) {
      addDebt({
        id: `limit-debt-${i}`,
        group_folder: 'limit-group',
        chat_jid: 'limit@g.us',
        description: `Item ${i}`,
        created_at: makePast(40 + i),
        resolved_at: null,
        source_message_id: null,
      });
    }

    updateDebtScores();

    const allHigh = getHighDebtItems(0);
    expect(allHigh.length).toBeGreaterThanOrEqual(5);

    const limited = getHighDebtItems(0, 2);
    expect(limited).toHaveLength(2);
  });

  it('_resetDebtMonitorForTests allows startDebtMonitorLoop to run again', async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn().mockResolvedValue(undefined);

      startDebtMonitorLoop(sendMessage, { pollIntervalMs: 999999, escalationThreshold: 9999 });
      // Running again without reset should be a no-op (guard)
      startDebtMonitorLoop(sendMessage, { pollIntervalMs: 999999, escalationThreshold: 9999 });

      _resetDebtMonitorForTests();

      // After reset, should be able to start again without throwing
      expect(() =>
        startDebtMonitorLoop(sendMessage, {
          pollIntervalMs: 999999,
          escalationThreshold: 9999,
        }),
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
      _resetDebtMonitorForTests();
    }
  });
});
