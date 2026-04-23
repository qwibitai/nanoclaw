import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---AGENTLITE_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AGENTLITE_OUTPUT_END---';

// runtime-config no longer exports PACKAGE_ROOT — it's in RuntimeConfig
vi.mock('./runtime-config.js', () => ({}));

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

import fs from 'fs';

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
  type ContainerEvent,
  type VolumeMount,
} from './container-runner.js';
import type { RuntimeConfig } from './runtime-config.js';
import type { RegisteredGroup } from './types.js';

const testRuntimeConfig: RuntimeConfig = {
  packageRoot: '/tmp/agentlite-test-package',
  workdir: '/tmp/agentlite-test',
  boxImage: 'agentlite-agent:latest',
  boxRootfsPath: '',
  boxMemoryMib: 2048,
  boxCpus: 2,
  maxConcurrentContainers: 5,
  containerTimeout: 1800000, // 30min
  containerMaxOutputSize: 10485760,
  idleTimeout: 1800000, // 30min
  onecliUrl: 'http://localhost:10254',
  timezone: 'America/Los_Angeles',
  pollInterval: 2000,
  schedulerPollInterval: 60000,
  ipcPollInterval: 1000,
};

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
  output: ContainerEvent,
) {
  const json = JSON.stringify(output);
  exec.pushStdout(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

async function startContainerRun(
  input: Parameters<typeof runContainerAgent>[1] = testInput,
) {
  const onOutput = vi.fn(async () => {});
  const resultPromise = runContainerAgent(
    testGroup,
    input,
    testRuntimeConfig,
    () => {},
    onOutput,
  );

  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

  expect(mockSpawnBox).toHaveBeenCalled();
  const spawnCall = mockSpawnBox.mock.calls.at(-1)!;
  const stdinJson = spawnCall[5] as string;

  return {
    onOutput,
    resultPromise,
    mounts: spawnCall[2] as VolumeMount[],
    boxEnv: spawnCall[3] as Record<string, string>,
    parsedInput: JSON.parse(stdinJson) as Record<string, unknown>,
    async finish(exitCode = 0) {
      mockExec.closeStdout();
      mockExec.closeStderr();
      mockExec.resolveWait(exitCode);
      await vi.advanceTimersByTimeAsync(10);
      return resultPromise;
    },
  };
}

describe('container-runner with BoxLite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockExec = createMockExecution();
    mockSpawnBox.mockResolvedValue({
      box: mockBox,
      execution: mockExec.execution,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after idle resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      testRuntimeConfig,
      () => {},
      onOutput,
    );

    // Settle the deep async setup chain (dynamic import → OneCLI →
    // buildBoxConfig → spawnBox → readStdout). Each await in the chain
    // needs a microtask flush; individual small advances ensure full drainage
    // that a single advanceTimersByTimeAsync may not achieve.
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

    emitOutputToExec(mockExec, {
      type: 'state',
      state: 'active',
    });
    emitOutputToExec(mockExec, {
      type: 'result',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });
    emitOutputToExec(mockExec, {
      type: 'state',
      state: 'idle',
      newSessionId: 'session-123',
    });

    // Settle output processing (resets timeout and records explicit idle)
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

    // Fire the hard timeout. resetTimeout() rescheduled the timer,
    // so advance well past it to avoid boundary timing issues.
    await vi.advanceTimersByTimeAsync(1830000 + 1000);

    // Close streams and resolve wait (simulating box being killed)
    mockExec.closeStdout();
    mockExec.closeStderr();
    mockExec.resolveWait(137);

    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'state', state: 'active' }),
    );
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        result: 'Here is my response',
      }),
    );
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'state', state: 'idle' }),
    );
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state',
        state: 'stopped',
        reason: 'idle_timeout',
        exitCode: 137,
      }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      testRuntimeConfig,
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
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state',
        state: 'stopped',
        reason: 'timeout',
        exitCode: 137,
      }),
    );
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      testRuntimeConfig,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(10);

    // Emit output
    emitOutputToExec(mockExec, {
      type: 'result',
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
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state',
        state: 'stopped',
        reason: 'exit',
        exitCode: 0,
      }),
    );
  });

  it('timeout after active output without idle stays an error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      testRuntimeConfig,
      () => {},
      onOutput,
    );

    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

    emitOutputToExec(mockExec, {
      type: 'state',
      state: 'active',
    });
    emitOutputToExec(mockExec, {
      type: 'result',
      result: 'Partial output',
    });

    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

    await vi.advanceTimersByTimeAsync(1830000 + 1000);

    mockExec.closeStdout();
    mockExec.closeStderr();
    mockExec.resolveWait(137);

    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state',
        state: 'stopped',
        reason: 'timeout',
        exitCode: 137,
      }),
    );
  });

  it('streams sdk_message events through stdout markers', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      testRuntimeConfig,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(10);

    emitOutputToExec(mockExec, {
      type: 'sdk_message',
      sdkType: 'assistant',
      message: {
        uuid: 'a1',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              id: 'tool-abc',
              input: { command: 'echo hello' },
            },
          ],
        },
      },
    });
    emitOutputToExec(mockExec, {
      type: 'sdk_message',
      sdkType: 'tool_progress',
      message: {
        tool_name: 'Bash',
        tool_use_id: 'tool-abc',
        elapsed_time_seconds: 2.5,
      },
    });
    emitOutputToExec(mockExec, {
      type: 'sdk_message',
      sdkType: 'stream_event',
      message: {
        event: { type: 'content_block_delta', delta: { text: 'hi' } },
      },
    });
    emitOutputToExec(mockExec, {
      type: 'result',
      result: 'hello',
      newSessionId: 'session-tool',
    });

    await vi.advanceTimersByTimeAsync(10);

    mockExec.closeStdout();
    mockExec.closeStderr();
    mockExec.resolveWait(0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const sdkCalls = (onOutput.mock.calls as unknown as [ContainerEvent][])
      .map(([evt]) => evt)
      .filter((e) => e.type === 'sdk_message');
    expect(sdkCalls).toHaveLength(3);
    expect(sdkCalls.map((e: any) => e.sdkType)).toEqual([
      'assistant',
      'tool_progress',
      'stream_event',
    ]);
  });

  it('streams sdk_message with system subtypes through stdout markers', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      testRuntimeConfig,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(10);

    emitOutputToExec(mockExec, {
      type: 'sdk_message',
      sdkType: 'system',
      sdkSubtype: 'task_started',
      message: {
        subtype: 'task_started',
        task_id: 'task-e2e',
        description: 'Running research',
      },
    });
    emitOutputToExec(mockExec, {
      type: 'sdk_message',
      sdkType: 'system',
      sdkSubtype: 'status',
      message: { subtype: 'status', status: 'compacting' },
    });
    emitOutputToExec(mockExec, {
      type: 'sdk_message',
      sdkType: 'rate_limit_event',
      message: { rate_limit_info: { status: 'allowed' } },
    });

    await vi.advanceTimersByTimeAsync(10);

    mockExec.closeStdout();
    mockExec.closeStderr();
    mockExec.resolveWait(0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const sdkCalls = (onOutput.mock.calls as unknown as [ContainerEvent][])
      .map(([evt]) => evt)
      .filter((e) => e.type === 'sdk_message');
    expect(sdkCalls).toHaveLength(3);
    expect(sdkCalls[0]).toMatchObject({
      sdkType: 'system',
      sdkSubtype: 'task_started',
    });
    expect(sdkCalls[1]).toMatchObject({
      sdkType: 'system',
      sdkSubtype: 'status',
    });
    expect(sdkCalls[2]).toMatchObject({
      sdkType: 'rate_limit_event',
    });
  });

  it('resets timeout on sdk_message events', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      testRuntimeConfig,
      () => {},
      onOutput,
    );

    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

    // Emit an sdk_message partway through the timeout window
    await vi.advanceTimersByTimeAsync(1800000 - 100);
    emitOutputToExec(mockExec, {
      type: 'sdk_message',
      sdkType: 'tool_progress',
      message: {
        tool_name: 'Bash',
        tool_use_id: 't1',
        elapsed_time_seconds: 10,
      },
    });
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

    // Another sdk_message to keep alive
    await vi.advanceTimersByTimeAsync(1800000 - 100);
    emitOutputToExec(mockExec, {
      type: 'sdk_message',
      sdkType: 'system',
      sdkSubtype: 'task_started',
      message: {
        subtype: 'task_started',
        task_id: 't2',
        description: 'keep alive',
      },
    });
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);

    // Now exit cleanly
    mockExec.closeStdout();
    mockExec.closeStderr();
    mockExec.resolveWait(0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
  });

  // ── actionsAuth transport ──────────────────────────────────────
  // These tests lock in the contract that actions auth travels as a
  // first-class field of the ContainerInput JSON — not as env vars on
  // the box. See docs: "Unify actions-auth transport" plan.

  it('serializes actionsAuth into the stdin JSON payload', async () => {
    const run = await startContainerRun({
      ...testInput,
      actionsAuth: { url: 'http://10.0.0.1:7777', token: 'tok-abc' },
    });

    expect(run.parsedInput.actionsAuth).toEqual({
      url: 'http://10.0.0.1:7777',
      token: 'tok-abc',
    });

    await run.finish();
  });

  it('serializes agentBackend into the stdin JSON payload', async () => {
    const run = await startContainerRun({
      ...testInput,
      agentBackend: { type: 'codex' },
    });

    expect(run.parsedInput.agentBackend).toEqual({ type: 'codex' });

    await run.finish();
  });

  it('mounts every agent backend home into the container', async () => {
    const run = await startContainerRun();

    expect(run.mounts).toEqual(
      expect.arrayContaining([
        {
          hostPath: '/tmp/agentlite-test/data/sessions/test-group/.claude',
          containerPath: '/home/node/.claude',
          readonly: false,
        },
        {
          hostPath: '/tmp/agentlite-test/data/sessions/test-group/.codex',
          containerPath: '/home/node/.codex',
          readonly: false,
        },
      ]),
    );

    await run.finish();
  });

  it('initializes Claude Code settings without Codex-specific settings', async () => {
    const run = await startContainerRun();
    const writeFileSyncCalls = (
      fs.writeFileSync as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;

    const claudeSettingsCall = writeFileSyncCalls.find(([file]) =>
      String(file).endsWith('/.claude/settings.json'),
    );
    expect(claudeSettingsCall).toBeDefined();
    expect(
      writeFileSyncCalls.some(([file]) =>
        String(file).endsWith('/.codex/settings.json'),
      ),
    ).toBe(false);

    const settings = JSON.parse(String(claudeSettingsCall![1]));
    expect(settings.env).toMatchObject({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    });

    await run.finish();
  });

  it('does not set AGENTLITE_ACTIONS_URL/TOKEN env vars on the box', async () => {
    const run = await startContainerRun({
      ...testInput,
      actionsAuth: { url: 'http://10.0.0.1:7777', token: 'tok-xyz' },
    });

    expect(run.boxEnv).not.toHaveProperty('AGENTLITE_ACTIONS_URL');
    expect(run.boxEnv).not.toHaveProperty('AGENTLITE_ACTIONS_TOKEN');

    await run.finish();
  });

  it('omits actionsAuth from stdin JSON when the caller passes none', async () => {
    const run = await startContainerRun();

    expect(run.parsedInput.actionsAuth).toBeUndefined();

    await run.finish();
  });

  it('does not extract newSessionId from sdk_message events', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      testRuntimeConfig,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(10);

    // sdk_message doesn't carry newSessionId
    emitOutputToExec(mockExec, {
      type: 'sdk_message',
      sdkType: 'assistant',
      message: { uuid: 'a1', message: { content: [] } },
    });
    // Only result carries the session
    emitOutputToExec(mockExec, {
      type: 'result',
      result: 'done',
      newSessionId: 'session-only-here',
    });

    await vi.advanceTimersByTimeAsync(10);

    mockExec.closeStdout();
    mockExec.closeStderr();
    mockExec.resolveWait(0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-only-here');
  });
});
