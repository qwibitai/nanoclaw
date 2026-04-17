import { describe, expect, it } from 'vitest';

import {
  computeNextRun,
  computeNextRunForCron,
  computeNextRunForInterval,
  computeNextRunForOnce,
} from './schedule.js';

describe('computeNextRunForCron', () => {
  it('returns a future ISO timestamp for a valid cron', () => {
    const next = computeNextRunForCron('0 9 * * *');
    expect(next).not.toBeNull();
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('returns null for an invalid cron expression', () => {
    expect(computeNextRunForCron('not a cron')).toBeNull();
    expect(computeNextRunForCron('99 * * * *')).toBeNull();
  });
});

describe('computeNextRunForInterval', () => {
  it('returns now + ms as an ISO timestamp', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const next = computeNextRunForInterval('60000', now);
    expect(next).toBe(new Date(now + 60000).toISOString());
  });

  it('returns null for non-numeric values', () => {
    expect(computeNextRunForInterval('forever')).toBeNull();
  });

  it('returns null for zero or negative values', () => {
    expect(computeNextRunForInterval('0')).toBeNull();
    expect(computeNextRunForInterval('-1')).toBeNull();
  });
});

describe('computeNextRunForOnce', () => {
  it('returns the ISO form of the parsed date', () => {
    const next = computeNextRunForOnce('2026-06-15T12:00:00Z');
    expect(next).toBe(new Date('2026-06-15T12:00:00Z').toISOString());
  });

  it('returns null for an unparseable timestamp', () => {
    expect(computeNextRunForOnce('not a date')).toBeNull();
  });
});

describe('computeNextRun dispatcher', () => {
  it('routes to the cron helper', () => {
    expect(computeNextRun('cron', '*/5 * * * *')).not.toBeNull();
    expect(computeNextRun('cron', 'bad')).toBeNull();
  });

  it('routes to the interval helper', () => {
    expect(computeNextRun('interval', '1000')).not.toBeNull();
    expect(computeNextRun('interval', '0')).toBeNull();
  });

  it('routes to the once helper', () => {
    expect(computeNextRun('once', '2026-06-15T12:00:00Z')).not.toBeNull();
    expect(computeNextRun('once', 'nope')).toBeNull();
  });
});
