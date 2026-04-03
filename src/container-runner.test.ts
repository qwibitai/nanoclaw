import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---AGENTLITE_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AGENTLITE_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  PACKAGE_ROOT: '/tmp/agentlite-test-package',
  BOX_IMAGE: 'agentlite-agent:latest',
  BOX_ROOTFS_PATH: '',
  BOX_MEMORY_MIB: 2048,
  BOX_CPUS: 2,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/agentlite-test-data',
  GROUPS_DIR: '/tmp/agentlite-test-groups',
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
      cpSync: vi.fn(),
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
  },
}));

// Mock BoxLite runtime
interface MockStdoutLine {
  resolve: (line: string | null) => void;
}

function createMockExecution() {
  const stdoutQueue: string[] = [];
  const stdoutWaiters: MockStdoutLine[] = [];
  let stdoutClosed = false;

  const stderrQueue: string[] = [];
  const stderrWaiters: MockStdoutLine[] = [];
  let stderrClosed = false;

  let waitResolve: (result: { exitCode: number }) => void;
  const waitPromise = new Promise<{ exitCode: number }>((resolve) => {
    waitResolve = resolve;
  });

  const mockStdin = {
    writeString: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockStdout = {
    next: vi.fn(() => {
      if (stdoutQueue.length > 0) {
        return Promise.resolve(stdoutQueue.shift()!);
      }
      if (stdoutClosed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        stdoutWaiters.push({ resolve });
      });
    }),
  };

  const mockStderr = {
    next: vi.fn(() => {
      if (stderrQueue.length > 0) {
        return Promise.resolve(stderrQueue.shift()!);
      }
      if (stderrClosed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        stderrWaiters.push({ resolve });
      });
    }),
  };

  const execution = {
    stdin: vi.fn().mockResolvedValue(mockStdin),
    stdout: vi.fn().mockResolvedValue(mockStdout),
    stderr: vi.fn().mockResolvedValue(mockStderr),
    wait: vi.fn(() => waitPromise),
    kill: vi.fn().mockResolvedValue(undefined),
  };

  return {
    execution,
    mockStdin,
    pushStdout(line: string) {
      if (stdoutWaiters.length > 0) {
        stdoutWaiters.shift()!.resolve(line);
      } else {
        stdoutQueue.push(line);
      }
    },
    closeStdout() {
      stdoutClosed = true;
      for (const w of stdoutWaiters) w.resolve(null);
      stdoutWaiters.length = 0;
    },
    closeStderr() {
      stderrClosed = true;
      for (const w of stderrWaiters) w.resolve(null);
      stderrWaiters.length = 0;
    },
    resolveWait(exitCode: number) {
      waitResolve!({ exitCode });
    },
  };
}

let mockExec: ReturnType<typeof createMockExecution>;
const mockBox = {
  stop: vi.fn().mockResolvedValue(undefined),
};

const mockSpawnBox = vi.fn();

vi.mock('./box-runtime.js', () => ({
  getRuntime: () => ({}),
  stopBox: vi.fn().mockResolvedValue(undefined),
  spawnBox: (...args: any[]) => mockSpawnBox(...args),
}));

