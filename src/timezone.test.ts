import { describe, it, expect } from 'vitest';

import {
  resolveGroupTimezone,
  isValidTimezone,
  formatLocalTime,
  formatCurrentTime,
  localTimeToUtc,
} from './timezone.js';
import { RegisteredGroup } from './types.js';

function makeGroup(timezone?: string): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@test',
    added_at: '2026-01-01T00:00:00.000Z',
    containerConfig: timezone ? { timezone } : undefined,
  };
}

// --- resolveGroupTimezone ---

describe('resolveGroupTimezone', () => {
  it('returns group timezone when set', () => {
    const group = makeGroup('America/New_York');
    expect(resolveGroupTimezone(group)).toBe('America/New_York');
  });

  it('falls back to server TIMEZONE when group has no timezone', () => {
    const group = makeGroup();
    const result = resolveGroupTimezone(group);
    // Should return a valid IANA timezone (the server default)
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('falls back when containerConfig is undefined', () => {
    const group: RegisteredGroup = {
      name: 'Test',
      folder: 'test',
      trigger: '@test',
      added_at: '2026-01-01T00:00:00.000Z',
    };
    const result = resolveGroupTimezone(group);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// --- isValidTimezone ---

describe('isValidTimezone', () => {
  it('accepts valid IANA timezones', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('Africa/Johannesburg')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects invalid timezone strings', () => {
    expect(isValidTimezone('Fake/Timezone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Not_A_Timezone')).toBe(false);
  });
});

// --- formatLocalTime ---

describe('formatLocalTime', () => {
  it('converts UTC to local time display', () => {
    // 2026-02-04T18:30:00Z in America/New_York (EST, UTC-5) = 1:30 PM
    const result = formatLocalTime(
      '2026-02-04T18:30:00.000Z',
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('Feb');
    expect(result).toContain('2026');
  });

  it('handles different timezones', () => {
    // Same UTC time should produce different local times
    const utc = '2026-06-15T12:00:00.000Z';
    const ny = formatLocalTime(utc, 'America/New_York');
    const tokyo = formatLocalTime(utc, 'Asia/Tokyo');
    // NY is UTC-4 in summer (EDT), Tokyo is UTC+9
    expect(ny).toContain('8:00');
    expect(tokyo).toContain('9:00');
  });
});

// --- formatCurrentTime ---

describe('formatCurrentTime', () => {
  it('returns a string with timezone abbreviation', () => {
    const result = formatCurrentTime('America/New_York');
    // Should contain day of week, date, time, and timezone abbreviation
    expect(result).toMatch(/\d{4}/); // year
    expect(result).toMatch(/\d{1,2}:\d{2}/); // time
  });

  it('works for various timezones', () => {
    expect(() => formatCurrentTime('Europe/London')).not.toThrow();
    expect(() => formatCurrentTime('Asia/Tokyo')).not.toThrow();
    expect(() => formatCurrentTime('Africa/Johannesburg')).not.toThrow();
  });
});

// --- localTimeToUtc ---

describe('localTimeToUtc', () => {
  it('converts local time to UTC', () => {
    // 3:30 PM in New York (EST, UTC-5) = 8:30 PM UTC
    const result = localTimeToUtc('2026-02-04T15:30:00', 'America/New_York');
    const date = new Date(result);
    expect(date.getUTCHours()).toBe(20);
    expect(date.getUTCMinutes()).toBe(30);
  });

  it('handles UTC timezone (no offset)', () => {
    const result = localTimeToUtc('2026-02-04T15:30:00', 'UTC');
    const date = new Date(result);
    expect(date.getUTCHours()).toBe(15);
    expect(date.getUTCMinutes()).toBe(30);
  });

  it('handles positive UTC offset (e.g., Asia/Tokyo, UTC+9)', () => {
    // 9:00 AM in Tokyo (UTC+9) = midnight UTC
    const result = localTimeToUtc('2026-02-04T09:00:00', 'Asia/Tokyo');
    const date = new Date(result);
    expect(date.getUTCHours()).toBe(0);
    expect(date.getUTCDate()).toBe(4);
  });

  it('handles negative UTC offset (e.g., America/Los_Angeles, UTC-8 in winter)', () => {
    // 4:00 PM in LA (PST, UTC-8) = midnight UTC next day
    const result = localTimeToUtc(
      '2026-02-04T16:00:00',
      'America/Los_Angeles',
    );
    const date = new Date(result);
    expect(date.getUTCHours()).toBe(0);
    expect(date.getUTCDate()).toBe(5);
  });

  it('throws on invalid timestamp', () => {
    expect(() => localTimeToUtc('not-a-date', 'UTC')).toThrow(
      'Invalid timestamp',
    );
  });

  it('returns ISO 8601 format', () => {
    const result = localTimeToUtc('2026-02-04T15:30:00', 'UTC');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });
});
