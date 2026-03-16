import { describe, it, expect } from 'vitest';
import { shouldSuppressOutput } from './task-scheduler.js';

describe('shouldSuppressOutput', () => {
  it('suppresses empty string', () => {
    expect(shouldSuppressOutput('')).toBe(true);
    expect(shouldSuppressOutput('   ')).toBe(true);
  });

  it('suppresses "All bots healthy" variants', () => {
    expect(shouldSuppressOutput('All bots healthy — no output needed.')).toBe(true);
    expect(shouldSuppressOutput('All bots are healthy — no output needed.')).toBe(true);
    expect(shouldSuppressOutput('All bots healthy — nothing to report.')).toBe(true);
    expect(shouldSuppressOutput('All bot healthy — no output needed.')).toBe(true);
  });

  it('suppresses "nothing to report" variants', () => {
    expect(shouldSuppressOutput('Nothing to report.')).toBe(true);
    expect(shouldSuppressOutput('  nothing to report  ')).toBe(true);
    expect(shouldSuppressOutput('No output needed.')).toBe(true);
    expect(shouldSuppressOutput('No alerts needed.')).toBe(true);
    expect(shouldSuppressOutput('No changes needed.')).toBe(true);
  });

  it('does NOT suppress real alerts', () => {
    expect(shouldSuppressOutput('DB is down. Container stopped.')).toBe(false);
    expect(shouldSuppressOutput('🔴 CRITICAL — DB has been down for 10 minutes')).toBe(false);
    expect(shouldSuppressOutput('Nook is back (was down)')).toBe(false);
    expect(shouldSuppressOutput('All bots healthy but there is a trend to watch')).toBe(false);
  });

  it('does NOT suppress multi-line messages', () => {
    expect(shouldSuppressOutput('All bots healthy\nBut also check this')).toBe(false);
  });

  it('supports extra patterns', () => {
    const extra = [/^custom suppression$/i];
    expect(shouldSuppressOutput('custom suppression', extra)).toBe(true);
    expect(shouldSuppressOutput('not matching', extra)).toBe(false);
  });
});
