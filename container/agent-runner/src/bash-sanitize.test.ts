import { describe, expect, it } from 'vitest';
import {
  prependUnsetForSecretEnv,
  resolveSanitizedSecretEnvVars,
} from './bash-sanitize.js';

describe('resolveSanitizedSecretEnvVars', () => {
  it('returns the injected secret keys in insertion order', () => {
    expect(
      resolveSanitizedSecretEnvVars({
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        ANTHROPIC_API_KEY: 'api-key',
        ANTHROPIC_BASE_URL: 'https://example.invalid',
        ANTHROPIC_AUTH_TOKEN: 'auth-token',
      }),
    ).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
    ]);
  });

  it('trims blank keys and de-duplicates after trimming', () => {
    expect(
      resolveSanitizedSecretEnvVars({
        ' ANTHROPIC_API_KEY ': 'api-key',
        ANTHROPIC_API_KEY: 'duplicate',
        '   ': 'ignore-me',
      }),
    ).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('returns an empty list when no secrets were injected', () => {
    expect(resolveSanitizedSecretEnvVars()).toEqual([]);
  });
});

describe('prependUnsetForSecretEnv', () => {
  it('prepends an unset command for every injected secret key', () => {
    expect(
      prependUnsetForSecretEnv('echo ok', [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
      ]),
    ).toBe(
      'unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN 2>/dev/null; echo ok',
    );
  });

  it('leaves the command untouched when there are no injected secrets', () => {
    expect(prependUnsetForSecretEnv('echo ok', [])).toBe('echo ok');
  });
});
