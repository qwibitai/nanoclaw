import { describe, expect, it } from 'vitest';

import { runPreHook } from './pre-hook.js';

describe('runPreHook', () => {
  it('exit 0 returns proceed', async () => {
    const result = await runPreHook({ command: 'exit 0' });
    expect(result.action).toBe('proceed');
    expect(result.exitCode).toBe(0);
  });

  it('exit 10 returns skip', async () => {
    const result = await runPreHook({ command: 'exit 10' });
    expect(result.action).toBe('skip');
    expect(result.exitCode).toBe(10);
  });

  it('exit 1 returns error', async () => {
    const result = await runPreHook({ command: 'exit 1' });
    expect(result.action).toBe('error');
    expect(result.exitCode).toBe(1);
  });

  it('exit 42 returns error', async () => {
    const result = await runPreHook({ command: 'exit 42' });
    expect(result.action).toBe('error');
    expect(result.exitCode).toBe(42);
  });

  it('captures stdout', async () => {
    const result = await runPreHook({ command: 'echo hello' });
    expect(result.action).toBe('proceed');
    expect(result.stdout.trim()).toBe('hello');
  });

  it('captures stderr on error', async () => {
    const result = await runPreHook({ command: 'echo err >&2; exit 1' });
    expect(result.action).toBe('error');
    expect(result.stderr.trim()).toBe('err');
  });

  it('returns error on timeout', async () => {
    const result = await runPreHook({ command: 'sleep 10', timeout_seconds: 1 });
    expect(result.action).toBe('error');
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('timed out');
  });

  it('clamps timeout to 300s max', async () => {
    // Just verify it doesn't throw — the 999s timeout is clamped to 300s
    const result = await runPreHook({
      command: 'exit 0',
      timeout_seconds: 999,
    });
    expect(result.action).toBe('proceed');
  });

  it('tracks duration', async () => {
    const result = await runPreHook({ command: 'exit 0' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
