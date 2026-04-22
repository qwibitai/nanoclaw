import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Reload src/config.js with a freshly-mutated process.env.
 *
 * Each test stubs env vars before calling, then restores the originals.
 * Uses dynamic import + vi-free module cache reset so config.ts is re-evaluated
 * with the new environment rather than returning a cached copy from a prior test.
 */
async function loadConfigWithEnv(
  env: Record<string, string | undefined>,
): Promise<typeof import('./config.js')> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  try {
    const mod = await import(`./config.js?nonce=${Math.random()}`);
    return mod;
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('numeric config parsing', () => {
  const envKeys = [
    'CONTAINER_TIMEOUT',
    'CONTAINER_MAX_OUTPUT_SIZE',
    'IDLE_TIMEOUT',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('falls back to default when env vars are non-numeric', async () => {
    const cfg = await loadConfigWithEnv({
      CONTAINER_TIMEOUT: 'thirty-minutes',
      CONTAINER_MAX_OUTPUT_SIZE: 'big',
      IDLE_TIMEOUT: 'abc',
    });

    // Before the fix these would be NaN, which setTimeout treats as 1ms —
    // causing containers to die the instant they start.
    expect(Number.isFinite(cfg.CONTAINER_TIMEOUT)).toBe(true);
    expect(Number.isFinite(cfg.CONTAINER_MAX_OUTPUT_SIZE)).toBe(true);
    expect(Number.isFinite(cfg.IDLE_TIMEOUT)).toBe(true);

    expect(cfg.CONTAINER_TIMEOUT).toBe(1800000);
    expect(cfg.CONTAINER_MAX_OUTPUT_SIZE).toBe(10485760);
    expect(cfg.IDLE_TIMEOUT).toBe(1800000);
  });

  it('clamps zero and negative values to a safe minimum', async () => {
    const cfg = await loadConfigWithEnv({
      CONTAINER_TIMEOUT: '0',
      CONTAINER_MAX_OUTPUT_SIZE: '-5',
      IDLE_TIMEOUT: '0',
    });

    // "0" would previously cause setTimeout(fn, 0) — immediate timeout.
    // Fallback to default on 0, floor of 1 on negatives.
    expect(cfg.CONTAINER_TIMEOUT).toBeGreaterThanOrEqual(1);
    expect(cfg.CONTAINER_MAX_OUTPUT_SIZE).toBeGreaterThanOrEqual(1);
    expect(cfg.IDLE_TIMEOUT).toBeGreaterThanOrEqual(1);
  });

  it('preserves valid positive numeric env values', async () => {
    const cfg = await loadConfigWithEnv({
      CONTAINER_TIMEOUT: '60000',
      CONTAINER_MAX_OUTPUT_SIZE: '2048',
      IDLE_TIMEOUT: '5000',
    });

    expect(cfg.CONTAINER_TIMEOUT).toBe(60000);
    expect(cfg.CONTAINER_MAX_OUTPUT_SIZE).toBe(2048);
    expect(cfg.IDLE_TIMEOUT).toBe(5000);
  });
});
