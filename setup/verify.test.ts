import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCheckCredentials, mockEmitStatus } = vi.hoisted(() => ({
  mockCheckCredentials: vi.fn(),
  mockEmitStatus: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  checkCredentials: mockCheckCredentials,
}));

vi.mock('./status.js', () => ({
  emitStatus: mockEmitStatus,
}));

vi.mock('./platform.js', () => ({
  getPlatform: vi.fn(() => 'linux'),
  getServiceManager: vi.fn(() => 'none'),
  hasSystemd: vi.fn(() => false),
  isRoot: vi.fn(() => false),
}));

vi.mock('../src/config.js', () => ({
  STORE_DIR: '/tmp/nanoclaw-test-store',
}));

vi.mock('../src/env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(() => ({
    prepare: () => ({ get: () => ({ count: 0 }) }),
    close: () => {},
  })),
}));

import fs from 'fs';

import { run } from './verify.js';

describe('verify credentials health', () => {
  beforeEach(() => {
    mockCheckCredentials.mockReset();
    mockEmitStatus.mockReset();
    vi.restoreAllMocks();
  });

  it('reports configured_valid when credential probe succeeds', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      return String(filePath).endsWith('.env');
    });
    mockCheckCredentials.mockResolvedValue({
      status: 'success',
      error: '',
      authMode: 'api-key',
      upstream: 'https://api.anthropic.com',
      model: 'none',
      authProbe: 'ok',
      authHttpStatus: 200,
      modelProbe: 'skipped',
      modelHttpStatus: 0,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as (code?: string | number | null | undefined) => never);

    await expect(run([])).rejects.toThrow('process.exit');

    expect(mockEmitStatus).toHaveBeenCalledWith(
      'VERIFY',
      expect.objectContaining({
        CREDENTIALS: 'configured_valid',
        CREDENTIAL_HEALTH: 'valid',
        CREDENTIAL_ERROR: '',
      }),
    );

    exitSpy.mockRestore();
  });

  it('reports configured_invalid when credential probe fails', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      return String(filePath).endsWith('.env');
    });
    mockCheckCredentials.mockResolvedValue({
      status: 'failed',
      error: 'Invalid OAuth token',
      authMode: 'oauth',
      upstream: 'https://api.anthropic.com',
      model: 'none',
      authProbe: 'failed',
      authHttpStatus: 401,
      modelProbe: 'skipped',
      modelHttpStatus: 0,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as (code?: string | number | null | undefined) => never);

    await expect(run([])).rejects.toThrow('process.exit');

    expect(mockEmitStatus).toHaveBeenCalledWith(
      'VERIFY',
      expect.objectContaining({
        CREDENTIALS: 'configured_invalid',
        CREDENTIAL_HEALTH: 'invalid',
        CREDENTIAL_ERROR: 'Invalid OAuth token',
      }),
    );

    exitSpy.mockRestore();
  });

  it('treats missing credentials as missing instead of invalid', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      return String(filePath).endsWith('.env');
    });
    mockCheckCredentials.mockResolvedValue({
      status: 'failed',
      error: 'no_configured_credentials',
      authMode: 'oauth',
      upstream: 'https://api.anthropic.com',
      model: 'none',
      authProbe: 'missing',
      authHttpStatus: 0,
      modelProbe: 'skipped',
      modelHttpStatus: 0,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as (code?: string | number | null | undefined) => never);

    await expect(run([])).rejects.toThrow('process.exit');

    expect(mockEmitStatus).toHaveBeenCalledWith(
      'VERIFY',
      expect.objectContaining({
        CREDENTIALS: 'missing',
        CREDENTIAL_HEALTH: 'not_checked',
        CREDENTIAL_ERROR: 'no_configured_credentials',
      }),
    );

    exitSpy.mockRestore();
  });

  it('runs credential verification for ANTHROPIC_AUTH_TOKEN setups', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      return String(filePath).endsWith('.env');
    });
    mockCheckCredentials.mockResolvedValue({
      status: 'success',
      error: '',
      authMode: 'oauth',
      upstream: 'https://api.anthropic.com',
      model: 'none',
      authProbe: 'ok',
      authHttpStatus: 200,
      modelProbe: 'skipped',
      modelHttpStatus: 0,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as (code?: string | number | null | undefined) => never);

    await expect(run([])).rejects.toThrow('process.exit');

    expect(mockCheckCredentials).toHaveBeenCalledTimes(1);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'VERIFY',
      expect.objectContaining({
        CREDENTIALS: 'configured_valid',
        CREDENTIAL_HEALTH: 'valid',
      }),
    );

    exitSpy.mockRestore();
  });
});