import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccessTracker,
  parseAccessMetadata,
  mergeAccessMetadata,
  computeEffectiveHalfLife,
} from './memory-access-tracker.js';

describe('parseAccessMetadata', () => {
  it('returns defaults for undefined', () => {
    expect(parseAccessMetadata(undefined)).toEqual({
      accessCount: 0,
      lastAccessedAt: 0,
    });
  });

  it('returns defaults for empty string', () => {
    expect(parseAccessMetadata('')).toEqual({
      accessCount: 0,
      lastAccessedAt: 0,
    });
  });

  it('returns defaults for invalid JSON', () => {
    expect(parseAccessMetadata('not json')).toEqual({
      accessCount: 0,
      lastAccessedAt: 0,
    });
  });

  it('parses valid access metadata', () => {
    const meta = JSON.stringify({ _accessCount: 5, _lastAccessedAt: 1000 });
    expect(parseAccessMetadata(meta)).toEqual({
      accessCount: 5,
      lastAccessedAt: 1000,
    });
  });

  it('ignores non-numeric access fields', () => {
    const meta = JSON.stringify({ _accessCount: 'five', _lastAccessedAt: null });
    expect(parseAccessMetadata(meta)).toEqual({
      accessCount: 0,
      lastAccessedAt: 0,
    });
  });

  it('preserves other fields without breaking', () => {
    const meta = JSON.stringify({ userField: 'hello', _accessCount: 3, _lastAccessedAt: 500 });
    expect(parseAccessMetadata(meta)).toEqual({
      accessCount: 3,
      lastAccessedAt: 500,
    });
  });
});

describe('mergeAccessMetadata', () => {
  it('creates metadata from scratch', () => {
    const result = mergeAccessMetadata(undefined, { accessCount: 1, lastAccessedAt: 1000 });
    const parsed = JSON.parse(result);
    expect(parsed._accessCount).toBe(1);
    expect(parsed._lastAccessedAt).toBe(1000);
  });

  it('preserves existing user fields', () => {
    const existing = JSON.stringify({ userField: 'hello', custom: 42 });
    const result = mergeAccessMetadata(existing, { accessCount: 3, lastAccessedAt: 2000 });
    const parsed = JSON.parse(result);
    expect(parsed.userField).toBe('hello');
    expect(parsed.custom).toBe(42);
    expect(parsed._accessCount).toBe(3);
    expect(parsed._lastAccessedAt).toBe(2000);
  });

  it('overwrites existing access fields', () => {
    const existing = JSON.stringify({ _accessCount: 1, _lastAccessedAt: 500 });
    const result = mergeAccessMetadata(existing, { accessCount: 5, lastAccessedAt: 2000 });
    const parsed = JSON.parse(result);
    expect(parsed._accessCount).toBe(5);
    expect(parsed._lastAccessedAt).toBe(2000);
  });

  it('handles invalid existing JSON gracefully', () => {
    const result = mergeAccessMetadata('bad json', { accessCount: 1, lastAccessedAt: 100 });
    const parsed = JSON.parse(result);
    expect(parsed._accessCount).toBe(1);
  });
});

describe('computeEffectiveHalfLife', () => {
  it('returns base half-life when access count is 0', () => {
    expect(computeEffectiveHalfLife(14, 0, 0, 0.5, 3)).toBe(14);
  });

  it('returns base half-life when reinforcement factor is 0', () => {
    expect(computeEffectiveHalfLife(14, 10, 1000, 0, 3)).toBe(14);
  });

  it('increases half-life with access count', () => {
    const result = computeEffectiveHalfLife(14, 5, 1000, 0.5, 3);
    expect(result).toBeGreaterThan(14);
  });

  it('caps at max multiplier', () => {
    // With very high access count, should cap at maxMultiplier * baseHalfLife
    const result = computeEffectiveHalfLife(14, 10000, 1000, 0.5, 3);
    expect(result).toBe(14 * 3);
  });

  it('uses log2 scaling (diminishing returns)', () => {
    // multiplier = 1 + 0.5 * log2(1 + accessCount)
    // At count=1: 1 + 0.5 * log2(2) = 1.5 → 14 * 1.5 = 21
    // At count=10: 1 + 0.5 * log2(11) ≈ 1 + 0.5 * 3.459 = 2.73 → 14 * 2.73 ≈ 38.2
    // At count=100: 1 + 0.5 * log2(101) ≈ 1 + 0.5 * 6.66 = 4.33 → capped at 10 → 14 * 4.33 ≈ 60.6
    const result1 = computeEffectiveHalfLife(14, 1, 1000, 0.5, 10);
    const result10 = computeEffectiveHalfLife(14, 10, 1000, 0.5, 10);
    const result1000 = computeEffectiveHalfLife(14, 1000, 1000, 0.5, 10);
    // Going from 1→10 gives a bigger increment than 10→1000 (log2 diminishing returns)
    // Use wider spread to ensure diminishing returns are visible
    const diff1 = result10 - result1;
    const diff2 = result1000 - result10;
    // diff2 / (1000-10) per-unit should be less than diff1 / (10-1) per-unit
    expect(diff2 / 990).toBeLessThan(diff1 / 9);
  });
});

describe('AccessTracker', () => {
  let tracker: AccessTracker;

  beforeEach(() => {
    tracker = new AccessTracker();
  });

  it('records access and retrieves info', () => {
    tracker.recordAccess(['id-1', 'id-2']);
    const info = tracker.getAccessInfo('id-1');
    expect(info).toBeDefined();
    expect(info!.count).toBe(1);
    expect(info!.lastAt).toBeGreaterThan(0);
  });

  it('increments count on repeated access', () => {
    tracker.recordAccess(['id-1']);
    tracker.recordAccess(['id-1']);
    tracker.recordAccess(['id-1']);
    const info = tracker.getAccessInfo('id-1');
    expect(info!.count).toBe(3);
  });

  it('returns undefined for untracked IDs', () => {
    expect(tracker.getAccessInfo('nonexistent')).toBeUndefined();
  });

  it('seeds from metadata', () => {
    const meta = JSON.stringify({ _accessCount: 5, _lastAccessedAt: 1000 });
    tracker.seedFromMetadata('id-1', meta);
    const info = tracker.getAccessInfo('id-1');
    expect(info!.count).toBe(5);
    expect(info!.lastAt).toBe(1000);
  });

  it('does not overwrite already-seeded entries', () => {
    const meta1 = JSON.stringify({ _accessCount: 5, _lastAccessedAt: 1000 });
    const meta2 = JSON.stringify({ _accessCount: 10, _lastAccessedAt: 2000 });
    tracker.seedFromMetadata('id-1', meta1);
    tracker.seedFromMetadata('id-1', meta2); // should be ignored
    const info = tracker.getAccessInfo('id-1');
    expect(info!.count).toBe(5);
  });

  it('returns tracked IDs', () => {
    tracker.recordAccess(['a', 'b', 'c']);
    const ids = tracker.getTrackedIds();
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
  });
});
