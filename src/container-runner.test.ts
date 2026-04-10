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
  ONECLI_API_KEY: '',
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
import fs from 'fs';
import { logger } from './logger.js';

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

describe('MCP skill env var forwarding', () => {
  const ALL_KEYS = [
    'TS_API_KEY',
    'TS_API_CLIENT_ID',
    'TS_API_CLIENT_SECRET',
    'TS_API_TAILNET',
    'HA_URL',
    'HA_TOKEN',
    'OLLAMA_URL',
    'LITELLM_URL',
    'LITELLM_MASTER_KEY',
    'UNRAIDCLAW_SERVERS',
    'UNRAIDCLAW_API_KEY',
    'UNRAIDCLAW_URL',
    'PAPERCLIP_URL',
    'PAPERCLIP_AGENT_JWT_SECRET',
    'PAPERCLIP_AGENT_ID',
    'PAPERCLIP_COMPANY_ID',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(spawn).mockClear();
    vi.mocked(logger.debug).mockClear();
    for (const key of ALL_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of ALL_KEYS) {
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      } else {
        delete process.env[key];
      }
    }
  });

  function getSpawnArgs(): string[] {
    const call = vi.mocked(spawn).mock.calls[0];
    return call ? (call[1] as string[]) : [];
  }

  async function runOnce() {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  }

  it('forwards vars that are set in process.env', async () => {
    process.env.TS_API_KEY = 'tskey-test';
    process.env.HA_URL = 'http://ha:8123';
    process.env.HA_TOKEN = 'ha-token-secret';
    process.env.OLLAMA_URL = 'http://ollama:11434';
    process.env.UNRAIDCLAW_API_KEY = 'unraid-key';
    process.env.PAPERCLIP_AGENT_ID = 'agent-1';

    await runOnce();

    const args = getSpawnArgs();
    expect(args).toContain('TS_API_KEY=tskey-test');
    expect(args).toContain('HA_URL=http://ha:8123');
    expect(args).toContain('HA_TOKEN=ha-token-secret');
    expect(args).toContain('OLLAMA_URL=http://ollama:11434');
    expect(args).toContain('UNRAIDCLAW_API_KEY=unraid-key');
    expect(args).toContain('PAPERCLIP_AGENT_ID=agent-1');
  });

  it('does not forward vars that are unset', async () => {
    await runOnce();

    const args = getSpawnArgs();
    const joined = args.join(' ');
    for (const key of ALL_KEYS) {
      expect(joined).not.toContain(`${key}=`);
    }
  });

  it('does not forward vars that are empty strings', async () => {
    process.env.TS_API_KEY = '';
    process.env.HA_TOKEN = '';

    await runOnce();

    const args = getSpawnArgs();
    expect(args.join(' ')).not.toContain('TS_API_KEY=');
    expect(args.join(' ')).not.toContain('HA_TOKEN=');
  });

  it('forwards only the set subset, leaving unset vars absent', async () => {
    process.env.LITELLM_URL = 'http://litellm:4000';
    process.env.LITELLM_MASTER_KEY = 'sk-litellm-test';

    await runOnce();

    const args = getSpawnArgs();
    expect(args).toContain('LITELLM_URL=http://litellm:4000');
    expect(args).toContain('LITELLM_MASTER_KEY=sk-litellm-test');
    expect(args.join(' ')).not.toContain('TS_API_KEY=');
    expect(args.join(' ')).not.toContain('HA_URL=');
    expect(args.join(' ')).not.toContain('PAPERCLIP_URL=');
  });

  it('redacts secret values in container-runner debug logs', async () => {
    process.env.TS_API_KEY = 'tskey-supersecret';
    process.env.HA_TOKEN = 'ha-token-supersecret';
    process.env.LITELLM_MASTER_KEY = 'sk-litellm-supersecret';
    process.env.UNRAIDCLAW_API_KEY = 'unraid-supersecret';
    process.env.PAPERCLIP_AGENT_JWT_SECRET = 'jwt-supersecret';
    process.env.TS_API_CLIENT_SECRET = 'client-supersecret';
    // Non-secret URL — should NOT be redacted
    process.env.HA_URL = 'http://ha:8123';

    await runOnce();

    const debugCalls = vi.mocked(logger.debug).mock.calls;
    const containerCfgCall = debugCalls.find(
      (c) => c[1] === 'Container mount configuration',
    );
    expect(containerCfgCall).toBeDefined();
    const loggedArgs = (containerCfgCall![0] as { containerArgs: string })
      .containerArgs;

    expect(loggedArgs).not.toContain('tskey-supersecret');
    expect(loggedArgs).not.toContain('ha-token-supersecret');
    expect(loggedArgs).not.toContain('sk-litellm-supersecret');
    expect(loggedArgs).not.toContain('unraid-supersecret');
    expect(loggedArgs).not.toContain('jwt-supersecret');
    expect(loggedArgs).not.toContain('client-supersecret');
    expect(loggedArgs).toContain('TS_API_KEY=<redacted>');
    expect(loggedArgs).toContain('HA_TOKEN=<redacted>');
    expect(loggedArgs).toContain('HA_URL=http://ha:8123');
  });
});

describe('NANOCLAW_DOCKER_NETWORK', () => {
  const original = process.env.NANOCLAW_DOCKER_NETWORK;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (original !== undefined) {
      process.env.NANOCLAW_DOCKER_NETWORK = original;
    } else {
      delete process.env.NANOCLAW_DOCKER_NETWORK;
    }
  });

  function getSpawnArgs(): string[] {
    const call = vi.mocked(spawn).mock.calls[0];
    return call ? (call[1] as string[]) : [];
  }

  async function runOnce() {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  }

  it('passes --network when NANOCLAW_DOCKER_NETWORK is set', async () => {
    process.env.NANOCLAW_DOCKER_NETWORK = 'ai-local';

    await runOnce();

    const args = getSpawnArgs();
    const idx = args.indexOf('--network');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('ai-local');
  });

  it('omits --network when NANOCLAW_DOCKER_NETWORK is unset', async () => {
    delete process.env.NANOCLAW_DOCKER_NETWORK;

    await runOnce();

    const args = getSpawnArgs();
    expect(args).not.toContain('--network');
  });

  it('omits --network when NANOCLAW_DOCKER_NETWORK is empty/whitespace', async () => {
    process.env.NANOCLAW_DOCKER_NETWORK = '   ';

    await runOnce();

    const args = getSpawnArgs();
    expect(args).not.toContain('--network');
  });
});
