import { describe, it, expect } from 'vitest';
import { clampInt } from './memory-utils.js';

describe('clampInt', () => {
  it('clamps value within range', () => {
    expect(clampInt(5, 1, 10)).toBe(5);
  });

  it('clamps below minimum', () => {
    expect(clampInt(-3, 0, 10)).toBe(0);
  });

  it('clamps above maximum', () => {
    expect(clampInt(25, 0, 10)).toBe(10);
  });

  it('floors fractional values', () => {
    expect(clampInt(3.7, 0, 10)).toBe(3);
    expect(clampInt(3.2, 0, 10)).toBe(3);
  });

  it('returns min for NaN', () => {
    expect(clampInt(NaN, 1, 10)).toBe(1);
  });

  it('returns min for Infinity', () => {
    expect(clampInt(Infinity, 1, 10)).toBe(1);
    expect(clampInt(-Infinity, 1, 10)).toBe(1);
  });

  it('handles min === max', () => {
    expect(clampInt(5, 3, 3)).toBe(3);
  });
});
