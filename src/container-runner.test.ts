import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import path from 'path';
import fs from 'fs';
import { spawn as spawnMock } from 'child_process';

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
      lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
      realpathSync: vi.fn((target: string) => target),
      cpSync: vi.fn(),
      rmSync: vi.fn(),
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
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
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

const fsMock = fs as unknown as {
  existsSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  readdirSync: ReturnType<typeof vi.fn>;
  statSync: ReturnType<typeof vi.fn>;
  lstatSync: ReturnType<typeof vi.fn>;
  realpathSync: ReturnType<typeof vi.fn>;
  cpSync: ReturnType<typeof vi.fn>;
  rmSync: ReturnType<typeof vi.fn>;
};

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.clearAllMocks();

    fsMock.existsSync.mockImplementation(() => false);
    fsMock.readdirSync.mockImplementation(() => []);
    fsMock.statSync.mockImplementation(() => ({ isDirectory: () => false }));
    fsMock.lstatSync.mockImplementation(() => ({ isSymbolicLink: () => false }));
    fsMock.realpathSync.mockImplementation((target: string) => target);
    fsMock.cpSync.mockImplementation(() => {});
    fsMock.rmSync.mockImplementation(() => {});
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

  it('skips hidden skill entries and copies directories as real files', async () => {
    const skillsSrc = path.join(process.cwd(), 'container', 'skills');
    const visibleSkillSrc = path.join(skillsSrc, 'agent-browser');
    const hiddenSkillSrc = path.join(skillsSrc, '.docs');
    const skillsDst = '/tmp/nanoclaw-test-data/sessions/test-group/.claude/skills';
    const visibleSkillDst = path.join(skillsDst, 'agent-browser');

    fsMock.existsSync.mockImplementation((target: string) => {
      if (target === skillsSrc) return true;
      return false;
    });
    fsMock.readdirSync.mockImplementation((target: string) => {
      if (target === skillsSrc) {
        return [{ name: '.docs' }, { name: 'agent-browser' }];
      }
      return [];
    });
    fsMock.statSync.mockImplementation((target: string) => ({
      isDirectory: () => target === visibleSkillSrc,
    }));

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(fsMock.cpSync).toHaveBeenCalledWith(
      visibleSkillSrc,
      visibleSkillDst,
      expect.objectContaining({ recursive: true, dereference: true, force: true }),
    );
    expect(fsMock.cpSync).not.toHaveBeenCalledWith(
      hiddenSkillSrc,
      expect.anything(),
      expect.anything(),
    );
  });

  it('skips overlapping skill source/destination real paths', async () => {
    const skillsSrc = path.join(process.cwd(), 'container', 'skills');
    const visibleSkillSrc = path.join(skillsSrc, 'agent-browser');
    const skillsDst = '/tmp/nanoclaw-test-data/sessions/test-group/.claude/skills';
    const visibleSkillDst = path.join(skillsDst, 'agent-browser');
    const sharedRealPath = '/Users/gurusharan/.claude/skills/agent-browser';

    fsMock.existsSync.mockImplementation((target: string) => {
      if (target === skillsSrc) return true;
      if (target === visibleSkillDst) return true;
      return false;
    });
    fsMock.readdirSync.mockImplementation((target: string) => {
      if (target === skillsSrc) {
        return [{ name: 'agent-browser' }];
      }
      return [];
    });
    fsMock.statSync.mockImplementation((target: string) => ({
      isDirectory: () => target === visibleSkillSrc,
    }));
    fsMock.lstatSync.mockImplementation(() => ({ isSymbolicLink: () => false }));
    fsMock.realpathSync.mockImplementation((target: string) => {
      if (target === visibleSkillSrc || target === visibleSkillDst) {
        return sharedRealPath;
      }
      return target;
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(fsMock.cpSync).not.toHaveBeenCalledWith(
      visibleSkillSrc,
      visibleSkillDst,
      expect.anything(),
    );
  });

  it('does not pass --user for Apple Container runtime', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnCalls = vi.mocked(spawnMock).mock.calls;
    expect(spawnCalls.length).toBeGreaterThan(0);
    const containerArgs = spawnCalls[0][1] as string[];
    expect(containerArgs).not.toContain('--user');
  });
});
