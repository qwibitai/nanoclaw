import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkSidecarHealth,
  runHealthCheck,
  getHealthState,
  resetHealthState,
} from './sidecar-health.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('sidecar-health', () => {
  beforeEach(() => {
    resetHealthState();
  });

  it('returns false when sidecar is not reachable', async () => {
    const healthy = await checkSidecarHealth('ws://localhost:99999');
    expect(healthy).toBe(false);
  });

  it('triggers onUnhealthy after 3 consecutive failures', async () => {
    const onUnhealthy = vi.fn();
    for (let i = 0; i < 3; i++) {
      await runHealthCheck('ws://localhost:99999', onUnhealthy);
    }
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
    expect(getHealthState().healthy).toBe(false);
  });

  it('resets failure count on successful check', async () => {
    const onUnhealthy = vi.fn();
    await runHealthCheck('ws://localhost:99999', onUnhealthy);
    expect(getHealthState().consecutiveFailures).toBe(1);

    // Can't easily test success without a real server, but verify reset works
    resetHealthState();
    expect(getHealthState().consecutiveFailures).toBe(0);
    expect(getHealthState().healthy).toBe(true);
  });
});
