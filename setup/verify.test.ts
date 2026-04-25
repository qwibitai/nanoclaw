import { describe, expect, it } from 'vitest';

import { determineVerifyStatus } from './verify.js';

const healthyBase = {
  service: 'running' as const,
  credentials: 'configured',
  anyChannelConfigured: false,
  registeredGroups: 1,
  agentPing: 'ok' as const,
};

describe('determineVerifyStatus', () => {
  it('accepts a working CLI-only install', () => {
    expect(determineVerifyStatus(healthyBase)).toBe('success');
  });

  it('accepts a messaging-channel install when CLI ping is skipped', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        anyChannelConfigured: true,
        agentPing: 'skipped',
      }),
    ).toBe('success');
  });

  it('fails when neither CLI nor messaging channels are usable', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        agentPing: 'skipped',
      }),
    ).toBe('failed');
  });

  it('fails when the CLI agent does not respond', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        anyChannelConfigured: true,
        agentPing: 'no_reply',
      }),
    ).toBe('failed');
  });

  it('fails when no agent groups are registered', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
      }),
    ).toBe('failed');
  });
});