import {
  runContainerAgent,
  setModelOptions,
  setGroupModelOptions,
  resetModelOptions,
  deleteGroupModelOptions,
  addGroupModelOptions,
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

function emitOutputToExec(
  exec: ReturnType<typeof createMockExecution>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  exec.pushStdout(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner with BoxLite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockExec = createMockExecution();
    mockSpawnBox.mockResolvedValue({
      box: mockBox,
      execution: mockExec.execution,
    });
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

    // Let box creation and exec settle
    await vi.advanceTimersByTimeAsync(10);

    // Emit output with a result
    emitOutputToExec(mockExec, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Close streams and resolve wait (simulating box being killed)
    mockExec.closeStdout();
    mockExec.closeStderr();
    mockExec.resolveWait(137);

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

    await vi.advanceTimersByTimeAsync(10);

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Close streams and resolve wait
    mockExec.closeStdout();
    mockExec.closeStderr();
    mockExec.resolveWait(137);

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

    await vi.advanceTimersByTimeAsync(10);

    // Emit output
    emitOutputToExec(mockExec, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    mockExec.closeStdout();
    mockExec.closeStderr();
    mockExec.resolveWait(0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('per-group model options', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockExec = createMockExecution();
    mockSpawnBox.mockResolvedValue({
      box: mockBox,
      execution: mockExec.execution,
    });
    // Reset model options between tests
    setModelOptions({});
    setGroupModelOptions(new Map());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Helper: run agent, emit success output, and return the boxEnv passed to spawnBox */
  async function runAndGetBoxEnv(
    group: RegisteredGroup,
    input = testInput,
  ): Promise<Record<string, string>> {
    const resultPromise = runContainerAgent(group, input, () => {});
    await vi.advanceTimersByTimeAsync(10);
    emitOutputToExec(mockExec, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    mockExec.closeStdout();
    mockExec.closeStderr();
    mockExec.resolveWait(0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // spawnBox(groupName, containerName, mounts, boxEnv, ...)
    const lastCall = mockSpawnBox.mock.calls[mockSpawnBox.mock.calls.length - 1];
    return lastCall[3]; // boxEnv is the 4th arg
  }

  it('injects CLAUDE_MODEL from global model options', async () => {
    setModelOptions({ model: 'claude-sonnet-4-6' });

    const boxEnv = await runAndGetBoxEnv(testGroup);
    expect(boxEnv['CLAUDE_MODEL']).toBe('claude-sonnet-4-6');
  });

  it('omits CLAUDE_MODEL when no model is configured', async () => {
    setModelOptions({});

    const boxEnv = await runAndGetBoxEnv(testGroup);
    expect(boxEnv['CLAUDE_MODEL']).toBeUndefined();
  });

  it('per-group model overrides global model', async () => {
    setModelOptions({ model: 'claude-sonnet-4-6' });
    setGroupModelOptions(
      new Map([['test-group', { model: 'claude-haiku-4-5-20251001' }]]),
    );

    const boxEnv = await runAndGetBoxEnv(testGroup);
    expect(boxEnv['CLAUDE_MODEL']).toBe('claude-haiku-4-5-20251001');
  });

  it('groups without per-group model fall back to global', async () => {
    setModelOptions({ model: 'claude-sonnet-4-6' });
    setGroupModelOptions(
      new Map([['other-group', { model: 'claude-haiku-4-5-20251001' }]]),
    );

    const boxEnv = await runAndGetBoxEnv(testGroup);
    expect(boxEnv['CLAUDE_MODEL']).toBe('claude-sonnet-4-6');
  });

  it('per-group credentials override global credentials', async () => {
    const globalCreds = vi
      .fn()
      .mockResolvedValue({ ANTHROPIC_API_KEY: 'global-key' });
    const groupCreds = vi
      .fn()
      .mockResolvedValue({ ANTHROPIC_API_KEY: 'group-key' });

    setModelOptions({ credentials: globalCreds });
    setGroupModelOptions(
      new Map([['test-group', { credentials: groupCreds }]]),
    );

    const boxEnv = await runAndGetBoxEnv(testGroup);
    expect(boxEnv['ANTHROPIC_API_KEY']).toBe('group-key');
    expect(groupCreds).toHaveBeenCalled();
    expect(globalCreds).not.toHaveBeenCalled();
  });

  it('falls back to global credentials when no per-group credentials', async () => {
    const globalCreds = vi
      .fn()
      .mockResolvedValue({ ANTHROPIC_API_KEY: 'global-key' });

    setModelOptions({ credentials: globalCreds });
    // No per-group credentials set

    const boxEnv = await runAndGetBoxEnv(testGroup);
    expect(boxEnv['ANTHROPIC_API_KEY']).toBe('global-key');
    expect(globalCreds).toHaveBeenCalled();
  });

  it('per-group model and credentials work together', async () => {
    setModelOptions({
      model: 'claude-sonnet-4-6',
      credentials: vi.fn().mockResolvedValue({ ANTHROPIC_API_KEY: 'global' }),
    });
    setGroupModelOptions(
      new Map([
        [
          'test-group',
          {
            model: 'claude-haiku-4-5-20251001',
            credentials: vi
              .fn()
              .mockResolvedValue({ ANTHROPIC_API_KEY: 'group' }),
          },
        ],
      ]),
    );

    const boxEnv = await runAndGetBoxEnv(testGroup);
    expect(boxEnv['CLAUDE_MODEL']).toBe('claude-haiku-4-5-20251001');
    expect(boxEnv['ANTHROPIC_API_KEY']).toBe('group');
  });

  it('resetModelOptions clears all state', async () => {
    setModelOptions({ model: 'claude-sonnet-4-6', credentials: vi.fn().mockResolvedValue({ ANTHROPIC_API_KEY: 'key' }) });
    setGroupModelOptions(
      new Map([['test-group', { model: 'claude-haiku-4-5-20251001' }]]),
    );

    // Reset everything
    resetModelOptions();

    const boxEnv = await runAndGetBoxEnv(testGroup);
    expect(boxEnv['CLAUDE_MODEL']).toBeUndefined();
    // Falls back to OneCLI (mocked, returns empty env for API key)
    expect(boxEnv['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('re-registering group without model clears previous override', async () => {
    setModelOptions({ model: 'claude-sonnet-4-6' });
    addGroupModelOptions('test-group', { model: 'claude-haiku-4-5-20251001' });

    // Simulate re-registration without model — delete the per-group override
    deleteGroupModelOptions('test-group');

    const boxEnv = await runAndGetBoxEnv(testGroup);
    // Should fall back to global model, not the deleted per-group one
    expect(boxEnv['CLAUDE_MODEL']).toBe('claude-sonnet-4-6');
  });
});
