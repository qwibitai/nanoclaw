import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must fake timers before importing the module (it has a setInterval at top level)
vi.useFakeTimers();

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { isWebhookRateLimited } from '../stages/webhook-guard.js';
import { RATE_LIMITS } from '../../filters.js';

describe('isWebhookRateLimited', () => {
  beforeEach(() => {
    // Advance time enough to reset windows from prior tests
    vi.advanceTimersByTime(120_000);
  });

  it('allows first request from an IP', () => {
    expect(isWebhookRateLimited('10.0.0.1')).toBe(false);
  });

  it('allows requests within limit', () => {
    const ip = '10.0.0.2';
    for (let i = 0; i < RATE_LIMITS.webhookPerIp.perMinute; i++) {
      expect(isWebhookRateLimited(ip)).toBe(false);
    }
  });

  it('blocks requests exceeding per-minute limit', () => {
    const ip = '10.0.0.3';
    for (let i = 0; i < RATE_LIMITS.webhookPerIp.perMinute; i++) {
      isWebhookRateLimited(ip);
    }
    expect(isWebhookRateLimited(ip)).toBe(true);
  });

  it('resets after window expires', () => {
    const ip = '10.0.0.4';
    for (let i = 0; i < RATE_LIMITS.webhookPerIp.perMinute; i++) {
      isWebhookRateLimited(ip);
    }
    expect(isWebhookRateLimited(ip)).toBe(true);

    // Advance past the 60s window
    vi.advanceTimersByTime(61_000);
    expect(isWebhookRateLimited(ip)).toBe(false);
  });

  it('tracks IPs independently', () => {
    const ip1 = '10.0.0.5';
    const ip2 = '10.0.0.6';
    for (let i = 0; i < RATE_LIMITS.webhookPerIp.perMinute; i++) {
      isWebhookRateLimited(ip1);
    }
    expect(isWebhookRateLimited(ip1)).toBe(true);
    expect(isWebhookRateLimited(ip2)).toBe(false);
  });
});
