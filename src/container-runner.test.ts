import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
  ANTHROPIC_SMALL_FAST_MODEL: '',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_URL: 'http://localhost:10254',
  NANOCLAW_MODEL: 'test-model',
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
      rmSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
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

function resetFsMocks() {
  vi.mocked(fs.existsSync).mockImplementation(() => false);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
  vi.mocked(fs.readFileSync).mockImplementation(() => '' as any);
  vi.mocked(fs.readdirSync).mockImplementation(() => [] as any);
  vi.mocked(fs.statSync).mockImplementation(
    () => ({ isDirectory: () => false, mtimeMs: 0 }) as any,
  );
  vi.mocked(fs.copyFileSync).mockImplementation(() => undefined);
  vi.mocked(fs.cpSync).mockImplementation(() => undefined);
  vi.mocked(fs.rmSync).mockImplementation(() => undefined as any);
}

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFsMocks();
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

  it('normal exit after streamed error resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'error',
      result: null,
      error: 'internal stream ended unexpectedly',
      newSessionId: 'session-789',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result).toEqual({
      status: 'error',
      result: null,
      error: 'internal stream ended unexpectedly',
      newSessionId: 'session-789',
    });
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        error: 'internal stream ended unexpectedly',
      }),
    );
  });
});

describe('agent-runner source sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFsMocks();
    fakeProc = createFakeProcess();
  });

  it('copies only runtime agent-runner sources into the per-group cache', async () => {
    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((target) => {
      const normalized = String(target);
      if (normalized.endsWith('/container/skills')) return false;
      if (normalized.endsWith('/container/agent-runner/src')) return true;
      if (normalized.endsWith('/container/agent-runner/src/index.ts')) return true;
      return false;
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    const cpSync = vi.mocked(fs.cpSync);
    expect(cpSync).toHaveBeenCalledWith(
      expect.stringContaining('/container/agent-runner/src'),
      expect.stringContaining('/tmp/nanoclaw-test-data/sessions/test-group/agent-runner-src'),
      expect.objectContaining({
        recursive: true,
        filter: expect.any(Function),
      }),
    );

    const filter = cpSync.mock.calls[0]?.[2]?.filter as ((src: string) => boolean);
    expect(filter('/repo/container/agent-runner/src/index.ts')).toBe(true);
    expect(filter('/repo/container/agent-runner/src/index.test.ts')).toBe(false);
    expect(filter('/repo/container/agent-runner/src/index.ts.bak.20260311_092703')).toBe(false);

    await new Promise(setImmediate);
    fakeProc.emit('close', 0);
    await resultPromise;
  });

  it('prunes stale test and backup files from the per-group cache before launch', async () => {
    const groupCacheDir = '/tmp/nanoclaw-test-data/sessions/test-group/agent-runner-src';
    const cachedIndex = `${groupCacheDir}/index.ts`;
    const sourceIndex = `${process.cwd()}/container/agent-runner/src/index.ts`;

    const existsSync = vi.mocked(fs.existsSync);
    existsSync.mockImplementation((target) => {
      const normalized = String(target);
      if (normalized.endsWith('/container/skills')) return false;
      if (normalized.endsWith('/container/agent-runner/src')) return true;
      if (normalized === sourceIndex) return true;
      if (normalized === groupCacheDir) return true;
      if (normalized === cachedIndex) return true;
      return false;
    });

    vi.mocked(fs.readdirSync).mockImplementation((target) => {
      if (String(target) === groupCacheDir) {
        return ['index.ts', 'index.test.ts', 'index.ts.bak.20260311_092703'] as any;
      }
      return [] as any;
    });

    vi.mocked(fs.statSync).mockImplementation((target) => {
      if (String(target) === sourceIndex) {
        return { mtimeMs: 100, isDirectory: () => false } as any;
      }
      if (String(target) === cachedIndex) {
        return { mtimeMs: 200, isDirectory: () => false } as any;
      }
      return { mtimeMs: 0, isDirectory: () => false } as any;
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(
      `${groupCacheDir}/index.test.ts`,
      { force: true, recursive: true },
    );
    expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(
      `${groupCacheDir}/index.ts.bak.20260311_092703`,
      { force: true, recursive: true },
    );
    expect(vi.mocked(fs.cpSync)).not.toHaveBeenCalled();

    await new Promise(setImmediate);
    fakeProc.emit('close', 0);
    await resultPromise;
  });
});
