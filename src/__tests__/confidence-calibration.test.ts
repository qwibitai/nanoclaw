import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import {
  recordConfidenceOutcome,
  getCalibrationStats,
} from '../confidence-calibration.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('confidence-calibration', () => {
  it('records confidence outcomes to trust_actions', () => {
    recordConfidenceOutcome('item-1', 'verified', true);
    recordConfidenceOutcome('item-2', 'verified', false);
    recordConfidenceOutcome('item-3', 'unverified', true);

    const stats = getCalibrationStats();
    expect(stats.verified.total).toBe(2);
    expect(stats.verified.correct).toBe(1);
    expect(stats.verified.accuracy).toBeCloseTo(0.5);
    expect(stats.unverified.total).toBe(1);
    expect(stats.unverified.correct).toBe(1);
  });

  it('returns zero stats when no outcomes recorded', () => {
    const stats = getCalibrationStats();
    expect(stats.verified.total).toBe(0);
    expect(stats.verified.accuracy).toBe(0);
  });
});
