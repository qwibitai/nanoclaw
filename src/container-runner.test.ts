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

// Mock provider selection
const mockContainerProviderEnv: Record<string, string> = {
  NANOCLAW_PROVIDER_CONFIG_JSON: JSON.stringify({
    providers: {
      claude: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        apiKey: 'placeholder-claude',
        baseURL: 'http://host.docker.internal:3001/__provider/claude',
      },
    },
    defaultProvider: 'claude',
    fallbackProviders: [],
  }),
};

vi.mock('./provider-config.js', () => ({
  resolveProviderConfig: vi.fn(() => ({
    providers: {
      claude: {
        name: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usesCredentialProxy: true,
        allowDirectSecretInjection: false,
        apiKey: 'sk-ant-real-key',
        upstreamBaseURL: 'https://api.anthropic.com',
      },
    },
    defaultProvider: 'claude',
    fallbackProviders: [],
    allowDirectSecretInjection: false,
    source: 'yaml',
  })),
  buildContainerProviderEnv: vi.fn(() => ({ ...mockContainerProviderEnv })),
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
  groupType: 'chat' as const,
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
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    for (const key of Object.keys(mockContainerProviderEnv)) {
      delete mockContainerProviderEnv[key];
    }
    Object.assign(mockContainerProviderEnv, {
      NANOCLAW_PROVIDER_CONFIG_JSON: JSON.stringify({
        providers: {
          claude: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            apiKey: 'placeholder-claude',
            baseURL: 'http://host.docker.internal:3001/__provider/claude',
          },
        },
        defaultProvider: 'claude',
        fallbackProviders: [],
      }),
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

  it('uses folder-shared session namespace for thread groups', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        chatJid: 'dc:thread-1',
        groupType: 'thread',
      },
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const args = spawnCalls[spawnCalls.length - 1][1] as string[];
    const joined = args.join(' ');
    expect(joined).toContain(
      '/tmp/nanoclaw-test-data/sessions/folder-test-group/.claude:/home/bun/.claude',
    );
  });

  it('uses chatJid-isolated session namespace for main groups', async () => {
    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        type: 'main',
      },
      {
        ...testInput,
        chatJid: 'main@g.us',
        groupType: 'main',
      },
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const args = spawnCalls[spawnCalls.length - 1][1] as string[];
    const joined = args.join(' ');
    expect(joined).toContain(
      '/tmp/nanoclaw-test-data/sessions/jid-main%40g.us/.claude:/home/bun/.claude',
    );
  });

  it('falls back to group.folder when parent_folder is invalid', async () => {
    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        parent_folder: '../invalid-folder',
      },
      {
        ...testInput,
        chatJid: 'dc:thread-1',
        groupType: 'thread',
      },
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const args = spawnCalls[spawnCalls.length - 1][1] as string[];
    const joined = args.join(' ');
    expect(joined).toContain(
      '/tmp/nanoclaw-test-groups/test-group:/workspace/group',
    );
    expect(joined).not.toContain('../invalid-folder');
  });

  it('injects OpenAI placeholder env when provider env mapping switches', async () => {
    for (const key of Object.keys(mockContainerProviderEnv)) {
      delete mockContainerProviderEnv[key];
    }
    Object.assign(mockContainerProviderEnv, {
      NANOCLAW_PROVIDER_CONFIG_JSON: JSON.stringify({
        providers: {
          fast: {
            provider: 'openai',
            model: 'gpt-4.1-mini',
            apiKey: 'placeholder-fast',
            baseURL: 'http://host.docker.internal:3001/__provider/fast',
          },
        },
        defaultProvider: 'fast',
        fallbackProviders: [],
      }),
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const args = spawnCalls[spawnCalls.length - 1][1] as string[];
    const joined = args.join(' ');
    expect(joined).toContain('-e NANOCLAW_PROVIDER_CONFIG_JSON=');
    expect(joined).toContain('__provider/fast');
    expect(joined).toContain('placeholder-fast');
  });

  it('injects direct Gemini key when provider env mapping switches', async () => {
    for (const key of Object.keys(mockContainerProviderEnv)) {
      delete mockContainerProviderEnv[key];
    }
    Object.assign(mockContainerProviderEnv, {
      NANOCLAW_PROVIDER_CONFIG_JSON: JSON.stringify({
        providers: {
          gemini: {
            provider: 'google',
            model: 'gemini-2.5-flash',
            apiKey: 'gemini-real-key',
          },
        },
        defaultProvider: 'gemini',
        fallbackProviders: [],
      }),
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const args = spawnCalls[spawnCalls.length - 1][1] as string[];
    const joined = args.join(' ');
    expect(joined).toContain('-e NANOCLAW_PROVIDER_CONFIG_JSON=');
    expect(joined).toContain('gemini-real-key');
    expect(joined).not.toContain('__provider/claude');
  });

  it('injects Codex oauth json when provider env mapping switches', async () => {
    for (const key of Object.keys(mockContainerProviderEnv)) {
      delete mockContainerProviderEnv[key];
    }
    Object.assign(mockContainerProviderEnv, {
      NANOCLAW_PROVIDER_CONFIG_JSON: JSON.stringify({
        providers: {
          codex: {
            provider: 'codex',
            model: 'gpt-5.4',
            codexOAuthJson: '{"access":"a","refresh":"r","expires":1}',
          },
        },
        defaultProvider: 'codex',
        fallbackProviders: [],
      }),
    });

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const args = spawnCalls[spawnCalls.length - 1][1] as string[];
    const joined = args.join(' ');
    expect(joined).toContain('-e NANOCLAW_PROVIDER_CONFIG_JSON=');
    expect(joined).toContain('gpt-5.4');
    expect(joined).toContain('codexOAuthJson');
  });
});
