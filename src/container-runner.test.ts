import { describe, expect, it } from 'vitest';

import { resolveModelName, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('resolveModelName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveModelName('sonnet[1m]', 'opus[1m]', 'haiku')).toBe('sonnet[1m]');
  });

  it('falls back to group when session is null', () => {
    expect(resolveModelName(null, 'opus[1m]', 'haiku')).toBe('opus[1m]');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveModelName(null, null, 'haiku')).toBe('haiku');
  });

  it('returns undefined when nothing is set (provider default)', () => {
    expect(resolveModelName(null, null, undefined)).toBeUndefined();
  });

  it('preserves case — model names are opaque', () => {
    expect(resolveModelName('Sonnet[1M]', null, null)).toBe('Sonnet[1M]');
    expect(resolveModelName(null, 'GPT-5.4-mini', null)).toBe('GPT-5.4-mini');
  });

  it('trims whitespace', () => {
    expect(resolveModelName('  sonnet[1m]  ', null, null)).toBe('sonnet[1m]');
  });

  it('treats empty / whitespace-only as unset (falls through)', () => {
    expect(resolveModelName('', 'opus[1m]', null)).toBe('opus[1m]');
    expect(resolveModelName('   ', null, 'haiku')).toBe('haiku');
    expect(resolveModelName(null, '', 'haiku')).toBe('haiku');
  });
});
