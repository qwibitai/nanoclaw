import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
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

async function startAndCloseContainerRun() {
  const resultPromise = runContainerAgent(testGroup, testInput, () => {});
  fakeProc.emit('close', 0);
  await vi.advanceTimersByTimeAsync(10);
  return resultPromise;
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.mkdirSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readFileSync).mockImplementation(() => '');
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.readdirSync).mockImplementation(() => []);
    vi.mocked(fs.statSync).mockReset();
    vi.mocked(fs.statSync).mockImplementation(
      () =>
        ({
          isDirectory: () => false,
        }) as never,
    );
    vi.mocked(fs.cpSync).mockReset();
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => fakeProc as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes upstream agent-runner files while preserving group-only extras', async () => {
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const projectRoot = process.cwd();
    const agentRunnerSrc = path.join(
      projectRoot,
      'container',
      'agent-runner',
      'src',
    );
    const groupAgentRunnerDir = path.join(
      '/tmp/nanoclaw-test-data',
      'sessions',
      testGroup.folder,
      'agent-runner-src',
    );
    const upstreamIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const extraFile = path.join(groupAgentRunnerDir, 'group-only-extra.ts');
    const extraFileContents = '// keep me\n';

    realFs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });

    try {
      realFs.mkdirSync(groupAgentRunnerDir, { recursive: true });
      realFs.writeFileSync(cachedIndex, '// stale copy\n');
      realFs.writeFileSync(extraFile, extraFileContents);

      vi.mocked(fs.existsSync).mockImplementation(realFs.existsSync);
      vi.mocked(fs.mkdirSync).mockImplementation(realFs.mkdirSync);
      vi.mocked(fs.writeFileSync).mockImplementation(
        realFs.writeFileSync as never,
      );
      vi.mocked(fs.readdirSync).mockImplementation(realFs.readdirSync as never);
      vi.mocked(fs.statSync).mockImplementation(realFs.statSync as never);
      vi.mocked(fs.cpSync).mockImplementation(realFs.cpSync);

      await startAndCloseContainerRun();

      expect(realFs.readFileSync(cachedIndex, 'utf8')).toBe(
        realFs.readFileSync(upstreamIndex, 'utf8'),
      );
      expect(realFs.readFileSync(extraFile, 'utf8')).toBe(extraFileContents);
    } finally {
      realFs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
    }
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
