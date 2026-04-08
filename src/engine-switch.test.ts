import { describe, expect, it } from 'vitest';

import {
  classifyProviderFailure,
  getEngineOrder,
  shouldFailover,
} from './engine-switch.js';

describe('engine switch helper', () => {
  it('classifies Claude rate-limit output as quota failure', () => {
    expect(classifyProviderFailure("You've hit your limit · resets 4am")).toBe(
      'quota',
    );
  });

  it('classifies Claude 401 output as auth failure', () => {
    expect(
      classifyProviderFailure(
        'Failed to authenticate. API Error: 401 Unauthorized',
      ),
    ).toBe('auth');
  });

  it('treats quota and auth failures as failover triggers', () => {
    expect(shouldFailover('quota')).toBe(true);
    expect(shouldFailover('auth')).toBe(true);
    expect(shouldFailover('config')).toBe(false);
    expect(shouldFailover('retryable')).toBe(false);
  });

  it('orders the preferred engine first', () => {
    expect(getEngineOrder('claude')).toEqual(['claude', 'codex']);
    expect(getEngineOrder('codex')).toEqual(['codex', 'claude']);
  });
});
