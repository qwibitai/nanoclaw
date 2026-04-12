import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match agent-spawn-markers.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('../core/config.js', () => ({
  AGENT_MEMORY_ROOT: '/tmp/nanoclaw-agent-memory',
  AGENT_MAX_OUTPUT_SIZE: 10485760,
  AGENT_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  NANOCLAW_CONFIG_DIR: '/tmp/nanoclaw-config',
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
  getEffectiveModelConfig: vi.fn((groupModel?: string) =>
    groupModel
      ? { model: groupModel, source: 'group.agentConfig.model' }
      : { source: 'unset' },
  ),
}));

// Mock logger
vi.mock('../core/logger.js', () => ({
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
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock agent-spawn-host to avoid real filesystem operations
vi.mock('./agent-spawn-host.js', () => ({
  getHostRuntimeCredentialEnv: vi.fn().mockResolvedValue({
    env: {},
    onecliApplied: false,
  }),
  prepareHostRuntimeContext: vi.fn(() => ({
    groupDir: '/tmp/nanoclaw-test-data/groups/test-group',
    groupIpcDir: '/tmp/nanoclaw-test-data/ipc/test-group',
  })),
}));

// Mock prompt-profile
vi.mock('./prompt-profile.js', () => ({
  getPromptProfileService: vi.fn(() => ({
    compileSystemPrompt: vi.fn(() => ''),
  })),
}));

// Mock platform
vi.mock('../platform/group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/nanoclaw-test-data/groups/${folder}`,
  ),
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
  };
});

import { spawnAgent, AgentOutput } from './agent-spawn.js';
import { getEffectiveModelConfig } from '../core/config.js';
import { spawn } from 'child_process';
import type { RegisteredGroup } from '../core/types.js';

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
  output: AgentOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('agent-spawn timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(getEffectiveModelConfig).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = spawnAgent(testGroup, testInput, () => {}, onOutput);

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

    // Emit close event (as if process was killed by the timeout)
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
    const resultPromise = spawnAgent(testGroup, testInput, () => {}, onOutput);

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
    const resultPromise = spawnAgent(testGroup, testInput, () => {}, onOutput);

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

  it('passes effective model to process env when configured', async () => {
    vi.mocked(getEffectiveModelConfig).mockReturnValue({
      model: 'opus',
      source: 'group.agentConfig.model' as const,
    });
    const groupWithModel: RegisteredGroup = {
      ...testGroup,
      agentConfig: { model: 'opus' },
    };
    const resultPromise = spawnAgent(groupWithModel, testInput, () => {});

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(vi.mocked(getEffectiveModelConfig)).toHaveBeenCalledWith('opus');
    const spawnCalls = vi.mocked(spawn).mock.calls;
    expect(spawnCalls.length).toBeGreaterThan(0);
    // Host mode passes model via env, not args
    const env = spawnCalls[spawnCalls.length - 1][2]?.env as Record<
      string,
      string
    >;
    expect(env.ANTHROPIC_MODEL).toBe('opus');
    expect(env.CLAUDE_MODEL).toBe('opus');
  });

  it('forwards AGENT_MEMORY_ROOT via env when configured', async () => {
    const resultPromise = spawnAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    expect(spawnCalls.length).toBeGreaterThan(0);
    const env = spawnCalls[spawnCalls.length - 1][2]?.env as Record<
      string,
      string
    >;
    expect(env.AGENT_MEMORY_ROOT).toBe('/tmp/nanoclaw-agent-memory');
  });
});
