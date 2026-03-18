/**
 * Tests for staging instance isolation (NANOCLAW_INSTANCE).
 *
 * INVARIANT: When NANOCLAW_INSTANCE is unset, all config values are identical
 * to the pre-isolation behavior. When set, all conflicting resources are
 * namespaced by the instance ID.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

describe('instance isolation — config.ts', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('INSTANCE_ID is empty when NANOCLAW_INSTANCE is unset', async () => {
    delete process.env.NANOCLAW_INSTANCE;
    const config = await import('./config.js');
    expect(config.INSTANCE_ID).toBe('');
  });

  it('INSTANCE_ID reflects NANOCLAW_INSTANCE value', async () => {
    process.env.NANOCLAW_INSTANCE = 'staging';
    const config = await import('./config.js');
    expect(config.INSTANCE_ID).toBe('staging');
  });

  it('directories are unsuffixed when NANOCLAW_INSTANCE is unset', async () => {
    delete process.env.NANOCLAW_INSTANCE;
    const config = await import('./config.js');
    expect(config.STORE_DIR).toMatch(/\/store$/);
    expect(config.GROUPS_DIR).toMatch(/\/groups$/);
    expect(config.DATA_DIR).toMatch(/\/data$/);
  });

  it('directories are suffixed with instance ID when set', async () => {
    process.env.NANOCLAW_INSTANCE = 'staging';
    const config = await import('./config.js');
    expect(config.STORE_DIR).toMatch(/\/store-staging$/);
    expect(config.GROUPS_DIR).toMatch(/\/groups-staging$/);
    expect(config.DATA_DIR).toMatch(/\/data-staging$/);
  });

  it('CONTAINER_IMAGE defaults to :latest when NANOCLAW_INSTANCE is unset', async () => {
    delete process.env.NANOCLAW_INSTANCE;
    delete process.env.CONTAINER_IMAGE;
    const config = await import('./config.js');
    expect(config.CONTAINER_IMAGE).toBe('nanoclaw-agent:latest');
  });

  it('CONTAINER_IMAGE defaults to :staging when NANOCLAW_INSTANCE=staging', async () => {
    process.env.NANOCLAW_INSTANCE = 'staging';
    delete process.env.CONTAINER_IMAGE;
    const config = await import('./config.js');
    expect(config.CONTAINER_IMAGE).toBe('nanoclaw-agent:staging');
  });

  it('explicit CONTAINER_IMAGE overrides instance default', async () => {
    process.env.NANOCLAW_INSTANCE = 'staging';
    process.env.CONTAINER_IMAGE = 'custom:v2';
    const config = await import('./config.js');
    expect(config.CONTAINER_IMAGE).toBe('custom:v2');
  });

  it('CONTAINER_NAME_PREFIX is nanoclaw- when NANOCLAW_INSTANCE is unset', async () => {
    delete process.env.NANOCLAW_INSTANCE;
    const config = await import('./config.js');
    expect(config.CONTAINER_NAME_PREFIX).toBe('nanoclaw-');
  });

  it('CONTAINER_NAME_PREFIX is nanoclaw-staging- when NANOCLAW_INSTANCE=staging', async () => {
    process.env.NANOCLAW_INSTANCE = 'staging';
    const config = await import('./config.js');
    expect(config.CONTAINER_NAME_PREFIX).toBe('nanoclaw-staging-');
  });

  it('CREDENTIAL_PROXY_PORT defaults to 3001 when NANOCLAW_INSTANCE is unset', async () => {
    delete process.env.NANOCLAW_INSTANCE;
    delete process.env.CREDENTIAL_PROXY_PORT;
    const config = await import('./config.js');
    expect(config.CREDENTIAL_PROXY_PORT).toBe(3001);
  });

  it('CREDENTIAL_PROXY_PORT defaults to 3002 when NANOCLAW_INSTANCE=staging', async () => {
    process.env.NANOCLAW_INSTANCE = 'staging';
    delete process.env.CREDENTIAL_PROXY_PORT;
    const config = await import('./config.js');
    expect(config.CREDENTIAL_PROXY_PORT).toBe(3002);
  });

  it('CREDENTIAL_PROXY_PORT defaults to 3002 for any instance ID', async () => {
    process.env.NANOCLAW_INSTANCE = 'test';
    delete process.env.CREDENTIAL_PROXY_PORT;
    const config = await import('./config.js');
    expect(config.CREDENTIAL_PROXY_PORT).toBe(3002);
  });

  it('explicit CREDENTIAL_PROXY_PORT overrides instance default', async () => {
    process.env.NANOCLAW_INSTANCE = 'staging';
    process.env.CREDENTIAL_PROXY_PORT = '4000';
    const config = await import('./config.js');
    expect(config.CREDENTIAL_PROXY_PORT).toBe(4000);
  });
});

describe('instance isolation — env.ts', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('reads .env when NANOCLAW_INSTANCE is unset', async () => {
    delete process.env.NANOCLAW_INSTANCE;

    const fs = await import('fs');
    const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync');
    readFileSyncSpy.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith('.env')) return 'FOO=bar\n';
      throw new Error('ENOENT');
    });

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });

    readFileSyncSpy.mockRestore();
  });

  it('instance env file takes priority over base .env', async () => {
    process.env.NANOCLAW_INSTANCE = 'staging';

    const fs = await import('fs');
    const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync');
    readFileSyncSpy.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith('.env.staging'))
        return 'FOO=staging-val\nBAR=staging-bar\n';
      if (p.endsWith('.env')) return 'FOO=base-val\nBAZ=base-baz\n';
      throw new Error('ENOENT');
    });

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['FOO', 'BAZ']);
    expect(result.FOO).toBe('staging-val');
    expect(result.BAZ).toBe('base-baz');

    readFileSyncSpy.mockRestore();
  });

  it('falls back to .env when instance file does not exist', async () => {
    process.env.NANOCLAW_INSTANCE = 'staging';

    const fs = await import('fs');
    const readFileSyncSpy = vi.spyOn(fs.default, 'readFileSync');
    readFileSyncSpy.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith('.env.staging')) throw new Error('ENOENT');
      if (p.endsWith('.env')) return 'KEY=fallback\n';
      throw new Error('ENOENT');
    });

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'fallback' });

    readFileSyncSpy.mockRestore();
  });
});
