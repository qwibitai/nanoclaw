import { describe, it, expect } from 'vitest';
import { calculateBackoff } from './backoff.js';

describe('calculateBackoff', () => {
  it('returns baseMs when consecutiveErrors is 0', () => {
    expect(calculateBackoff(0, 1000, 60000)).toBe(1000);
  });

  it('returns baseMs * 2 when consecutiveErrors is 1', () => {
    expect(calculateBackoff(1, 1000, 60000)).toBe(2000);
  });

  it('returns baseMs * 4 when consecutiveErrors is 2', () => {
    expect(calculateBackoff(2, 1000, 60000)).toBe(4000);
  });

  it('returns baseMs * 8 when consecutiveErrors is 3', () => {
    expect(calculateBackoff(3, 1000, 60000)).toBe(8000);
  });

  it('caps at maxMs for high consecutiveErrors', () => {
    expect(calculateBackoff(10, 1000, 60000)).toBe(60000);
  });

  it('works with different base and max values', () => {
    expect(calculateBackoff(0, 5000, 300000)).toBe(5000);
  });

  it('returns baseMs * 2^n for exponential growth', () => {
    expect(calculateBackoff(4, 1000, 60000)).toBe(16000);
  });

  it('caps exactly at maxMs when exponent would exceed it', () => {
    // 1000 * 2^7 = 128000 > 60000
    expect(calculateBackoff(7, 1000, 60000)).toBe(60000);
  });

  it('returns maxMs when base exceeds max for any error count', () => {
    expect(calculateBackoff(1, 50000, 60000)).toBe(60000);
  });

  it('handles large consecutive error counts gracefully', () => {
    const result = calculateBackoff(100, 1000, 300000);
    expect(result).toBe(300000);
  });
});
