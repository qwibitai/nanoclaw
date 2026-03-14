import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractRateLimitResetAt, parseRateLimitResetFromText } from './index.js';

describe('extractRateLimitResetAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Non-rate-limit errors return undefined ---

  it('returns undefined for a non-429 error', () => {
    expect(extractRateLimitResetAt(new Error('generic error'))).toBeUndefined();
  });

  it('returns undefined for a 500 status error', () => {
    expect(extractRateLimitResetAt({ status: 500, headers: new Headers() })).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(extractRateLimitResetAt(null)).toBeUndefined();
  });

  it('returns undefined for a 429 error with no headers', () => {
    expect(extractRateLimitResetAt({ status: 429 })).toBeUndefined();
  });

  it('returns undefined for a 429 error with a plain object instead of Headers', () => {
    // Verifies we check typeof headers.get === 'function' — bracket access would
    // return undefined silently; we want to handle this case explicitly.
    const err = {
      status: 429,
      headers: { 'anthropic-ratelimit-requests-reset': '2025-01-01T00:01:00.000Z' },
    };
    expect(extractRateLimitResetAt(err)).toBeUndefined();
  });

  // --- anthropic-ratelimit-*-reset headers ---

  it('extracts anthropic-ratelimit-requests-reset via Headers.get()', () => {
    const headers = new Headers({
      'anthropic-ratelimit-requests-reset': '2025-01-01T00:01:00.000Z',
    });
    const result = extractRateLimitResetAt({ status: 429, headers });
    expect(result).toBe('2025-01-01T00:01:00.000Z');
  });

  it('extracts anthropic-ratelimit-tokens-reset via Headers.get()', () => {
    const headers = new Headers({
      'anthropic-ratelimit-tokens-reset': '2025-01-01T00:02:00.000Z',
    });
    expect(extractRateLimitResetAt({ status: 429, headers })).toBe('2025-01-01T00:02:00.000Z');
  });

  it('returns the latest reset time when multiple headers are present', () => {
    const headers = new Headers({
      'anthropic-ratelimit-requests-reset': '2025-01-01T00:01:00.000Z',
      'anthropic-ratelimit-tokens-reset':   '2025-01-01T00:03:00.000Z', // latest
      'anthropic-ratelimit-input-tokens-reset': '2025-01-01T00:02:00.000Z',
    });
    expect(extractRateLimitResetAt({ status: 429, headers })).toBe('2025-01-01T00:03:00.000Z');
  });

  // --- retry-after fallback ---

  it('handles retry-after as a number of seconds', () => {
    const headers = new Headers({ 'retry-after': '60' });
    const result = extractRateLimitResetAt({ status: 429, headers });
    // Fake time is 2025-01-01T00:00:00Z + 60s = 2025-01-01T00:01:00Z
    expect(result).toBe('2025-01-01T00:01:00.000Z');
  });

  it('handles retry-after as an HTTP date string', () => {
    const headers = new Headers({ 'retry-after': '2025-01-01T00:05:00.000Z' });
    const result = extractRateLimitResetAt({ status: 429, headers });
    expect(result).toBe('2025-01-01T00:05:00.000Z');
  });

  it('returns undefined for an unparseable retry-after value', () => {
    const headers = new Headers({ 'retry-after': 'not-a-date' });
    expect(extractRateLimitResetAt({ status: 429, headers })).toBeUndefined();
  });

  it('prefers anthropic-ratelimit-*-reset over retry-after when both present', () => {
    const headers = new Headers({
      'anthropic-ratelimit-requests-reset': '2025-01-01T00:01:00.000Z',
      'retry-after': '300', // 5 minutes — would be later, but should be ignored
    });
    expect(extractRateLimitResetAt({ status: 429, headers })).toBe('2025-01-01T00:01:00.000Z');
  });

  it('returns undefined when no reset headers and no retry-after', () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    expect(extractRateLimitResetAt({ status: 429, headers })).toBeUndefined();
  });
});

