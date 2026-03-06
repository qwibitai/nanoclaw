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
  CONTAINER_NO_OUTPUT_TIMEOUT: 720000, // 12min
  CONTAINER_PARSE_BUFFER_LIMIT: 1048576,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
  WORKER_CONTAINER_IMAGE: 'nanoclaw-worker:latest',
  WORKER_MIN_NO_OUTPUT_TIMEOUT_MS: 0,
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
      lstatSync: vi.fn(() => ({
        isDirectory: () => false,
        isSymbolicLink: () => false,
      })),
      realpathSync: vi.fn((target: fs.PathLike) => String(target)),
      cpSync: vi.fn(),
      copyFileSync: vi.fn(),
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

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { exec, spawn } from 'child_process';
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
    vi.clearAllMocks();
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

  it('worker heartbeat resets no-output timeout watchdog', async () => {
    const onOutput = vi.fn(async () => {});
    const workerLikeGroup: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        timeout: 900000,
        idleTimeout: 300000,
        noOutputTimeout: 120000,
      },
    };

    const resultPromise = runContainerAgent(
      workerLikeGroup,
      testInput,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(119000);
    expect(exec).not.toHaveBeenCalled();

    fakeProc.stderr.push(
      '[agent-runner] heartbeat worker-opencode-active model=opencode/minimax-m2.5-free\n',
    );
    await vi.advanceTimersByTimeAsync(119000);
    expect(exec).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(exec).toHaveBeenCalledTimes(1);

    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('no_output_timeout');
  });

  it('skips hidden skill entries during per-group skills sync', async () => {
    vi.mocked(fs.existsSync).mockImplementation((target: fs.PathLike) => {
      const targetPath = String(target);
      return (
        targetPath.endsWith('/container/skills') ||
        targetPath.endsWith('/container/skills/agent-browser')
      );
    });

    vi.mocked(fs.readdirSync).mockImplementation(((target: fs.PathLike) => {
      const targetPath = String(target);
      if (targetPath.endsWith('/container/skills')) {
        return ['.docs', 'agent-browser'];
      }
      return [];
    }) as unknown as typeof fs.readdirSync);

    vi.mocked(fs.statSync).mockImplementation((target: fs.PathLike) => {
      const targetPath = String(target);
      return {
        isDirectory: () =>
          targetPath.endsWith('/agent-browser') ||
          targetPath.endsWith('/container/skills/.docs'),
      } as unknown as fs.Stats;
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(fs.cpSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.cpSync).mock.calls[0]?.[0]).toContain(
      '/container/skills/agent-browser',
    );
    expect(vi.mocked(fs.cpSync).mock.calls[0]?.[1]).toContain(
      '/tmp/nanoclaw-test-data/sessions/test-group/.claude/skills/agent-browser',
    );
    expect(vi.mocked(fs.cpSync).mock.calls[0]?.[2]).toEqual({
      recursive: true,
      dereference: true,
    });
    expect(vi.mocked(fs.cpSync)).not.toHaveBeenCalledWith(
      expect.stringContaining('/container/skills/.docs'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not pass --user when using Apple container runtime', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    const spawnArgs = vi.mocked(spawn).mock.calls[0]?.[1] as
      | string[]
      | undefined;
    expect(spawnArgs).toBeDefined();
    expect(spawnArgs).not.toContain('--user');
  });
});
