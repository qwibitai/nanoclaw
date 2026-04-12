import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Top-level mocks for modules that must be intercepted before the   */
/*  source module is imported (OneCLI is instantiated at module scope) */
/* ------------------------------------------------------------------ */

const mockGetContainerConfig = vi.fn();

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: vi.fn().mockImplementation(() => ({
    getContainerConfig: mockGetContainerConfig,
  })),
}));

const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('fs', () => ({
  default: {
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
}));

const mockLoggerWarn = vi.fn();

vi.mock('../core/logger.js', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const mockEnsureGroupIpcLayout = vi.fn();
const mockEnsureSharedSessionSettings = vi.fn();
const mockSyncGroupSkills = vi.fn();

vi.mock('./agent-spawn-layout.js', () => ({
  ensureGroupIpcLayout: (...args: unknown[]) =>
    mockEnsureGroupIpcLayout(...args),
  ensureSharedSessionSettings: (...args: unknown[]) =>
    mockEnsureSharedSessionSettings(...args),
  syncGroupSkills: (...args: unknown[]) => mockSyncGroupSkills(...args),
}));

/* ------------------------------------------------------------------ */
/*  Helper: dynamic import with config overrides                      */
/* ------------------------------------------------------------------ */

async function loadModule(config: {
  ONECLI_URL?: string;
  DATA_DIR?: string;
  GROUPS_DIR?: string;
  NANOCLAW_CONFIG_DIR?: string;
  envFromFile?: Record<string, string>;
}) {
  vi.resetModules();

  // Re-register top-level mocks that resetModules clears.
  // Must use `function` (not arrow) so it is callable with `new`.
  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: function OneCLI() {
      return { getContainerConfig: mockGetContainerConfig };
    },
  }));

  vi.doMock('fs', () => ({
    default: {
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
    },
  }));

  vi.doMock('../core/logger.js', () => ({
    logger: {
      warn: (...args: unknown[]) => mockLoggerWarn(...args),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  }));

  vi.doMock('./agent-spawn-layout.js', () => ({
    ensureGroupIpcLayout: (...args: unknown[]) =>
      mockEnsureGroupIpcLayout(...args),
    ensureSharedSessionSettings: (...args: unknown[]) =>
      mockEnsureSharedSessionSettings(...args),
    syncGroupSkills: (...args: unknown[]) => mockSyncGroupSkills(...args),
  }));

  vi.doMock('../core/config.js', () => ({
    ONECLI_URL: config.ONECLI_URL ?? '',
    DATA_DIR: config.DATA_DIR ?? '/tmp/nanoclaw-test/data',
    GROUPS_DIR: config.GROUPS_DIR ?? '/tmp/nanoclaw-test/groups',
    NANOCLAW_CONFIG_DIR:
      config.NANOCLAW_CONFIG_DIR ?? '/tmp/nanoclaw-test/config',
  }));

  vi.doMock('../core/env.js', () => ({
    readEnvFile: () => config.envFromFile ?? {},
  }));

  vi.doMock('../platform/group-folder.js', () => ({
    resolveGroupFolderPath: (folder: string) =>
      `${config.GROUPS_DIR ?? '/tmp/nanoclaw-test/groups'}/${folder}`,
    resolveGroupIpcPath: (folder: string) =>
      `${config.DATA_DIR ?? '/tmp/nanoclaw-test/data'}/ipc/${folder}`,
  }));

  return import('./agent-spawn-host.js');
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                         */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

/* ================================================================== */
/*  getHostRuntimeCredentialEnv                                       */
/* ================================================================== */

describe('getHostRuntimeCredentialEnv', () => {
  it('returns env from file only when ONECLI_URL is not set', async () => {
    const mod = await loadModule({
      ONECLI_URL: '',
      envFromFile: { ANTHROPIC_API_KEY: 'sk-file-key' },
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.onecliApplied).toBe(false);
    expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'sk-file-key' });
    expect(result.onecliCaPath).toBeUndefined();
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  it('returns env from file only when ONECLI_URL is whitespace', async () => {
    const mod = await loadModule({
      ONECLI_URL: '   ',
      envFromFile: { CLAUDE_MODEL: 'opus' },
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.onecliApplied).toBe(false);
    expect(result.env).toEqual({ CLAUDE_MODEL: 'opus' });
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  it('merges OneCLI env when gateway succeeds without CA cert', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: { ANTHROPIC_AUTH_TOKEN: 'onecli-token' },
    });

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
      envFromFile: { ANTHROPIC_API_KEY: 'sk-file-key' },
    });

    const result = await mod.getHostRuntimeCredentialEnv('my-agent');

    expect(result.onecliApplied).toBe(true);
    expect(result.env).toEqual({
      ANTHROPIC_API_KEY: 'sk-file-key',
      ANTHROPIC_AUTH_TOKEN: 'onecli-token',
    });
    expect(result.onecliCaPath).toBeUndefined();
    expect(mockGetContainerConfig).toHaveBeenCalledWith('my-agent');
  });

  it('writes CA certificate and returns onecliCaPath when present', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: { ANTHROPIC_AUTH_TOKEN: 'token' },
      caCertificate:
        '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
      caCertificateContainerPath: '/etc/ssl/onecli/ca.pem',
    });

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.onecliApplied).toBe(true);
    expect(result.onecliCaPath).toBe('/etc/ssl/onecli/ca.pem');
    expect(mockMkdirSync).toHaveBeenCalledWith('/etc/ssl/onecli', {
      recursive: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/etc/ssl/onecli/ca.pem',
      '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
      { mode: 0o600 },
    );
  });

  it('logs warning and omits onecliCaPath when CA cert write fails', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: { ANTHROPIC_AUTH_TOKEN: 'token' },
      caCertificate: 'cert-data',
      caCertificateContainerPath: '/readonly/ca.pem',
    });
    mockMkdirSync.mockImplementation((dirPath: string) => {
      if (dirPath === '/readonly') {
        throw new Error('EACCES: permission denied');
      }
    });

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.onecliApplied).toBe(true);
    expect(result.onecliCaPath).toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ certificatePath: '/readonly/ca.pem' }),
      'Failed to write OneCLI CA certificate',
    );
  });

  it('logs warning and returns file env when OneCLI gateway throws', async () => {
    mockGetContainerConfig.mockRejectedValue(new Error('ECONNREFUSED'));

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
      envFromFile: { ANTHROPIC_API_KEY: 'sk-fallback' },
    });

    const result = await mod.getHostRuntimeCredentialEnv('agent-x');

    expect(result.onecliApplied).toBe(false);
    expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'sk-fallback' });
    expect(result.onecliCaPath).toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ agentIdentifier: 'agent-x' }),
      'OneCLI gateway not reachable',
    );
  });

  it('uses "default" as agentIdentifier in warning when none provided', async () => {
    mockGetContainerConfig.mockRejectedValue(new Error('ECONNREFUSED'));

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
    });

    await mod.getHostRuntimeCredentialEnv();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ agentIdentifier: 'default' }),
      'OneCLI gateway not reachable',
    );
  });

  it('OneCLI env overrides file env for overlapping keys', async () => {
    mockGetContainerConfig.mockResolvedValue({
      env: {
        ANTHROPIC_API_KEY: 'onecli-key-wins',
        ANTHROPIC_BASE_URL: 'https://onecli.example.com',
      },
    });

    const mod = await loadModule({
      ONECLI_URL: 'http://localhost:10254',
      envFromFile: {
        ANTHROPIC_API_KEY: 'file-key-loses',
        CLAUDE_MODEL: 'sonnet',
      },
    });

    const result = await mod.getHostRuntimeCredentialEnv();

    expect(result.env.ANTHROPIC_API_KEY).toBe('onecli-key-wins');
    expect(result.env.ANTHROPIC_BASE_URL).toBe('https://onecli.example.com');
    expect(result.env.CLAUDE_MODEL).toBe('sonnet');
    expect(result.onecliApplied).toBe(true);
  });
});

