import { describe, expect, it } from 'vitest';

import { determineVerifyStatus } from './verify.js';

const healthyBase = {
  service: 'running' as const,
  credentials: 'configured',
  registeredGroups: 1,
};

describe('determineVerifyStatus', () => {
  it('accepts a healthy install with at least one wired agent group', () => {
    expect(determineVerifyStatus(healthyBase)).toBe('success');
  });

  it('fails when no agent groups are registered', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
      }),
    ).toBe('failed');
  });

  it('fails when the service is not running', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        service: 'stopped',
      }),
    ).toBe('failed');
  });

  it('fails when credentials are missing', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        credentials: 'missing',
      }),
    ).toBe('failed');
  });
});
