import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_API_KEY: '',
  ONECLI_URL: 'http://localhost:10254',
  SUPERPILOT_MCP_URL: 'http://localhost:8100',
  SUPERPILOT_API_URL: 'http://localhost:8101',
  TIMEZONE: 'America/Los_Angeles',
  TRUST_GATEWAY_URL: 'http://host.docker.internal:10255',
  BROWSER_CDP_URL: 'http://localhost:9223',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
    // Mock execSync to prevent OAuth token scanning from reading real process list
    execSync: vi.fn(() => {
      throw new Error('no processes');
    }),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner secret env-file security', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    // Set secret env vars so buildContainerArgs will push -e flags for them
    for (const key of [
      'DISCORD_BOT_TOKEN',
      'NANOCLAW_SERVICE_TOKEN',
      'GH_TOKEN',
      'NOTION_TOKEN',
    ]) {
      savedEnv[key] = process.env[key];
      process.env[key] = `fake-${key}-value`;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore env
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('secrets are moved to --env-file and not passed as -e flags', async () => {
    const { spawn } = await import('child_process');
    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    const callCountBefore = spawnMock.mock.calls.length;

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Let async buildContainerArgs settle
    await vi.advanceTimersByTimeAsync(50);

    // Inspect the args passed to spawn (use the latest call, not index 0)
    expect(spawnMock.mock.calls.length).toBeGreaterThan(callCountBefore);
    const spawnArgs: string[] =
      spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1];

    // Secret keys must NOT appear as -e flag values
    const SECRET_KEYS = [
      'DISCORD_BOT_TOKEN=',
      'NANOCLAW_SERVICE_TOKEN=',
      'GH_TOKEN=',
      'NOTION_TOKEN=',
      'CLAUDE_CODE_OAUTH_TOKEN=',
      'ANTHROPIC_API_KEY=',
    ];

    for (let i = 0; i < spawnArgs.length; i++) {
      if (spawnArgs[i] === '-e' && i + 1 < spawnArgs.length) {
        const val = spawnArgs[i + 1];
        for (const secretPrefix of SECRET_KEYS) {
          expect(val.startsWith(secretPrefix)).toBe(false);
        }
      }
    }

    // --env-file must be present in args
    expect(spawnArgs).toContain('--env-file');

    // The env file should have been written with mode 0o600
    const writeFileSyncMock = fs.writeFileSync as unknown as ReturnType<
      typeof vi.fn
    >;
    const envFileCall = writeFileSyncMock.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('nanoclaw-env-'),
    );
    expect(envFileCall).toBeDefined();

    // Verify the file contents contain the secrets
    const envFileContent = envFileCall![1] as string;
    expect(envFileContent).toContain(
      'DISCORD_BOT_TOKEN=fake-DISCORD_BOT_TOKEN-value',
    );
    expect(envFileContent).toContain(
      'NANOCLAW_SERVICE_TOKEN=fake-NANOCLAW_SERVICE_TOKEN-value',
    );
    expect(envFileContent).toContain('GH_TOKEN=fake-GH_TOKEN-value');
    expect(envFileContent).toContain('NOTION_TOKEN=fake-NOTION_TOKEN-value');

    // Verify file permissions
    expect(envFileCall![2]).toEqual({ mode: 0o600 });

    // Non-secret env vars should still be -e flags
    const eFlags: string[] = [];
    for (let i = 0; i < spawnArgs.length; i++) {
      if (spawnArgs[i] === '-e' && i + 1 < spawnArgs.length) {
        eFlags.push(spawnArgs[i + 1]);
      }
    }
    expect(eFlags.some((f) => f.startsWith('TZ='))).toBe(true);
    expect(eFlags.some((f) => f.startsWith('SUPERPILOT_MCP_URL='))).toBe(true);

    // Clean up: emit output and close the container
    emitOutputMarker(fakeProc, { status: 'success', result: 'done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
  });

  it('includes --network nanoclaw in container args', async () => {
    const { spawn } = await import('child_process');
    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    const callCountBefore = spawnMock.mock.calls.length;

    const onOutput = vi.fn(async () => {});
    runContainerAgent(testGroup, testInput, () => {}, onOutput);
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnMock.mock.calls.length).toBeGreaterThan(callCountBefore);
    const spawnArgs: string[] =
      spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1];

    const netIdx = spawnArgs.indexOf('--network');
    expect(netIdx).toBeGreaterThan(-1);
    expect(spawnArgs[netIdx + 1]).toBe('nanoclaw');
  });
});

describe('token cost daily reset', () => {
  it('should reset token costs after 24 hours', async () => {
    const {
      reportTokenUsage,
      getNextOAuthToken,
      _testResetTokenState,
      _testSetOAuthTokens,
      _testAdvancePeriod,
    } = await import('./container-runner.js');

    // Reset internal state for clean test
    _testResetTokenState();

    // Inject two known tokens via the cache
    _testSetOAuthTokens(['token-a', 'token-b']);

    // Accumulate cost on token-a
    reportTokenUsage('token-a', 25.0);
    reportTokenUsage('token-b', 5.0);

    // token-b should be preferred (lower cost)
    let next = getNextOAuthToken();
    expect(next).toBe('token-b');

    // Advance time past 24h
    _testAdvancePeriod();

    // After reset, costs are zero — first token in array wins (both are 0)
    next = getNextOAuthToken();
    expect(next).toBe('token-a');

    // Cleanup
    _testResetTokenState();
  });
});
