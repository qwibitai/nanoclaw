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
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

// Mock env-forward — default to no forwarded vars
const mockGetForwardedEnv = vi.fn(() => ({} as Record<string, string>));
vi.mock('./env-forward.js', () => ({
  getForwardedEnv: () => mockGetForwardedEnv(),
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
import { spawn } from 'child_process';

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

describe('container-runner env forwarding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
    mockGetForwardedEnv.mockReturnValue({});
  });

  function captureSpawnArgs(): Promise<string[]> {
    return new Promise((resolve) => {
      (spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_bin: string, args: string[]) => {
          resolve(args);
          return fakeProc;
        },
      );
    });
  }

  async function spawnAndClose(
    forwardedEnv: Record<string, string>,
  ): Promise<string[]> {
    mockGetForwardedEnv.mockReturnValue(forwardedEnv);
    const argsPromise = captureSpawnArgs();

    const containerPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
    );

    const args = await argsPromise;

    // Settle the container (clean exit)
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await containerPromise;

    return args;
  }

  it('emits no -e flags when forward-list is empty', async () => {
    const args = await spawnAndClose({});

    // Collect all -e values
    const envFlags: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-e') envFlags.push(args[i + 1]);
    }

    // Only the standard nanoclaw env vars should be present
    const forwardedFlags = envFlags.filter(
      (f) =>
        !f.startsWith('TZ=') &&
        !f.startsWith('ANTHROPIC_BASE_URL=') &&
        !f.startsWith('ANTHROPIC_API_KEY=') &&
        !f.startsWith('CLAUDE_CODE_OAUTH_TOKEN=') &&
        !f.startsWith('HOME='),
    );
    expect(forwardedFlags).toEqual([]);
  });

  it('emits -e KEY=VAL for each var in the forwarded env', async () => {
    const args = await spawnAndClose({ NOTION_API_KEY: 'secret-token' });

    // Find the pair -e NOTION_API_KEY=secret-token
    const idx = args.indexOf('NOTION_API_KEY=secret-token');
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe('-e');
  });

  it('emits forwarded env flags in alphabetical order', async () => {
    const args = await spawnAndClose({
      ZEBRA_TOKEN: 'z',
      ALPHA_KEY: 'a',
      MIDDLE_VAR: 'm',
    });

    const forwardedFlags: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (
        args[i] === '-e' &&
        (args[i + 1].startsWith('ZEBRA_') ||
          args[i + 1].startsWith('ALPHA_') ||
          args[i + 1].startsWith('MIDDLE_'))
      ) {
        forwardedFlags.push(args[i + 1]);
      }
    }

    expect(forwardedFlags).toEqual([
      'ALPHA_KEY=a',
      'MIDDLE_VAR=m',
      'ZEBRA_TOKEN=z',
    ]);
  });

  it('forwarded env flags appear before volume mounts', async () => {
    const args = await spawnAndClose({ NOTION_API_KEY: 'tok' });

    const envFlagIdx = args.indexOf('NOTION_API_KEY=tok') - 1;
    const firstVolumeIdx = args.indexOf('-v');

    expect(envFlagIdx).toBeGreaterThan(0);
    expect(firstVolumeIdx).toBeGreaterThan(0);
    expect(envFlagIdx).toBeLessThan(firstVolumeIdx);
  });
});
