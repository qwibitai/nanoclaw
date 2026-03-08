import { describe, it, expect } from 'vitest';

import {
  escapeRegex,
  buildTriggerPattern,
  POLL_INTERVAL,
  SCHEDULER_POLL_INTERVAL,
  IPC_POLL_INTERVAL,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  IDLE_TIMEOUT,
  MAX_CONCURRENT_CONTAINERS,
} from './config.js';

// --- escapeRegex ---

describe('escapeRegex', () => {
  it('returns plain strings unchanged', () => {
    expect(escapeRegex('hello')).toBe('hello');
    expect(escapeRegex('Andy')).toBe('Andy');
  });

  it('escapes dots', () => {
    expect(escapeRegex('a.b')).toBe('a\\.b');
  });

  it('escapes asterisks', () => {
    expect(escapeRegex('a*b')).toBe('a\\*b');
  });

  it('escapes plus signs', () => {
    expect(escapeRegex('a+b')).toBe('a\\+b');
  });

  it('escapes question marks', () => {
    expect(escapeRegex('a?b')).toBe('a\\?b');
  });

  it('escapes caret and dollar', () => {
    expect(escapeRegex('^start$')).toBe('\\^start\\$');
  });

  it('escapes curly braces', () => {
    expect(escapeRegex('a{1,3}')).toBe('a\\{1,3\\}');
  });

  it('escapes parentheses', () => {
    expect(escapeRegex('(group)')).toBe('\\(group\\)');
  });

  it('escapes pipe', () => {
    expect(escapeRegex('a|b')).toBe('a\\|b');
  });

  it('escapes square brackets', () => {
    expect(escapeRegex('[abc]')).toBe('\\[abc\\]');
  });

  it('escapes backslashes', () => {
    expect(escapeRegex('a\\b')).toBe('a\\\\b');
  });

  it('escapes multiple special characters in one string', () => {
    expect(escapeRegex('Mr. (Bot)')).toBe('Mr\\. \\(Bot\\)');
  });

  it('handles empty string', () => {
    expect(escapeRegex('')).toBe('');
  });
});

// --- buildTriggerPattern ---

describe('buildTriggerPattern', () => {
  it('matches @Name at start of message', () => {
    const pat = buildTriggerPattern('Andy');
    expect(pat.test('@Andy hello')).toBe(true);
  });

  it('is case-insensitive', () => {
    const pat = buildTriggerPattern('Andy');
    expect(pat.test('@andy hello')).toBe(true);
    expect(pat.test('@ANDY hello')).toBe(true);
  });

  it('requires word boundary after name', () => {
    const pat = buildTriggerPattern('Andy');
    expect(pat.test('@Andyextra')).toBe(false);
  });

  it('does not match name mid-message', () => {
    const pat = buildTriggerPattern('Andy');
    expect(pat.test('hey @Andy')).toBe(false);
  });

  it('matches name alone with no trailing text', () => {
    const pat = buildTriggerPattern('Andy');
    expect(pat.test('@Andy')).toBe(true);
  });

  it('handles names with dots — requires literal dot', () => {
    const pat = buildTriggerPattern('Mr.Bot');
    expect(pat.test('@Mr.Bot hello')).toBe(true);
    // Without escaping, "." would match any char — verify it requires literal dot
    expect(pat.test('@MrXBot hello')).toBe(false);
  });

  it('handles names with plus signs', () => {
    const pat = buildTriggerPattern('C++Bot');
    expect(pat.test('@C++Bot hello')).toBe(true);
    expect(pat.test('@CBot hello')).toBe(false);
  });

  it('handles names with spaces', () => {
    const pat = buildTriggerPattern('My Bot');
    expect(pat.test('@My Bot hello')).toBe(true);
    expect(pat.test('@My Botx')).toBe(false);
  });

  it('handles single character names', () => {
    const pat = buildTriggerPattern('X');
    expect(pat.test('@X hello')).toBe(true);
    expect(pat.test('@Xtra')).toBe(false);
  });
});

// --- config constants ---

describe('config constants', () => {
  it('POLL_INTERVAL is a positive number', () => {
    expect(POLL_INTERVAL).toBeGreaterThan(0);
  });

  it('SCHEDULER_POLL_INTERVAL is a positive number', () => {
    expect(SCHEDULER_POLL_INTERVAL).toBeGreaterThan(0);
  });

  it('IPC_POLL_INTERVAL is a positive number', () => {
    expect(IPC_POLL_INTERVAL).toBeGreaterThan(0);
  });

  it('CONTAINER_TIMEOUT is a positive number', () => {
    expect(CONTAINER_TIMEOUT).toBeGreaterThan(0);
  });

  it('CONTAINER_MAX_OUTPUT_SIZE is a positive number', () => {
    expect(CONTAINER_MAX_OUTPUT_SIZE).toBeGreaterThan(0);
  });

  it('IDLE_TIMEOUT is a positive number', () => {
    expect(IDLE_TIMEOUT).toBeGreaterThan(0);
  });

  it('MAX_CONCURRENT_CONTAINERS is at least 1', () => {
    expect(MAX_CONCURRENT_CONTAINERS).toBeGreaterThanOrEqual(1);
  });
});
