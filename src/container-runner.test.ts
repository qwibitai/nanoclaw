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
  ONECLI_URL: 'http://localhost:10254',
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

// Mock env reader (used by plugin hooks)
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock plugin barrel (side-effect import — no-op in tests)
vi.mock('./plugins/index.js', () => ({}));

// Mock plugin registry
const mockRunPluginHooks = vi.fn().mockResolvedValue(undefined);
const mockGetPluginEnvKeys = vi.fn(() => [] as string[]);
vi.mock('./plugins/registry.js', () => ({
  getPluginEnvKeys: () => mockGetPluginEnvKeys(),
  runPluginHooks: (...args: unknown[]) => mockRunPluginHooks(...args),
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
import { readEnvFile } from './env.js';

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

describe('container-runner plugin hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    mockRunPluginHooks.mockClear();
    mockGetPluginEnvKeys.mockClear();
    vi.mocked(readEnvFile).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads plugin env keys and calls preStart before spawning', async () => {
    mockGetPluginEnvKeys.mockReturnValue(['PLUGIN_KEY']);
    vi.mocked(readEnvFile).mockReturnValue({ PLUGIN_KEY: 'secret' });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));

    // preStart must be called before we even get output
    expect(mockRunPluginHooks).toHaveBeenCalledWith('preStart', { PLUGIN_KEY: 'secret' });

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('calls postStop after container exits', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));

    emitOutputMarker(fakeProc, { status: 'success', result: 'done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(mockRunPluginHooks).toHaveBeenCalledWith('postStop', expect.any(Object));
  });

  it('calls preStart before postStop across the container lifecycle', async () => {
    const callOrder: string[] = [];
    mockRunPluginHooks.mockImplementation(async (phase: string) => {
      callOrder.push(phase);
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(callOrder[0]).toBe('preStart');
    expect(callOrder[callOrder.length - 1]).toBe('postStop');
  });

  it('passes the env read from readEnvFile to both hooks', async () => {
    const env = { MY_TOKEN: 'abc123' };
    mockGetPluginEnvKeys.mockReturnValue(['MY_TOKEN']);
    vi.mocked(readEnvFile).mockReturnValue(env);

    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    for (const call of mockRunPluginHooks.mock.calls) {
      expect(call[1]).toEqual(env);
    }
  });

  it('postStop failure is swallowed and does not reject the run', async () => {
    mockRunPluginHooks.mockImplementation(async (phase: string) => {
      if (phase === 'postStop') throw new Error('tailscale down failed');
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // Run still succeeds despite postStop throwing
    expect(result.status).toBe('success');
  });
});
