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
  CONTAINER_TIMEOUT: 1800000, // 30min
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
  buildVolumeMounts,
  ContainerOutput,
} from './container-runner.js';
import fs from 'fs';
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

describe('buildVolumeMounts agent-runner source sync', () => {
  const mockedFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: existsSync returns false for everything
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.readFileSync.mockReturnValue('');
    mockedFs.readdirSync.mockReturnValue([]);
    mockedFs.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    mockedFs.cpSync.mockReturnValue(undefined);
  });

  it('always copies core source even if destination exists', () => {
    // agent-runner/src exists, destination already exists too
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('agent-runner/src') || s.includes('agent-runner-src')) {
        return true;
      }
      return false;
    });

    buildVolumeMounts(testGroup, false);

    // cpSync should be called for agent-runner source
    const cpSyncCalls = mockedFs.cpSync.mock.calls.filter(
      (call) =>
        String(call[0]).includes('agent-runner') &&
        String(call[0]).includes('src'),
    );
    expect(cpSyncCalls.length).toBeGreaterThanOrEqual(1);
    expect(cpSyncCalls[0][2]).toEqual({ recursive: true });
  });

  it('creates extensions directory if it does not exist', () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      // agent-runner source exists
      if (s.includes('agent-runner/src')) return true;
      // extensions dir does NOT exist
      if (s.includes('agent-runner-extensions')) return false;
      return false;
    });

    buildVolumeMounts(testGroup, false);

    const mkdirCalls = mockedFs.mkdirSync.mock.calls.filter((call) =>
      String(call[0]).includes('agent-runner-extensions'),
    );
    expect(mkdirCalls.length).toBe(1);
    expect(mkdirCalls[0][1]).toEqual({ recursive: true });
  });

  it('does not recreate extensions directory if it already exists', () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('agent-runner/src')) return true;
      if (s.includes('agent-runner-extensions')) return true;
      return false;
    });

    buildVolumeMounts(testGroup, false);

    const mkdirCalls = mockedFs.mkdirSync.mock.calls.filter((call) =>
      String(call[0]).includes('agent-runner-extensions'),
    );
    expect(mkdirCalls.length).toBe(0);
  });

  it('mounts both agent-runner-src and extensions directories', () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('agent-runner/src')) return true;
      return false;
    });

    const mounts = buildVolumeMounts(testGroup, false);

    const srcMount = mounts.find((m) => m.containerPath === '/app/src');
    expect(srcMount).toBeDefined();
    expect(srcMount!.hostPath).toContain('agent-runner-src');
    expect(srcMount!.readonly).toBe(false);

    const extMount = mounts.find((m) => m.containerPath === '/app/extensions');
    expect(extMount).toBeDefined();
    expect(extMount!.hostPath).toContain('agent-runner-extensions');
    expect(extMount!.readonly).toBe(false);
  });
});
