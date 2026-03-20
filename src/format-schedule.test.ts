import { describe, expect, it } from 'vitest';

import { formatSchedule, formatNextRun } from './format-schedule.js';

describe('formatSchedule', () => {
  describe('cron', () => {
    it('formats every N minutes', () => {
      expect(formatSchedule('cron', '*/5 * * * *')).toBe('every 5 min');
    });

    it('formats every minute', () => {
      expect(formatSchedule('cron', '*/1 * * * *')).toBe('every minute');
    });

    it('formats every N hours', () => {
      expect(formatSchedule('cron', '0 */2 * * *')).toBe('every 2 hours');
    });

    it('formats every hour', () => {
      expect(formatSchedule('cron', '0 */1 * * *')).toBe('every hour');
    });

    it('formats daily at specific time', () => {
      expect(formatSchedule('cron', '0 9 * * *')).toBe('daily at 9am');
    });

    it('formats daily at specific time with minutes', () => {
      expect(formatSchedule('cron', '30 14 * * *')).toBe('daily at 2:30pm');
    });

    it('formats weekdays at specific time', () => {
      expect(formatSchedule('cron', '0 9 * * 1-5')).toBe('weekdays at 9am');
    });

    it('formats midnight correctly', () => {
      expect(formatSchedule('cron', '0 0 * * *')).toBe('daily at 12am');
    });

    it('falls back for complex expressions', () => {
      expect(formatSchedule('cron', '0 9 1 * *')).toContain('cron:');
    });
  });

  describe('interval', () => {
    it('formats seconds', () => {
      expect(formatSchedule('interval', '30000')).toBe('every 30s');
    });

    it('formats minutes', () => {
      expect(formatSchedule('interval', '300000')).toBe('every 5 min');
    });

    it('formats hours', () => {
      expect(formatSchedule('interval', '3600000')).toBe('every hour');
    });

    it('formats multiple hours', () => {
      expect(formatSchedule('interval', '7200000')).toBe('every 2 hours');
    });
  });

  describe('once', () => {
    it('formats a timestamp', () => {
      const result = formatSchedule('once', '2026-03-19T15:30:00');
      expect(result).toContain('once at');
    });
  });
});

describe('formatNextRun', () => {
  it('returns empty string for null', () => {
    expect(formatNextRun(null)).toBe('');
  });

  it('returns overdue for past times', () => {
    expect(formatNextRun('2020-01-01T00:00:00Z')).toBe('overdue');
  });

  it('returns relative time for near future', () => {
    const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const result = formatNextRun(fiveMinFromNow);
    expect(result).toMatch(/in \d+ min/);
  });
});
