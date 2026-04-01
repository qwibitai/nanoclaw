import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  ATTACHMENTS_DIR: '/tmp/nanoclaw-test-data/attachments',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUP_THREAD_KEY: '__group__',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  OLLAMA_ADMIN_TOOLS: false,
  ONECLI_URL: 'http://localhost:10254',
  PLUGINS_DIR: '/tmp/nanoclaw-test-plugins',
  RESIDENTIAL_PROXY_URL: undefined,
  TIMEZONE: 'America/Los_Angeles',
  WORKTREES_DIR: '/tmp/nanoclaw-test-worktrees',
  escapeRegex: (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
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
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  findLatestRescueBranch,
  deleteRescueBranches,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import { exec } from 'child_process';

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

describe('rescue branch helpers', () => {
  const mockedExec = vi.mocked(exec);

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('findLatestRescueBranch', () => {
    it('returns the most recent rescue branch when multiple exist', async () => {
      mockedExec.mockImplementation(
        (cmd: string, _opts: unknown, cb?: Function) => {
          if (typeof cmd === 'string' && cmd.includes('git branch -r --list')) {
            if (cb) {
              cb(
                null,
                '  origin/rescue/my_group/dc_1234567890/2026-03-18T14-30-45\n  origin/rescue/my_group/dc_1234567890/2026-03-20T10-00-00\n  origin/rescue/my_group/dc_1234567890/2026-03-19T08-15-22\n',
                '',
              );
            }
          } else if (cb) {
            cb(null, '', '');
          }
          return new EventEmitter() as any;
        },
      );

      const result = await findLatestRescueBranch(
        '/tmp/repo',
        'my-group',
        'dc:1234567890ab:thread:xyz',
      );
      expect(result).toBe(
        'origin/rescue/my_group/dc_1234567890/2026-03-20T10-00-00',
      );
    });

    it('returns null when no rescue branches exist', async () => {
      mockedExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb?: Function) => {
          if (cb) cb(null, '', '');
          return new EventEmitter() as any;
        },
      );

      const result = await findLatestRescueBranch(
        '/tmp/repo',
        'my-group',
        'dc:1234567890ab:thread:xyz',
      );
      expect(result).toBeNull();
    });

    it('returns null on git error', async () => {
      mockedExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb?: Function) => {
          if (cb) cb(new Error('git failed'), '', 'fatal: error');
          return new EventEmitter() as any;
        },
      );

      const result = await findLatestRescueBranch(
        '/tmp/repo',
        'my-group',
        'dc:1234567890ab:thread:xyz',
      );
      expect(result).toBeNull();
    });

    it('sanitizes group folder and thread ID in pattern', async () => {
      let capturedCmd = '';
      mockedExec.mockImplementation(
        (cmd: string, _opts: unknown, cb?: Function) => {
          if (typeof cmd === 'string' && cmd.includes('git branch -r --list')) {
            capturedCmd = cmd;
          }
          if (cb) cb(null, '', '');
          return new EventEmitter() as any;
        },
      );

      await findLatestRescueBranch(
        '/tmp/repo',
        'my.group/with:chars',
        'dc:12345:thread',
      );
      expect(capturedCmd).toContain('my_group_with_chars');
      expect(capturedCmd).toContain('dc_12345_thr');
    });
  });

  describe('deleteRescueBranches', () => {
    it('pushes delete refspecs for all matching branches', async () => {
      const cmds: string[] = [];
      mockedExec.mockImplementation(
        (cmd: string, _opts: unknown, cb?: Function) => {
          cmds.push(typeof cmd === 'string' ? cmd : '');
          if (typeof cmd === 'string' && cmd.includes('git branch -r --list')) {
            if (cb) {
              cb(
                null,
                '  origin/rescue/test_group/dc_1234567890/2026-03-18T14-30-45\n  origin/rescue/test_group/dc_1234567890/2026-03-20T10-00-00\n',
                '',
              );
            }
          } else if (cb) {
            cb(null, '', '');
          }
          return new EventEmitter() as any;
        },
      );

      await deleteRescueBranches(
        '/tmp/repo',
        'test-group',
        'dc:1234567890ab:thread:xyz',
      );

      const pushCmd = cmds.find((c) => c.includes('git push origin "'));
      expect(pushCmd).toBeDefined();
      expect(pushCmd).toContain(
        '":refs/heads/rescue/test_group/dc_1234567890/2026-03-18T14-30-45"',
      );
      expect(pushCmd).toContain(
        '":refs/heads/rescue/test_group/dc_1234567890/2026-03-20T10-00-00"',
      );
    });

    it('does nothing when no rescue branches exist', async () => {
      const cmds: string[] = [];
      mockedExec.mockImplementation(
        (cmd: string, _opts: unknown, cb?: Function) => {
          cmds.push(typeof cmd === 'string' ? cmd : '');
          if (cb) cb(null, '', '');
          return new EventEmitter() as any;
        },
      );

      await deleteRescueBranches(
        '/tmp/repo',
        'test-group',
        'dc:1234567890ab:thread:xyz',
      );

      expect(cmds.filter((c) => c.includes('git push'))).toHaveLength(0);
    });

    it('does not throw on push failure', async () => {
      mockedExec.mockImplementation(
        (cmd: string, _opts: unknown, cb?: Function) => {
          if (typeof cmd === 'string' && cmd.includes('git branch -r --list')) {
            if (cb)
              cb(
                null,
                '  origin/rescue/test_group/dc_1234567890/2026-03-18T14-30-45\n',
                '',
              );
          } else if (typeof cmd === 'string' && cmd.includes('git push')) {
            if (cb) cb(new Error('push failed'), '', 'error');
          } else if (cb) {
            cb(null, '', '');
          }
          return new EventEmitter() as any;
        },
      );

      // Should not throw
      await expect(
        deleteRescueBranches(
          '/tmp/repo',
          'test-group',
          'dc:1234567890ab:thread:xyz',
        ),
      ).resolves.toBeUndefined();
    });
  });
});
