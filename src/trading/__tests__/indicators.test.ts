import { describe, it, expect } from 'vitest';

import { computeEma, emaSignal } from '../indicators/ema.js';
import { computeRsi } from '../indicators/rsi.js';
import { computeRoc } from '../indicators/roc.js';

// ---------------------------------------------------------------------------
// EMA tests
// ---------------------------------------------------------------------------

describe('computeEma', () => {
  it('computes EMA-12 for an uptrend (result between bounds)', () => {
    // 30 prices rising by 2 from 100
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const result = computeEma(prices, 12);

    expect(result).not.toBeNull();
    // EMA-12 should lag behind the latest price but exceed the midpoint
    expect(result!).toBeGreaterThan(prices[0]);
    expect(result!).toBeLessThan(prices[prices.length - 1]);
  });

  it('computes EMA-26 for an uptrend', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const ema26 = computeEma(prices, 26);
    const ema12 = computeEma(prices, 12);

    expect(ema26).not.toBeNull();
    expect(ema12).not.toBeNull();
    // Shorter EMA reacts faster so it should be closer to the latest price
    expect(ema12!).toBeGreaterThan(ema26!);
  });

  it('returns null with fewer than 12 data points', () => {
    const prices = Array.from({ length: 11 }, (_, i) => 100 + i);
    expect(computeEma(prices, 12)).toBeNull();
  });
});

describe('emaSignal', () => {
  it('returns bullish on an uptrend', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const signal = emaSignal(prices);

    expect(signal.direction).toBe('bullish');
    expect(signal.strength).toBeGreaterThan(0);
    expect(signal.strength).toBeLessThanOrEqual(1);
  });

  it('returns bearish on a downtrend', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 200 - i * 2);
    const signal = emaSignal(prices);

    expect(signal.direction).toBe('bearish');
    expect(signal.strength).toBeGreaterThan(0);
    expect(signal.strength).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// RSI tests
// ---------------------------------------------------------------------------

describe('computeRsi', () => {
  it('returns ~50 for alternating +1/-1 prices', () => {
    // 80 prices alternating between 100 and 101
    const prices = Array.from({ length: 80 }, (_, i) => 100 + (i % 2));
    const rsi = computeRsi(prices, 14);

    expect(rsi).not.toBeNull();
    expect(rsi!).toBeGreaterThan(40);
    expect(rsi!).toBeLessThan(60);
  });

  it('returns >70 for a strong uptrend', () => {
    const prices = Array.from({ length: 80 }, (_, i) => 100 + i);
    const rsi = computeRsi(prices, 14);

    expect(rsi).not.toBeNull();
    expect(rsi!).toBeGreaterThan(70);
  });

  it('returns <30 for a strong downtrend', () => {
    const prices = Array.from({ length: 80 }, (_, i) => 200 - i);
    const rsi = computeRsi(prices, 14);

    expect(rsi).not.toBeNull();
    expect(rsi!).toBeLessThan(30);
  });

  it('returns null with fewer than 15 data points (period=14)', () => {
    const prices = Array.from({ length: 14 }, (_, i) => 100 + i);
    expect(computeRsi(prices, 14)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ROC tests
// ---------------------------------------------------------------------------

describe('computeRoc', () => {
  it('returns positive ROC for rising prices', () => {
    const prices = [100, 102, 104, 106, 108, 110];
    const roc = computeRoc(prices, 5);

    expect(roc).not.toBeNull();
    expect(roc!).toBeGreaterThan(0);
    // (110 - 100) / 100 = 0.1
    expect(roc!).toBeCloseTo(0.1);
  });

  it('returns negative ROC for falling prices', () => {
    const prices = [110, 108, 106, 104, 102, 100];
    const roc = computeRoc(prices, 5);

    expect(roc).not.toBeNull();
    expect(roc!).toBeLessThan(0);
    // (100 - 110) / 110 = -0.0909...
    expect(roc!).toBeCloseTo(-10 / 110);
  });

  it('returns 0 for flat prices', () => {
    const prices = [100, 100, 100, 100, 100, 100];
    const roc = computeRoc(prices, 5);

    expect(roc).toBe(0);
  });

  it('returns null with fewer than 6 points for periods=5', () => {
    const prices = [100, 102, 104, 106, 108];
    expect(computeRoc(prices, 5)).toBeNull();
  });
});