/* ================================================================== */
/*  prepareHostRuntimeContext                                         */
/* ================================================================== */

describe('prepareHostRuntimeContext', () => {
  const fakeGroup = {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@bot',
    added_at: '2025-01-01T00:00:00Z',
  };

  it('creates group dir, calls layout functions, and returns context', async () => {
    mockExistsSync.mockReturnValue(false);

    const mod = await loadModule({
      GROUPS_DIR: '/tmp/nanoclaw-test/groups',
      DATA_DIR: '/tmp/nanoclaw-test/data',
    });

    const ctx = mod.prepareHostRuntimeContext(fakeGroup);

    expect(ctx.groupDir).toBe('/tmp/nanoclaw-test/groups/test-group');
    expect(ctx.groupIpcDir).toBe('/tmp/nanoclaw-test/data/ipc/test-group');

    // Verify mkdirSync was called for the group directory
    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/tmp/nanoclaw-test/groups/test-group',
      { recursive: true },
    );

    // Verify layout helpers were called
    expect(mockEnsureSharedSessionSettings).toHaveBeenCalled();
    expect(mockSyncGroupSkills).toHaveBeenCalled();
    expect(mockEnsureGroupIpcLayout).toHaveBeenCalledWith(
      '/tmp/nanoclaw-test/data/ipc/test-group',
    );
  });

  it('returns globalDir when global directory exists', async () => {
    mockExistsSync.mockImplementation(
      (p: string) => p === '/tmp/nanoclaw-test/groups/global',
    );

    const mod = await loadModule({
      GROUPS_DIR: '/tmp/nanoclaw-test/groups',
      DATA_DIR: '/tmp/nanoclaw-test/data',
    });

    const ctx = mod.prepareHostRuntimeContext(fakeGroup);

    expect(ctx.globalDir).toBe('/tmp/nanoclaw-test/groups/global');
  });

  it('returns undefined globalDir when global directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const mod = await loadModule({
      GROUPS_DIR: '/tmp/nanoclaw-test/groups',
      DATA_DIR: '/tmp/nanoclaw-test/data',
    });

    const ctx = mod.prepareHostRuntimeContext(fakeGroup);

    expect(ctx.globalDir).toBeUndefined();
  });
});
