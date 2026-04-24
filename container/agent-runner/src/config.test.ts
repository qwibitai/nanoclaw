import { describe, expect, test } from 'bun:test';

import { resolveProvider } from './config.js';

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
