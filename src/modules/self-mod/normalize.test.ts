import { describe, it, expect } from 'vitest';

import { normalizeStringArray } from './normalize.js';

describe('normalizeStringArray', () => {
  it('passes through a clean string array', () => {
    expect(normalizeStringArray(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for an empty array', () => {
    expect(normalizeStringArray([])).toEqual([]);
  });

  it('parses a JSON-encoded array string (the issue #2051 case)', () => {
    expect(normalizeStringArray('["@playwright/mcp@latest", "--browser=chromium"]')).toEqual([
      '@playwright/mcp@latest',
      '--browser=chromium',
    ]);
  });

  it('parses a JSON-encoded array string with leading/trailing whitespace', () => {
    expect(normalizeStringArray('   ["x", "y"]   ')).toEqual(['x', 'y']);
  });

  it('treats a plain non-JSON string as a single-element array', () => {
    expect(normalizeStringArray('--flag')).toEqual(['--flag']);
  });

  it('treats malformed JSON-looking strings as a single-element array', () => {
    expect(normalizeStringArray('[unclosed')).toEqual(['[unclosed']);
  });

  it('drops non-string elements from an array', () => {
    expect(normalizeStringArray(['a', 1, null, 'b', undefined, { x: 1 }])).toEqual(['a', 'b']);
  });

  it('drops non-string elements from a JSON-encoded array', () => {
    expect(normalizeStringArray('["a", 1, null, "b"]')).toEqual(['a', 'b']);
  });

  it('returns [] for undefined', () => {
    expect(normalizeStringArray(undefined)).toEqual([]);
  });

  it('returns [] for null', () => {
    expect(normalizeStringArray(null)).toEqual([]);
  });

  it('returns [] for a number', () => {
    expect(normalizeStringArray(42)).toEqual([]);
  });

  it('returns [] for an object', () => {
    expect(normalizeStringArray({ args: ['a', 'b'] })).toEqual([]);
  });

  it('returns [] for a JSON-encoded object string (not an array)', () => {
    expect(normalizeStringArray('{"a": 1}')).toEqual(['{"a": 1}']);
  });
});
