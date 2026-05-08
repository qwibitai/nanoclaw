import { describe, expect, test } from 'bun:test';

import { betasForModel } from './claude.js';

describe('betasForModel', () => {
  test('enables context-1m beta for `[1m]` suffix', () => {
    expect(betasForModel('sonnet[1m]')).toEqual(['context-1m-2025-08-07']);
    expect(betasForModel('opus[1m]')).toEqual(['context-1m-2025-08-07']);
    expect(betasForModel('claude-opus-4-7[1m]')).toEqual(['context-1m-2025-08-07']);
  });

  test('case-insensitive on the suffix', () => {
    expect(betasForModel('Sonnet[1M]')).toEqual(['context-1m-2025-08-07']);
    expect(betasForModel('Opus[1m]')).toEqual(['context-1m-2025-08-07']);
  });

  test('trims surrounding whitespace before matching', () => {
    expect(betasForModel('  opus[1m]  ')).toEqual(['context-1m-2025-08-07']);
  });

  test('no beta for plain models', () => {
    expect(betasForModel('sonnet')).toBeUndefined();
    expect(betasForModel('opus')).toBeUndefined();
    expect(betasForModel('haiku')).toBeUndefined();
    expect(betasForModel('claude-opus-4-5')).toBeUndefined();
  });

  test('undefined / non-string / empty → undefined', () => {
    expect(betasForModel(undefined)).toBeUndefined();
    expect(betasForModel('')).toBeUndefined();
    expect(betasForModel(null as unknown as string)).toBeUndefined();
  });

  test('`[1m]` must be the trailing token (not mid-string)', () => {
    expect(betasForModel('sonnet[1m]-custom')).toBeUndefined();
    expect(betasForModel('[1m]opus')).toBeUndefined();
  });
});
