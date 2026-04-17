import { describe, expect, it } from 'vitest';

import {
  validateCron,
  validateInterval,
  validateOnce,
  validateSchedule,
} from './schedule-validator.js';

describe('validateCron', () => {
  it('accepts a standard 5-field cron expression', () => {
    expect(validateCron('*/5 * * * *')).toEqual({ valid: true });
  });

  it('accepts a specific-time cron expression', () => {
    expect(validateCron('0 9 * * *')).toEqual({ valid: true });
  });

  it('rejects a malformed cron', () => {
    const r = validateCron('not a cron');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/Invalid cron/);
  });

  it('includes the offending value in the error', () => {
    const r = validateCron('99 * * *');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('99 * * *');
  });
});

describe('validateInterval', () => {
  it('accepts a positive integer ms string', () => {
    expect(validateInterval('300000')).toEqual({ valid: true });
  });

  it('rejects a non-numeric string', () => {
    const r = validateInterval('five minutes');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/Invalid interval/);
  });

  it('rejects zero', () => {
    const r = validateInterval('0');
    expect(r.valid).toBe(false);
  });

  it('rejects a negative number', () => {
    const r = validateInterval('-1000');
    expect(r.valid).toBe(false);
  });

  it('accepts a numeric string with trailing garbage (parseInt behaviour)', () => {
    // parseInt('300000abc', 10) === 300000. This matches the legacy handler
    // behaviour and the host-side watcher, so keep it as-is.
    expect(validateInterval('300000abc')).toEqual({ valid: true });
  });
});

describe('validateOnce', () => {
  it('accepts a local ISO timestamp without timezone', () => {
    expect(validateOnce('2026-02-01T15:30:00')).toEqual({ valid: true });
  });

  it('rejects a trailing Z (UTC suffix)', () => {
    const r = validateOnce('2026-02-01T15:30:00Z');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/without timezone suffix/);
  });

  it('rejects a lowercase trailing z', () => {
    const r = validateOnce('2026-02-01T15:30:00z');
    expect(r.valid).toBe(false);
  });

  it('rejects a +HH:MM timezone offset', () => {
    const r = validateOnce('2026-02-01T15:30:00+09:00');
    expect(r.valid).toBe(false);
  });

  it('rejects a -HH:MM timezone offset', () => {
    const r = validateOnce('2026-02-01T15:30:00-05:00');
    expect(r.valid).toBe(false);
  });

  it('rejects an unparseable timestamp', () => {
    const r = validateOnce('not-a-date');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/Invalid timestamp/);
  });
});

describe('validateSchedule', () => {
  it('dispatches to validateCron', () => {
    expect(validateSchedule('cron', '*/5 * * * *')).toEqual({ valid: true });
    expect(validateSchedule('cron', 'garbage').valid).toBe(false);
  });

  it('dispatches to validateInterval', () => {
    expect(validateSchedule('interval', '60000')).toEqual({ valid: true });
    expect(validateSchedule('interval', 'nope').valid).toBe(false);
  });

  it('dispatches to validateOnce', () => {
    expect(validateSchedule('once', '2026-02-01T00:00:00')).toEqual({
      valid: true,
    });
    expect(validateSchedule('once', '2026-02-01T00:00:00Z').valid).toBe(false);
  });
});
