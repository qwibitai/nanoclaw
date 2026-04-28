import { describe, it, expect } from 'bun:test';

import { normalizeStringArray } from './self-mod.js';

describe('normalizeStringArray (container side)', () => {
  it('passes through a clean string array', () => {
    expect(normalizeStringArray(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('parses a JSON-encoded array string (the issue #2051 case)', () => {
    expect(normalizeStringArray('["@playwright/mcp@latest", "--browser=chromium"]')).toEqual([
      '@playwright/mcp@latest',
      '--browser=chromium',
    ]);
  });

  it('treats a plain non-JSON string as a single-element array', () => {
    expect(normalizeStringArray('--flag')).toEqual(['--flag']);
  });

  it('treats malformed JSON-looking strings as a single-element array', () => {
    expect(normalizeStringArray('[unclosed')).toEqual(['[unclosed']);
  });

  it('drops non-string elements from arrays', () => {
    expect(normalizeStringArray(['a', 1, null, 'b'])).toEqual(['a', 'b']);
  });

  it('returns [] for undefined, null, numbers, and objects', () => {
    expect(normalizeStringArray(undefined)).toEqual([]);
    expect(normalizeStringArray(null)).toEqual([]);
    expect(normalizeStringArray(42)).toEqual([]);
    expect(normalizeStringArray({ args: ['a'] })).toEqual([]);
  });
});
