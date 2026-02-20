import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isShabbatOrYomTov, _loadScheduleForTest } from './shabbat.js';

const TEST_SCHEDULE = {
  location: 'Test',
  coordinates: [40.669, -73.943],
  elevation: 25,
  tzeisBufferMinutes: 18,
  generatedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2031-01-01T00:00:00.000Z',
  windowCount: 3,
  windows: [
    { start: '2026-02-20T17:20:00.000Z', end: '2026-02-21T23:45:00.000Z', type: 'shabbat' as const, label: 'Shabbat' },
    { start: '2026-02-27T17:28:00.000Z', end: '2026-02-28T23:50:00.000Z', type: 'shabbat' as const, label: 'Shabbat' },
    { start: '2026-03-20T17:40:00.000Z', end: '2026-03-22T23:55:00.000Z', type: 'shabbat+yomtov' as const, label: 'Shabbat / Pesach' },
  ],
};

describe('isShabbatOrYomTov', () => {
  beforeEach(() => { _loadScheduleForTest(TEST_SCHEDULE); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns true during a Shabbat window', () => {
    vi.setSystemTime(new Date('2026-02-20T20:00:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(true);
  });

  it('returns true at exact start of window (shkiya)', () => {
    vi.setSystemTime(new Date('2026-02-20T17:20:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(true);
  });

  it('returns false just before shkiya', () => {
    vi.setSystemTime(new Date('2026-02-20T17:19:59.999Z'));
    expect(isShabbatOrYomTov()).toBe(false);
  });

  it('returns true just before end of window', () => {
    vi.setSystemTime(new Date('2026-02-21T23:44:59.999Z'));
    expect(isShabbatOrYomTov()).toBe(true);
  });

  it('returns false at exact end of window (tzeis + 18)', () => {
    vi.setSystemTime(new Date('2026-02-21T23:45:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(false);
  });

  it('returns false on a weekday', () => {
    vi.setSystemTime(new Date('2026-02-24T12:00:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(false);
  });

  it('returns true during a merged shabbat+yomtov window', () => {
    vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(true);
  });

  it('returns false before any windows', () => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(false);
  });

  it('returns false after all windows', () => {
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    expect(isShabbatOrYomTov()).toBe(false);
  });
});
