import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('config path resolution', () => {
  it('expands ~ paths for OpenClaw workspace/auth dirs', async () => {
    vi.resetModules();
    process.env.HOME = '/tmp/hal-home';
    process.env.HAL_WORKSPACE_DIR = '~/.openclaw/workspace';
    process.env.OPENCLAW_AUTH_DIR = '~/.openclaw/store/auth';

    const mod = await import('./config.js');
    expect(mod.OPENCLAW_WORKSPACE_DIR).toBe(
      '/tmp/hal-home/.openclaw/workspace',
    );
    expect(mod.OPENCLAW_AUTH_DIR).toBe('/tmp/hal-home/.openclaw/store/auth');
  });
});
