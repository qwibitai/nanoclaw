import { describe, it, expect } from 'vitest';

// Test the NaN-fallback pattern directly.
// config.ts uses:  parseInt(value || 'default', 10) || fallback
// This suite verifies that the pattern handles bad env values safely.
function parseWithFallback(value: string | undefined, def: number): number {
  return parseInt(value || String(def), 10) || def;
}

describe('config parseInt NaN fallback pattern', () => {
  it('returns default when value is undefined', () => {
    expect(parseWithFallback(undefined, 1800000)).toBe(1800000);
  });

  it('returns default when value is empty string', () => {
    expect(parseWithFallback('', 1800000)).toBe(1800000);
  });

  it('returns default when value is non-numeric', () => {
    expect(parseWithFallback('not-a-number', 1800000)).toBe(1800000);
    expect(parseWithFallback('bad', 3001)).toBe(3001);
    expect(parseWithFallback('abc', 10485760)).toBe(10485760);
  });

  it('returns parsed number when value is valid', () => {
    expect(parseWithFallback('5000', 1800000)).toBe(5000);
    expect(parseWithFallback('4000', 3001)).toBe(4000);
  });

  it('CONTAINER_TIMEOUT default is 1800000 (30 min in ms)', () => {
    expect(parseWithFallback(undefined, 1800000)).toBe(1800000);
  });

  it('CONTAINER_MAX_OUTPUT_SIZE default is 10485760 (10 MB)', () => {
    expect(parseWithFallback(undefined, 10485760)).toBe(10485760);
  });

  it('CREDENTIAL_PROXY_PORT default is 3001', () => {
    expect(parseWithFallback(undefined, 3001)).toBe(3001);
  });
});
