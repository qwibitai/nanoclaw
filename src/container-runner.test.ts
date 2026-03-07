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

// Mock os
vi.mock('os', () => ({
  default: { homedir: vi.fn(() => '/home/testuser') },
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

import fs from 'fs';
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
});

// Helper: collect everything written to stdin before the container closes
async function captureStdinPayload(
  group: RegisteredGroup,
  input: Parameters<typeof runContainerAgent>[1],
): Promise<Record<string, unknown>> {
  let stdinData = '';
  fakeProc.stdin.on('data', (chunk: Buffer) => {
    stdinData += chunk.toString();
  });

  const resultPromise = runContainerAgent(group, { ...input }, () => {});
  fakeProc.emit('close', 0);
  await resultPromise;

  return JSON.parse(stdinData);
}

describe('readSecrets — OAuth token resolution', () => {
  const credPath = '/home/testuser/.claude/.credentials.json';
  const futureExpiry = Date.now() + 3600_000;
  const pastExpiry = Date.now() - 3600_000;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    // Default: no .env content, no credentials file
    vi.mocked(fs.readFileSync).mockReturnValue('');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses token from credentials.json when .env has a stale token', async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath).endsWith('.env')) return 'CLAUDE_CODE_OAUTH_TOKEN=stale-token';
      if (String(filePath) === credPath)
        return JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-token', expiresAt: futureExpiry } });
      return '';
    });

    const payload = await captureStdinPayload(testGroup, testInput);
    expect(payload.secrets).toEqual(expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: 'fresh-token' }));
  });

  it('falls back to .env when credentials.json is missing', async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath).endsWith('.env')) return 'CLAUDE_CODE_OAUTH_TOKEN=env-token';
      if (String(filePath) === credPath) throw new Error('ENOENT');
      return '';
    });

    const payload = await captureStdinPayload(testGroup, testInput);
    expect(payload.secrets).toEqual(expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: 'env-token' }));
  });

  it('falls back to .env when credentials.json token is expired', async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath).endsWith('.env')) return 'CLAUDE_CODE_OAUTH_TOKEN=env-token';
      if (String(filePath) === credPath)
        return JSON.stringify({ claudeAiOauth: { accessToken: 'expired-token', expiresAt: pastExpiry } });
      return '';
    });

    const payload = await captureStdinPayload(testGroup, testInput);
    expect(payload.secrets).toEqual(expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: 'env-token' }));
  });

  it('skips credentials.json entirely when ANTHROPIC_API_KEY is set', async () => {
    const credReadSpy = vi.fn();
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath).endsWith('.env')) return 'ANTHROPIC_API_KEY=sk-ant-key';
      if (String(filePath) === credPath) { credReadSpy(); return '{}'; }
      return '';
    });

    await captureStdinPayload(testGroup, testInput);
    expect(credReadSpy).not.toHaveBeenCalled();
  });
});
