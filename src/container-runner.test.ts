import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_CPU_LIMIT: '2',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MEMORY_LIMIT: '4096M',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  MAIN_GROUP_FOLDER: 'main',
  WORKER_CONTAINER_IMAGE: 'nanoclaw-worker:latest',
}));

// Mock env reader used for secret injection
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
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

// Mock container-runtime helpers used by container-runner
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'container',
  readonlyMountArgs: (hostPath: string, containerPath: string) => [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ],
  stopRunningContainersByPrefix: vi.fn(() => ({
    matched: [],
    stopped: [],
    failures: [],
  })),
  stopContainerWithVerification: vi.fn(() => ({
    stopped: true,
    attempts: ['ok: container stop test'],
  })),
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
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { readEnvFile } from './env.js';
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

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
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

  it('applies CPU and memory limits to container run args', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnMock = vi.mocked(spawn);
    expect(spawnMock).toHaveBeenCalled();
    const args = spawnMock.mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain('--cpus');
    expect(args).toContain('2');
    expect(args).toContain('--memory');
    expect(args).toContain('4096M');
  });
});

describe('container-runner role-based github token selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(readEnvFile).mockReturnValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runAndCaptureInput(group: RegisteredGroup): Promise<Record<string, unknown>> {
    let stdinPayload = '';
    fakeProc.stdin.on('data', (chunk) => {
      stdinPayload += chunk.toString();
    });

    const resultPromise = runContainerAgent(group, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    return JSON.parse(stdinPayload) as Record<string, unknown>;
  }

  it('uses worker token for jarvis workers', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      GITHUB_TOKEN_WORKER: 'worker-token',
      GITHUB_TOKEN: 'fallback-token',
    });

    const input = await runAndCaptureInput({
      ...testGroup,
      folder: 'jarvis-worker-1',
    });
    const secrets = input.secrets as Record<string, string>;

    expect(secrets.GITHUB_TOKEN).toBe('worker-token');
    expect(secrets.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(secrets.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('uses andy-developer token and includes claude secrets', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      GITHUB_TOKEN_ANDY_DEVELOPER: 'andy-dev-token',
      GITHUB_TOKEN: 'fallback-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth',
      ANTHROPIC_API_KEY: 'anthropic-key',
    });

    const input = await runAndCaptureInput({
      ...testGroup,
      folder: 'andy-developer',
    });
    const secrets = input.secrets as Record<string, string>;

    expect(secrets.GITHUB_TOKEN).toBe('andy-dev-token');
    expect(secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe('claude-oauth');
    expect(secrets.ANTHROPIC_API_KEY).toBe('anthropic-key');
  });

  it('falls back to shared token for andy-bot if role token is missing', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      GITHUB_TOKEN: 'fallback-token',
    });

    const input = await runAndCaptureInput({
      ...testGroup,
      folder: 'andy-bot',
    });
    const secrets = input.secrets as Record<string, string>;

    expect(secrets.GITHUB_TOKEN).toBe('fallback-token');
  });
});
