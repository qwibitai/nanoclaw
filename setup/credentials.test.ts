import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDetectAuthMode,
  mockStartCredentialProxy,
  mockReadEnvFile,
  mockEmitStatus,
} = vi.hoisted(() => ({
  mockDetectAuthMode: vi.fn(),
  mockStartCredentialProxy: vi.fn(),
  mockReadEnvFile: vi.fn(),
  mockEmitStatus: vi.fn(),
}));

vi.mock('../src/credential-proxy.js', () => ({
  detectAuthMode: mockDetectAuthMode,
  startCredentialProxy: mockStartCredentialProxy,
}));

vi.mock('../src/env.js', () => ({
  readEnvFile: mockReadEnvFile,
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('./status.js', () => ({
  emitStatus: mockEmitStatus,
}));

import { extractTemporaryApiKey, run } from './credentials.js';

describe('extractTemporaryApiKey', () => {
  it('extracts a top-level api_key', () => {
    expect(extractTemporaryApiKey({ api_key: 'temp-key' })).toBe('temp-key');
  });

  it('extracts a nested temporary key', () => {
    expect(
      extractTemporaryApiKey({ data: { temporary_api_key: 'temp-key' } }),
    ).toBe('temp-key');
  });
});

describe('credentials setup step', () => {
  beforeEach(() => {
    mockEmitStatus.mockReset();
    mockReadEnvFile.mockReset();
    mockDetectAuthMode.mockReset();
    mockStartCredentialProxy.mockReset();
    global.fetch = vi.fn() as typeof fetch;
    mockStartCredentialProxy.mockResolvedValue({
      address: () => ({ port: 43123 }),
      close: (cb: () => void) => cb(),
    });
  });

  it('passes API-key auth probe and model probe', async () => {
    mockReadEnvFile.mockReturnValue({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'claude-3-5-haiku-latest',
    });
    mockDetectAuthMode.mockReturnValue('api-key');

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));

    await run([]);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'CHECK_CREDENTIALS',
      expect.objectContaining({
        AUTH_PROBE: 'ok',
        MODEL_PROBE: 'ok',
        STATUS: 'success',
      }),
    );
  });

  it('fails when OAuth exchange fails', async () => {
    mockReadEnvFile.mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    mockDetectAuthMode.mockReturnValue('oauth');

    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Invalid OAuth token' } }), {
        status: 401,
      }),
    );

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as (code?: string | number | null | undefined) => never);

    await expect(run([])).rejects.toThrow('process.exit');

    expect(mockEmitStatus).toHaveBeenCalledWith(
      'CHECK_CREDENTIALS',
      expect.objectContaining({
        AUTH_PROBE: 'failed',
        STATUS: 'failed',
        ERROR: 'Invalid OAuth token',
      }),
    );

    exitSpy.mockRestore();
  });

  it('treats ANTHROPIC_AUTH_TOKEN as a supported OAuth credential', async () => {
    mockReadEnvFile.mockReturnValue({
      ANTHROPIC_AUTH_TOKEN: 'oauth-token',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    mockDetectAuthMode.mockReturnValue('oauth');

    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ api_key: 'temp-key' }), { status: 200 }),
    );

    await run([]);

    expect(mockEmitStatus).toHaveBeenCalledWith(
      'CHECK_CREDENTIALS',
      expect.objectContaining({
        AUTH_PROBE: 'ok',
        STATUS: 'success',
      }),
    );
  });

  it('reports missing when no supported credentials are configured', async () => {
    mockReadEnvFile.mockReturnValue({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    mockDetectAuthMode.mockReturnValue('oauth');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as (code?: string | number | null | undefined) => never);

    await expect(run([])).rejects.toThrow('process.exit');

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'CHECK_CREDENTIALS',
      expect.objectContaining({
        AUTH_PROBE: 'missing',
        MODEL_PROBE: 'skipped',
        STATUS: 'failed',
        ERROR: 'no_configured_credentials',
      }),
    );

    exitSpy.mockRestore();
  });
});