describe('parseRateLimitResetFromText', () => {
  // Fake time: 2025-01-01T08:00:00Z = 2025-01-01 00:00:00 PST (UTC-8)
  const BASE_UTC = '2025-01-01T08:00:00.000Z';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_UTC));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for text without a reset pattern', () => {
    expect(parseRateLimitResetFromText('Hello, how can I help you?')).toBeUndefined();
    expect(parseRateLimitResetFromText('')).toBeUndefined();
  });

  it('parses the full Claude rate-limit notice format', () => {
    // "resets 2am" in PST → 2025-01-01 02:00:00 PST = 2025-01-01T10:00:00Z (in the future)
    const result = parseRateLimitResetFromText(
      "You've hit your usage limit · resets 2am (America/Los_Angeles)",
    );
    expect(result?.toISOString()).toBe('2025-01-01T10:00:00.000Z');
  });

  it('parses "resets at 2am (America/Los_Angeles)"', () => {
    const result = parseRateLimitResetFromText('resets at 2am (America/Los_Angeles)');
    expect(result?.toISOString()).toBe('2025-01-01T10:00:00.000Z');
  });

  it('parses hours with minutes: "resets 2:30pm (America/New_York)"', () => {
    // EST = UTC-5 in January
    // 2:30pm EST = 14:30 EST = 19:30 UTC, which is in the future from 08:00Z
    const result = parseRateLimitResetFromText('resets 2:30pm (America/New_York)');
    expect(result?.toISOString()).toBe('2025-01-01T19:30:00.000Z');
  });

  it('handles 12am (midnight) — converts to hour24=0', () => {
    // Current time IS midnight PST (2025-01-01T08:00:00Z = 00:00 PST)
    // Today's midnight PST = 2025-01-01T08:00:00Z — not strictly > now, so use tomorrow
    const result = parseRateLimitResetFromText('resets 12am (America/Los_Angeles)');
    expect(result?.toISOString()).toBe('2025-01-02T08:00:00.000Z');
  });

  it('handles 12pm (noon) — converts to hour24=12', () => {
    // Noon PST = 2025-01-01T20:00:00Z — in the future from 08:00Z
    const result = parseRateLimitResetFromText('resets 12pm (America/Los_Angeles)');
    expect(result?.toISOString()).toBe('2025-01-01T20:00:00.000Z');
  });

  it('returns the next-day occurrence when the reset time has already passed today', () => {
    // Advance fake time to noon PST (20:00Z)
    vi.setSystemTime(new Date('2025-01-01T20:00:00.000Z'));

    // "resets 2am PST" = 2025-01-01T10:00:00Z — already in the past
    // Next occurrence: 2025-01-02 02:00 PST = 2025-01-02T10:00:00Z
    const result = parseRateLimitResetFromText('resets 2am (America/Los_Angeles)');
    expect(result?.toISOString()).toBe('2025-01-02T10:00:00.000Z');
  });

  it('falls back to UTC when no timezone is specified', () => {
    // Current: 2025-01-01T08:00:00Z
    // "resets 2am" (no TZ) → UTC → today's 2am UTC = 2025-01-01T02:00:00Z is in the past
    // Next occurrence: 2025-01-02T02:00:00Z
    const result = parseRateLimitResetFromText('resets 2am');
    expect(result?.toISOString()).toBe('2025-01-02T02:00:00.000Z');
  });

  it('falls back to UTC for an unrecognised timezone string', () => {
    const result = parseRateLimitResetFromText('resets 2am (INVALID_TZ_XYZ)');
    expect(result?.toISOString()).toBe('2025-01-02T02:00:00.000Z');
  });

  // --- DST: summer offset differs from winter ---

  it('uses the correct DST offset (PDT = UTC-7) in summer', () => {
    // 2025-07-01T08:00:00Z = 2025-07-01 01:00:00 PDT (UTC-7, summer time)
    vi.setSystemTime(new Date('2025-07-01T08:00:00.000Z'));
    // "resets 2am (America/Los_Angeles)" — PDT = UTC-7, so 2am PDT = 09:00 UTC
    // 2am is still in the future (current is 1am PDT)
    const result = parseRateLimitResetFromText('resets 2am (America/Los_Angeles)');
    expect(result?.toISOString()).toBe('2025-07-01T09:00:00.000Z');
  });

  // --- False-positive protection ---

  it('does NOT match "reset at 8am" (missing trailing s)', () => {
    // Ordinary sentences should not be treated as rate-limit notices.
    // The regex requires "resets" (with 's') to match Claude's specific format.
    expect(parseRateLimitResetFromText('I reset at 8am every morning')).toBeUndefined();
    expect(parseRateLimitResetFromText('Please reset at 8am')).toBeUndefined();
  });

  it('matches the pattern embedded in a multi-line agent result', () => {
    // Claude may include extra explanation before the rate-limit line
    const multiLine = [
      "I'm unable to complete your request right now.",
      "You've hit your usage limit · resets 2am (America/Los_Angeles)",
      'Please try again later.',
    ].join('\n');
    const result = parseRateLimitResetFromText(multiLine);
    expect(result?.toISOString()).toBe('2025-01-01T10:00:00.000Z');
  });
});
