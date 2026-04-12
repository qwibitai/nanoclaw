import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
}));

async function loadRuntimeDiagnosticsModule(config: {
  ONECLI_URL?: string;
  envVars?: Record<string, string | undefined>;
}) {
  vi.resetModules();
  vi.doMock('../core/config.js', () => ({
    ONECLI_URL: config.ONECLI_URL || '',
  }));
  vi.doMock('../core/env.js', () => ({
    readEnvFile: () => config.envVars || {},
  }));
  return import('./runtime-diagnostics.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
});

afterEach(() => {
  vi.resetModules();
});

describe('runtime-diagnostics', () => {
  it('reports healthy when host artifacts exist', async () => {
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: 'http://localhost:10254',
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'token' },
    });

    const diagnostics = await mod.collectRuntimeDiagnostics();

    expect(diagnostics.ok).toBe(true);
    expect(diagnostics.errors).toEqual([]);
  });

  it('reports unhealthy when host artifacts missing', async () => {
    mockExistsSync.mockImplementation(
      (pathValue: string) => pathValue === process.execPath,
    );
    const mod = await loadRuntimeDiagnosticsModule({});

    const diagnostics = await mod.collectRuntimeDiagnostics();

    expect(diagnostics.ok).toBe(false);
    expect(diagnostics.errors.join(' ')).toContain('artifacts');
  });

  it('auto-builds host runner artifacts during startup preflight', async () => {
    mockExecSync.mockReturnValue('');
    mockExistsSync.mockImplementation((pathValue: string) => {
      return (
        pathValue.endsWith('/container/agent-runner/dist/index.js') ||
        pathValue.endsWith('/container/agent-runner/dist/ipc-mcp-stdio.js') ||
        pathValue === process.execPath
      );
    });
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: 'http://localhost:10254',
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'token' },
    });

    const diagnostics = await mod.runRuntimeStartupPreflight();

    expect(diagnostics.ok).toBe(true);
    expect(diagnostics.details.hostBuildAttempted).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      'npm --prefix container/agent-runner run build',
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300000,
      },
    );
  });

  it('fails startup preflight when host auto-build fails', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('npm --prefix container/agent-runner run build')) {
        throw new Error('build failed');
      }
      return '';
    });
    mockExistsSync.mockImplementation(
      (pathValue: string) => pathValue === process.execPath,
    );
    const mod = await loadRuntimeDiagnosticsModule({});

    await expect(mod.runRuntimeStartupPreflight()).rejects.toThrow(
      'Runtime preflight failed',
    );
  });

  it('warns when no credentials are configured', async () => {
    const mod = await loadRuntimeDiagnosticsModule({});

    const diagnostics = await mod.collectRuntimeDiagnostics();

    expect(diagnostics.warnings.join(' ')).toContain('No credentials');
  });

  it('reports error when host runner build succeeds but artifacts are still missing (lines 77-83)', async () => {
    // execSync succeeds (build completes) but existsSync returns false for artifacts
    mockExecSync.mockReturnValue('');
    mockExistsSync.mockImplementation(
      (pathValue: string) => pathValue === process.execPath,
    );
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: 'http://localhost:10254',
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'token' },
    });

    const diagnostics = await mod.collectRuntimeDiagnostics({
      autoBuildHostRunner: true,
    });

    expect(diagnostics.ok).toBe(false);
    expect(diagnostics.details.hostBuildAttempted).toBe(true);
    expect(diagnostics.details.hostBuildSucceeded).toBe(false);
    expect(diagnostics.errors.join(' ')).toContain(
      'artifacts are still missing',
    );
  });

  it('reports error when runtime binary is not found (lines 112-113)', async () => {
    // existsSync returns false for everything including process.execPath
    mockExistsSync.mockReturnValue(false);
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: 'http://localhost:10254',
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'token' },
    });

    const diagnostics = await mod.collectRuntimeDiagnostics();

    expect(diagnostics.ok).toBe(false);
    expect(diagnostics.details.runtimeBinaryReady).toBe(false);
    expect(diagnostics.errors.join(' ')).toContain('runtime binary not found');
    expect(diagnostics.fixes.join(' ')).toContain('Node.js');
  });

  it('reports onecli-only credential path status when only ONECLI_URL is set', async () => {
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: 'http://localhost:10254',
      envVars: {},
    });

    const diagnostics = await mod.collectRuntimeDiagnostics();
    expect(diagnostics.details.credentialPathStatus).toBe('onecli-only');
  });

  it('reports env-only credential path status when only env vars are set', async () => {
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: '',
      envVars: { ANTHROPIC_API_KEY: 'sk-test-key' },
    });

    const diagnostics = await mod.collectRuntimeDiagnostics();
    expect(diagnostics.details.credentialPathStatus).toBe('env-only');
  });

  it('formatRuntimeDiagnosticsMessage produces well-formed output for healthy diagnostics', async () => {
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: 'http://localhost:10254',
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'token' },
    });

    const diagnostics = await mod.collectRuntimeDiagnostics();
    const message = mod.formatRuntimeDiagnosticsMessage(diagnostics);

    expect(message).toContain('Runtime mode: host');
    expect(message).toContain('Health: healthy');
    expect(message).toContain('Checked at:');
    expect(message).toContain('Runtime binary:');
    expect(message).toContain('Credential path: onecli+env');
    expect(message).toContain('OneCLI configured: yes');
    expect(message).toContain('Host artifacts: present');
    // Should not have errors/warnings/fixes sections for healthy diagnostics
    expect(message).not.toContain('Errors:');
  });

  it('formatRuntimeDiagnosticsMessage includes errors, warnings, and fixes sections', async () => {
    mockExistsSync.mockReturnValue(false);
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: '',
      envVars: {},
    });

    const diagnostics = await mod.collectRuntimeDiagnostics();
    const message = mod.formatRuntimeDiagnosticsMessage(diagnostics);

    expect(message).toContain('Health: unhealthy');
    expect(message).toContain('Errors:');
    expect(message).toContain('Warnings:');
    expect(message).toContain('Fixes:');
    expect(message).toContain('OneCLI configured: no');
  });

  it('formatRuntimeDiagnosticsMessage includes auto-build status when attempted', async () => {
    mockExecSync.mockReturnValue('');
    mockExistsSync.mockImplementation((pathValue: string) => {
      return (
        pathValue.endsWith('/container/agent-runner/dist/index.js') ||
        pathValue.endsWith('/container/agent-runner/dist/ipc-mcp-stdio.js') ||
        pathValue === process.execPath
      );
    });
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: 'http://localhost:10254',
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'token' },
    });

    const diagnostics = await mod.collectRuntimeDiagnostics({
      autoBuildHostRunner: true,
    });
    const message = mod.formatRuntimeDiagnosticsMessage(diagnostics);

    expect(message).toContain('Host auto-build: succeeded');
  });

  it('formatRuntimeDiagnosticsMessage shows failed auto-build', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('npm build failed');
    });
    mockExistsSync.mockImplementation(
      (pathValue: string) => pathValue === process.execPath,
    );
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: 'http://localhost:10254',
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'token' },
    });

    const diagnostics = await mod.collectRuntimeDiagnostics({
      autoBuildHostRunner: true,
    });
    const message = mod.formatRuntimeDiagnosticsMessage(diagnostics);

    expect(message).toContain('Host auto-build: failed');
  });

  it('summarizeExecError handles non-Error objects', async () => {
    // When execSync throws a non-Error (e.g., a string), summarizeExecError
    // should convert it via String()
    mockExecSync.mockImplementation(() => {
      throw 'string error message';
    });
    mockExistsSync.mockImplementation(
      (pathValue: string) => pathValue === process.execPath,
    );
    const mod = await loadRuntimeDiagnosticsModule({
      ONECLI_URL: 'http://localhost:10254',
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'token' },
    });

    const diagnostics = await mod.collectRuntimeDiagnostics({
      autoBuildHostRunner: true,
    });

    expect(diagnostics.ok).toBe(false);
    expect(diagnostics.errors.join(' ')).toContain('string error message');
  });
});
