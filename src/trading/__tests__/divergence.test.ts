import { describe, it, expect } from 'vitest';

import { computeDivergence } from '../indicators/divergence.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBtcSeries(start: number, step: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    price: start + step * i,
    ts: 1_000_000 + i * 1_000,
  }));
}

function makePolySeries(start: number, step: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    upMid: start + step * i,
    ts: 1_000_000 + i * 1_000,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeDivergence', () => {
  it('returns a positive score when both series are bullish', () => {
    const btc = makeBtcSeries(60_000, 50, 10);
    const poly = makePolySeries(0.55, 0.01, 10);

    const score = computeDivergence(btc, poly);

    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns a positive score when both series are bearish', () => {
    const btc = makeBtcSeries(60_000, -50, 10);
    const poly = makePolySeries(0.55, -0.01, 10);

    const score = computeDivergence(btc, poly);

    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns a negative score when series diverge', () => {
    const btc = makeBtcSeries(60_000, 50, 10);
    const poly = makePolySeries(0.55, -0.01, 10);

    const score = computeDivergence(btc, poly);

    expect(score).toBeLessThan(0);
    expect(score).toBeGreaterThanOrEqual(-1);
  });

  it('returns 0 for insufficient data', () => {
    expect(computeDivergence([], [])).toBe(0);
    expect(
      computeDivergence(
        [{ price: 60_000, ts: 1_000_000 }],
        [{ upMid: 0.55, ts: 1_000_000 }],
      ),
    ).toBe(0);
  });
});
