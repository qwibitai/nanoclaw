import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DECRYPT_FAILURE_CONFIG,
  trackDecryptFailure,
  type DecryptFailureConfig,
} from './whatsapp-decrypt-tracker.js';

const CONFIG: DecryptFailureConfig = {
  thresholdCount: 3,
  windowMs: 60_000,
  alertCooldownMs: 10 * 60_000,
};

describe('trackDecryptFailure', () => {
  it('first failure starts a window and does not alert', () => {
    const r = trackDecryptFailure(undefined, 1000, CONFIG);
    expect(r.state).toEqual({ count: 1, firstAt: 1000 });
    expect(r.shouldAlert).toBe(false);
  });

  it('threshold failures within window fire an alert', () => {
    const r1 = trackDecryptFailure(undefined, 1000, CONFIG);
    const r2 = trackDecryptFailure(r1.state, 2000, CONFIG);
    const r3 = trackDecryptFailure(r2.state, 3000, CONFIG);
    expect(r1.shouldAlert).toBe(false);
    expect(r2.shouldAlert).toBe(false);
    expect(r3.shouldAlert).toBe(true);
    expect(r3.state.count).toBe(3);
    expect(r3.state.lastAlertAt).toBe(3000);
  });

  it('failures spread across window resets do not alert', () => {
    // Two failures, then >windowMs later, two more — window resets so count never reaches 3.
    const r1 = trackDecryptFailure(undefined, 0, CONFIG);
    const r2 = trackDecryptFailure(r1.state, 30_000, CONFIG);
    expect(r2.shouldAlert).toBe(false);
    expect(r2.state.count).toBe(2);

    // Past the window — should reset
    const r3 = trackDecryptFailure(r2.state, 90_000, CONFIG);
    expect(r3.state.count).toBe(1);
    expect(r3.state.firstAt).toBe(90_000);
    expect(r3.shouldAlert).toBe(false);

    const r4 = trackDecryptFailure(r3.state, 95_000, CONFIG);
    expect(r4.shouldAlert).toBe(false);
    expect(r4.state.count).toBe(2);
  });

  it('cooldown suppresses repeat alerts', () => {
    let state = trackDecryptFailure(undefined, 1000, CONFIG).state;
    state = trackDecryptFailure(state, 2000, CONFIG).state;
    const firstAlert = trackDecryptFailure(state, 3000, CONFIG);
    expect(firstAlert.shouldAlert).toBe(true);
    state = firstAlert.state;

    // Another batch of 3 failures shortly after — within the cooldown
    state = trackDecryptFailure(state, 4000, CONFIG).state;
    state = trackDecryptFailure(state, 5000, CONFIG).state;
    const suppressed = trackDecryptFailure(state, 6000, CONFIG);
    // count keeps climbing but no second alert
    expect(suppressed.shouldAlert).toBe(false);
    expect(suppressed.state.lastAlertAt).toBe(3000);
  });

  it('alerts again after cooldown elapses', () => {
    let state = trackDecryptFailure(undefined, 1000, CONFIG).state;
    state = trackDecryptFailure(state, 2000, CONFIG).state;
    state = trackDecryptFailure(state, 3000, CONFIG).state;
    // First alert at t=3000.

    // Jump past windowMs + cooldownMs, so window resets and cooldown has elapsed.
    const t = 3000 + CONFIG.alertCooldownMs + 1000;
    state = trackDecryptFailure(state, t, CONFIG).state;
    state = trackDecryptFailure(state, t + 1000, CONFIG).state;
    const second = trackDecryptFailure(state, t + 2000, CONFIG);
    expect(second.shouldAlert).toBe(true);
    expect(second.state.lastAlertAt).toBe(t + 2000);
  });

  it('cooldown survives a window reset', () => {
    // Alert at t=3000.
    let state = trackDecryptFailure(undefined, 1000, CONFIG).state;
    state = trackDecryptFailure(state, 2000, CONFIG).state;
    state = trackDecryptFailure(state, 3000, CONFIG).state;
    expect(state.lastAlertAt).toBe(3000);

    // Reach the threshold again shortly after window reset but well within cooldown.
    const tReset = 3000 + CONFIG.windowMs + 1000; // window reset, cooldown not elapsed
    state = trackDecryptFailure(state, tReset, CONFIG).state;
    state = trackDecryptFailure(state, tReset + 1000, CONFIG).state;
    const r = trackDecryptFailure(state, tReset + 2000, CONFIG);
    expect(r.shouldAlert).toBe(false);
    expect(r.state.lastAlertAt).toBe(3000); // unchanged
  });

  it('respects the configured threshold', () => {
    const cfg: DecryptFailureConfig = { thresholdCount: 5, windowMs: 60_000, alertCooldownMs: 60_000 };
    let state = trackDecryptFailure(undefined, 0, cfg).state;
    for (let i = 1; i < 4; i++) {
      const r = trackDecryptFailure(state, i * 1000, cfg);
      expect(r.shouldAlert).toBe(false);
      state = r.state;
    }
    const r = trackDecryptFailure(state, 5000, cfg);
    expect(r.shouldAlert).toBe(true);
    expect(r.state.count).toBe(5);
  });

  it('default config is exported and reasonable', () => {
    expect(DEFAULT_DECRYPT_FAILURE_CONFIG.thresholdCount).toBeGreaterThan(1);
    expect(DEFAULT_DECRYPT_FAILURE_CONFIG.windowMs).toBeGreaterThan(0);
    expect(DEFAULT_DECRYPT_FAILURE_CONFIG.alertCooldownMs).toBeGreaterThan(DEFAULT_DECRYPT_FAILURE_CONFIG.windowMs);
  });
});
