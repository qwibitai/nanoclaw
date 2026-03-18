import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_NAME_PREFIX: 'nanoclaw-',
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
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
      cpSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
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
  };
});

import {
  runContainerAgent,
  buildContainerArgs,
  ContainerOutput,
} from './container-runner.js';
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

// Shared helper: run runContainerAgent and capture the spawn args
async function runAndCaptureSpawnArgs(
  inputOverrides: Record<string, unknown> = {},
): Promise<string[]> {
  const fs = await import('fs');
  const { spawn } = await import('child_process');

  vi.spyOn(fs.default, 'existsSync').mockReturnValue(true);
  vi.spyOn(fs.default, 'readdirSync').mockReturnValue([]);
  vi.spyOn(fs.default, 'readFileSync').mockReturnValue('{}');

  const input = { ...testInput, ...inputOverrides };
  const resultPromise = runContainerAgent(
    testGroup,
    input,
    () => {},
    async () => {},
  );

  await vi.advanceTimersByTimeAsync(10);
  emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
  await vi.advanceTimersByTimeAsync(10);
  fakeProc.emit('close', 0);
  await vi.advanceTimersByTimeAsync(10);
  await resultPromise;

  const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
  const lastCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
  return lastCall[1] as string[];
}

describe('global CLAUDE.md mount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mounts /workspace/global for main groups', async () => {
    const args = await runAndCaptureSpawnArgs({ isMain: true });
    const globalMountArg = args.find(
      (a: string) => typeof a === 'string' && a.includes('/workspace/global'),
    );
    expect(globalMountArg).toBeDefined();
    expect(globalMountArg).toContain('groups/global');
  });

  it('mounts /workspace/global for non-main groups', async () => {
    const args = await runAndCaptureSpawnArgs({ isMain: false });
    const globalMountArg = args.find(
      (a: string) => typeof a === 'string' && a.includes('/workspace/global'),
    );
    expect(globalMountArg).toBeDefined();
    expect(globalMountArg).toContain('groups/global');
  });
});

describe('agent-runner source sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('always syncs agent-runner source even when session dir exists', async () => {
    const fs = await import('fs');
    const cpSyncSpy = vi.spyOn(fs.default, 'cpSync');

    // existsSync returns true for everything — simulating an existing session dir
    vi.spyOn(fs.default, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs.default, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fs.default, 'readFileSync').mockReturnValue('{}');

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    // Let setup complete, then emit output and close
    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // Verify cpSync was called with agent-runner source path
    const agentRunnerCalls = cpSyncSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('agent-runner') &&
        call[0].includes('src'),
    );
    expect(agentRunnerCalls.length).toBeGreaterThanOrEqual(1);
    // Verify it uses recursive: true
    expect(agentRunnerCalls[0][2]).toEqual({ recursive: true });
  });
});

// INVARIANT: Dev case containers receive GITHUB_TOKEN and GH_TOKEN env vars
//            when the host has GITHUB_TOKEN set.
// INVARIANT: Work case containers NEVER receive GitHub credentials,
//            regardless of host environment.
// INVARIANT: No GitHub credentials are injected when host has no GITHUB_TOKEN.
// SUT: buildContainerArgs in container-runner.ts
// VERIFICATION: Inspect the returned docker args array for presence/absence
//               of -e GITHUB_TOKEN=... and -e GH_TOKEN=...
describe('GitHub token injection for dev cases', () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  // Helper to find env var args in the docker args array
  function getEnvVars(args: string[]): Record<string, string> {
    const envVars: Record<string, string> = {};
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-e' && args[i + 1].includes('=')) {
        const [key, ...rest] = args[i + 1].split('=');
        envVars[key] = rest.join('=');
      }
    }
    return envVars;
  }

  it('injects GITHUB_TOKEN and GH_TOKEN for dev cases when token is set', () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token_123';

    const args = buildContainerArgs([], 'test-container', {
      caseId: 'case-1',
      caseName: 'test',
      caseType: 'dev',
    });
    const envVars = getEnvVars(args);

    expect(envVars['GITHUB_TOKEN']).toBe('ghp_test_token_123');
    expect(envVars['GH_TOKEN']).toBe('ghp_test_token_123');
  });

  it('does NOT inject any GitHub credentials for work cases', () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token_123';

    const args = buildContainerArgs([], 'test-container', {
      caseId: 'case-1',
      caseName: 'test',
      caseType: 'work',
    });
    const envVars = getEnvVars(args);

    expect(envVars).not.toHaveProperty('GITHUB_TOKEN');
    expect(envVars).not.toHaveProperty('GH_TOKEN');
  });

  it('does NOT inject any GitHub credentials when env var is not set', () => {
    delete process.env.GITHUB_TOKEN;

    const args = buildContainerArgs([], 'test-container', {
      caseId: 'case-1',
      caseName: 'test',
      caseType: 'dev',
    });
    const envVars = getEnvVars(args);

    expect(envVars).not.toHaveProperty('GITHUB_TOKEN');
    expect(envVars).not.toHaveProperty('GH_TOKEN');
  });

  it('does NOT inject any GitHub credentials when no case input', () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token_123';

    const args = buildContainerArgs([], 'test-container');
    const envVars = getEnvVars(args);

    expect(envVars).not.toHaveProperty('GITHUB_TOKEN');
    expect(envVars).not.toHaveProperty('GH_TOKEN');
  });
});

// INVARIANT: When ~/.gmail-mcp exists, containers get it mounted at /home/node/.gmail-mcp
// INVARIANT: When ~/.gmail-mcp does not exist, no Gmail mount is added
// SUT: buildVolumeMounts in container-runner.ts (tested via runContainerAgent spawn args)
// VERIFICATION: Inspect docker spawn args for presence/absence of gmail-mcp mount
describe('Gmail credentials mount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mounts ~/.gmail-mcp when directory exists', async () => {
    const args = await runAndCaptureSpawnArgs();
    // existsSync returns true for everything (mocked in runAndCaptureSpawnArgs)
    const gmailMount = args.find(
      (a: string) => typeof a === 'string' && a.includes('.gmail-mcp'),
    );
    expect(gmailMount).toBeDefined();
    expect(gmailMount).toContain('/home/node/.gmail-mcp');
  });

  it('does not mount ~/.gmail-mcp when directory is missing', async () => {
    const fs = await import('fs');
    const { spawn } = await import('child_process');

    // Only return false for the gmail-mcp path
    vi.spyOn(fs.default, 'existsSync').mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('.gmail-mcp')) return false;
      return true;
    });
    vi.spyOn(fs.default, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fs.default, 'readFileSync').mockReturnValue('{}');

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    await vi.advanceTimersByTimeAsync(10);
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    const lastCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
    const spawnArgs = lastCall[1] as string[];

    const gmailMount = spawnArgs.find(
      (a: string) => typeof a === 'string' && a.includes('.gmail-mcp'),
    );
    expect(gmailMount).toBeUndefined();
  });
});

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
