import { describe, expect, test } from 'bun:test';

import { resolveModel, resolveProvider } from './config.js';

describe('resolveProvider', () => {
  test('env wins over config', () => {
    expect(resolveProvider('codex', 'claude')).toBe('codex');
  });

  test('config used when env is unset', () => {
    expect(resolveProvider(undefined, 'opencode')).toBe('opencode');
  });

  test('defaults to claude when both are absent', () => {
    expect(resolveProvider(undefined, undefined)).toBe('claude');
  });

  test('empty / whitespace env falls through to config', () => {
    expect(resolveProvider('', 'codex')).toBe('codex');
    expect(resolveProvider('   ', 'codex')).toBe('codex');
  });

  test('empty / whitespace config falls through to default', () => {
    expect(resolveProvider(undefined, '')).toBe('claude');
    expect(resolveProvider(undefined, '   ')).toBe('claude');
  });

  test('non-string config (e.g. numeric) is ignored', () => {
    expect(resolveProvider(undefined, 42)).toBe('claude');
    expect(resolveProvider(undefined, null)).toBe('claude');
  });

  test('trims env and config', () => {
    expect(resolveProvider('  codex  ', undefined)).toBe('codex');
    expect(resolveProvider(undefined, '  opencode  ')).toBe('opencode');
  });
});

describe('resolveModel', () => {
  test('env wins over config', () => {
    expect(resolveModel('opus[1m]', 'sonnet')).toBe('opus[1m]');
  });

  test('config used when env is unset', () => {
    expect(resolveModel(undefined, 'sonnet[1m]')).toBe('sonnet[1m]');
  });

  test('returns undefined when both absent — provider picks its own default', () => {
    expect(resolveModel(undefined, undefined)).toBeUndefined();
  });

  test('preserves case — model names are opaque', () => {
    expect(resolveModel('Sonnet[1M]', undefined)).toBe('Sonnet[1M]');
    expect(resolveModel(undefined, 'GPT-5.4-mini')).toBe('GPT-5.4-mini');
  });

  test('empty / whitespace env falls through to config', () => {
    expect(resolveModel('', 'haiku')).toBe('haiku');
    expect(resolveModel('   ', 'haiku')).toBe('haiku');
  });

  test('empty / whitespace config falls through to undefined', () => {
    expect(resolveModel(undefined, '')).toBeUndefined();
    expect(resolveModel(undefined, '   ')).toBeUndefined();
  });

  test('non-string config (numeric, null) is ignored', () => {
    expect(resolveModel(undefined, 42)).toBeUndefined();
    expect(resolveModel(undefined, null)).toBeUndefined();
  });

  test('trims whitespace', () => {
    expect(resolveModel('  opus[1m]  ', undefined)).toBe('opus[1m]');
    expect(resolveModel(undefined, '  sonnet[1m]  ')).toBe('sonnet[1m]');
  });
});
