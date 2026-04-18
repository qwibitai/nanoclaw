import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../db.js';
import {
  initOutcomeStore,
  logOutcome,
  queryOutcomes,
  getSuccessRate,
  getTotalCost,
} from './outcome-store.js';

beforeEach(() => {
  _initTestDatabase();
  initOutcomeStore();
});

describe('Outcome Store', () => {
  it('logs and retrieves an outcome', () => {
    const id = logOutcome({
      actionClass: 'web.search',
      description: 'Searched for weather',
      method: 'browser',
      result: 'success',
      durationMs: 1500,
      costUsd: 0.02,
      groupId: 'main',
    });
    expect(id).toBeGreaterThan(0);

    const outcomes = queryOutcomes({ groupId: 'main' });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].action_class).toBe('web.search');
    expect(outcomes[0].result).toBe('success');
    expect(outcomes[0].cost_usd).toBe(0.02);
  });

  it('filters by action class', () => {
    logOutcome({
      actionClass: 'web.search',
      description: 'Search 1',
      method: 'browser',
      result: 'success',
      durationMs: 1000,
      groupId: 'main',
    });
    logOutcome({
      actionClass: 'email.send',
      description: 'Sent email',
      method: 'gmail-api',
      result: 'success',
      durationMs: 500,
      groupId: 'main',
    });

    const webOnly = queryOutcomes({ actionClass: 'web.search' });
    expect(webOnly).toHaveLength(1);
    expect(webOnly[0].action_class).toBe('web.search');
  });

  it('calculates success rate', () => {
    logOutcome({
      actionClass: 'web.search',
      description: 'Search 1',
      method: 'browser',
      result: 'success',
      durationMs: 1000,
      groupId: 'main',
    });
    logOutcome({
      actionClass: 'web.search',
      description: 'Search 2',
      method: 'browser',
      result: 'success',
      durationMs: 1200,
      groupId: 'main',
    });
    logOutcome({
      actionClass: 'web.search',
      description: 'Search 3',
      method: 'browser',
      result: 'failure',
      error: 'timeout',
      durationMs: 30000,
      groupId: 'main',
    });

    const rate = getSuccessRate('web.search');
    expect(rate.total).toBe(3);
    expect(rate.successes).toBe(2);
    expect(rate.rate).toBeCloseTo(0.667, 2);
  });

  it('returns zero success rate for unknown action class', () => {
    const rate = getSuccessRate('nonexistent.action');
    expect(rate.total).toBe(0);
    expect(rate.successes).toBe(0);
    expect(rate.rate).toBe(0);
  });

  it('calculates total cost', () => {
    logOutcome({
      actionClass: 'web.search',
      description: 'Search',
      method: 'browser',
      result: 'success',
      durationMs: 1000,
      costUsd: 0.05,
      groupId: 'main',
    });
    logOutcome({
      actionClass: 'email.send',
      description: 'Send',
      method: 'api',
      result: 'success',
      durationMs: 500,
      costUsd: 0.03,
      groupId: 'main',
    });

    const total = getTotalCost();
    expect(total).toBeCloseTo(0.08, 2);
  });

  it('stores error and user feedback', () => {
    logOutcome({
      actionClass: 'web.search',
      description: 'Failed search',
      method: 'browser',
      result: 'failure',
      error: 'Connection timed out',
      userFeedback: 'Try again later',
      durationMs: 5000,
      groupId: 'main',
    });

    const outcomes = queryOutcomes({});
    expect(outcomes[0].error).toBe('Connection timed out');
    expect(outcomes[0].user_feedback).toBe('Try again later');
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      logOutcome({
        actionClass: 'test',
        description: `Test ${i}`,
        method: 'test',
        result: 'success',
        durationMs: 100,
        groupId: 'main',
      });
    }

    const limited = queryOutcomes({ limit: 3 });
    expect(limited).toHaveLength(3);
  });
});
