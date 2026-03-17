import { describe, it, expect } from 'vitest';
import {
  validateCron,
  validateInterval,
  validateOnceTimestamp,
  validateScheduleValue,
} from './validation.js';

// validateCron

describe('validateCron', () => {
  /**
   * INVARIANT: validateCron accepts valid cron expressions and rejects invalid ones.
   */
  it('accepts standard 5-field cron', () => {
    expect(validateCron('0 9 * * *')).toEqual({ valid: true });
  });

  it('accepts every-N-minutes cron', () => {
    expect(validateCron('*/5 * * * *')).toEqual({ valid: true });
  });

  it('accepts complex cron with ranges and lists', () => {
    expect(validateCron('0 9,12,15 * * 1-5')).toEqual({ valid: true });
  });

  it('rejects invalid cron syntax', () => {
    const result = validateCron('not a cron');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid cron');
  });

  it('rejects too many fields', () => {
    const result = validateCron('* * * * * * *');
    expect(result.valid).toBe(false);
  });
});

// validateInterval

describe('validateInterval', () => {
  /**
   * INVARIANT: validateInterval accepts positive integer millisecond values
   * and rejects zero, negative, and non-numeric values.
   */
  it('accepts positive milliseconds', () => {
    expect(validateInterval('300000')).toEqual({ valid: true });
  });

  it('accepts small intervals', () => {
    expect(validateInterval('1')).toEqual({ valid: true });
  });

  it('rejects zero', () => {
    const result = validateInterval('0');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid interval');
  });

  it('rejects negative values', () => {
    const result = validateInterval('-1000');
    expect(result.valid).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    const result = validateInterval('five minutes');
    expect(result.valid).toBe(false);
  });

  it('rejects empty string', () => {
    const result = validateInterval('');
    expect(result.valid).toBe(false);
  });
});

// validateOnceTimestamp

describe('validateOnceTimestamp', () => {
  /**
   * INVARIANT: validateOnceTimestamp accepts local timestamps without timezone suffix
   * and rejects UTC/timezone-suffixed or unparseable timestamps.
   */
  it('accepts local timestamp', () => {
    expect(validateOnceTimestamp('2026-02-01T15:30:00')).toEqual({ valid: true });
  });

  it('rejects UTC Z suffix', () => {
    const result = validateOnceTimestamp('2026-02-01T15:30:00Z');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('local time without timezone');
  });

  it('rejects lowercase z suffix', () => {
    const result = validateOnceTimestamp('2026-02-01T15:30:00z');
    expect(result.valid).toBe(false);
  });

  it('rejects positive timezone offset', () => {
    const result = validateOnceTimestamp('2026-02-01T15:30:00+05:30');
    expect(result.valid).toBe(false);
  });

  it('rejects negative timezone offset', () => {
    const result = validateOnceTimestamp('2026-02-01T15:30:00-08:00');
    expect(result.valid).toBe(false);
  });

  it('rejects unparseable timestamps', () => {
    const result = validateOnceTimestamp('not-a-date');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid timestamp');
  });
});

// validateScheduleValue

describe('validateScheduleValue', () => {
  /**
   * INVARIANT: validateScheduleValue delegates to the correct validator based on schedule type.
   */
  it('validates cron type', () => {
    expect(validateScheduleValue('cron', '0 9 * * *').valid).toBe(true);
    expect(validateScheduleValue('cron', 'bad').valid).toBe(false);
  });

  it('validates interval type', () => {
    expect(validateScheduleValue('interval', '300000').valid).toBe(true);
    expect(validateScheduleValue('interval', '0').valid).toBe(false);
  });

  it('validates once type', () => {
    expect(validateScheduleValue('once', '2026-02-01T15:30:00').valid).toBe(true);
    expect(validateScheduleValue('once', '2026-02-01T15:30:00Z').valid).toBe(false);
  });
});
