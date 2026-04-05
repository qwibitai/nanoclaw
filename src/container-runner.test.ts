import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'Asia/Shanghai',
  ONECLI_URL: 'http://localhost:10254',
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
      existsSync: vi.fn(() => true),
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

// Mock env
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/nanoclaw-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}`,
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    getContainerConfig = vi.fn().mockResolvedValue({
      env: {
        HTTPS_PROXY: 'http://x:token@localhost:10255',
        NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem',
        NODE_USE_ENV_PROXY: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      },
      caCertificate: 'mock-cert',
    });
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    ensureAgent = vi.fn().mockResolvedValue({ id: 'test', created: false });
  },
}));

// Mock db
vi.mock('./db.js', () => ({
  getRotateEnabled: vi.fn(() => false),
  getRotateIndex: vi.fn(() => 0),
  getLastRotateAt: vi.fn(() => null),
  setRotateIndex: vi.fn(),
  setLastRotateAt: vi.fn(),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    unref: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  proc.unref = vi.fn();
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
    execFileSync: vi.fn(() => ''),
    execSync: vi.fn(() => '[]'),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  parseEnvOutput,
  checkAgentRunnerDist,
  resolveWorkspacePaths,
  prepareGroupSession,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import fs from 'fs';
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

describe('agent spawn and timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns node child process and writes workspacePaths', async () => {
    // Capture stdin writes
    const chunks: Buffer[] = [];
    const origWrite = fakeProc.stdin.write.bind(fakeProc.stdin);
    fakeProc.stdin.write = ((chunk: any, ...args: any[]) => {
      if (Buffer.isBuffer(chunk) || typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      }
      return origWrite(chunk, ...args);
    }) as any;

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(),
    );

    // Let async buildLocalEnv settle
    await vi.advanceTimersByTimeAsync(10);

    // Verify spawn was called with node (not docker)
    expect(spawn).toHaveBeenCalledWith(
      'node',
      [expect.stringContaining('agent-runner/dist/index.js')],
      expect.objectContaining({
        detached: true,
        cwd: expect.stringContaining('test-group'),
      }),
    );

    // Verify stdin contains workspacePaths
    const written = Buffer.concat(chunks).toString();
    if (written) {
      const parsed = JSON.parse(written);
      expect(parsed.workspacePaths).toBeDefined();
      expect(parsed.workspacePaths.group).toContain('test-group');
      expect(parsed.workspacePaths.ipc).toContain('test-group');
    }

    // Clean up
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
  });

  it('normal exit after output resolves as success', async () => {
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
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('parseEnvOutput', () => {
  it('parses KEY=VALUE format', () => {
    expect(parseEnvOutput('FOO=bar\nBAZ=qux')).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('handles values containing =', () => {
    expect(parseEnvOutput('KEY=a=b=c')).toEqual({ KEY: 'a=b=c' });
  });

  it('skips empty lines', () => {
    expect(parseEnvOutput('A=1\n\nB=2\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('checkAgentRunnerDist', () => {
  it('does not throw when dist exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(() => checkAgentRunnerDist()).not.toThrow();
  });

  it('throws with build:agent hint when dist missing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(() => checkAgentRunnerDist()).toThrow(/build:agent/);
    vi.mocked(fs.existsSync).mockReturnValue(true); // restore
  });
});

describe('resolveWorkspacePaths', () => {
  it('main group includes project path', () => {
    const p = resolveWorkspacePaths(testGroup, true);
    expect(p.project).toBeDefined();
    expect(p.group).toContain('test-group');
    expect(p.ipc).toContain('test-group');
  });

  it('non-main group excludes project', () => {
    const p = resolveWorkspacePaths(testGroup, false);
    expect(p.project).toBeUndefined();
  });

  it('all paths are absolute', () => {
    const p = resolveWorkspacePaths(testGroup, true);
    for (const val of Object.values(p)) {
      if (val) expect(val).toMatch(/^\//);
    }
  });

  it('global points to groups/global', () => {
    const p = resolveWorkspacePaths(testGroup, true);
    expect(p.global).toMatch(/groups\/global$/);
  });
});

describe('prepareGroupSession', () => {
  it('returns different paths for different groups', () => {
    const a = prepareGroupSession('group-a');
    const b = prepareGroupSession('group-b');
    expect(a).toContain('group-a');
    expect(b).toContain('group-b');
    expect(a).not.toBe(b);
  });

  it('path ends with .claude', () => {
    const dir = prepareGroupSession('main');
    expect(dir).toMatch(/sessions\/main\/\.claude$/);
  });
});
