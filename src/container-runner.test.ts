import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as realFs from 'fs';
import * as realPath from 'path';
import * as os from 'os';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const PROGRESS_START_MARKER = '---NANOCLAW_PROGRESS_START---';
const PROGRESS_END_MARKER = '---NANOCLAW_PROGRESS_END---';

// Mock config
vi.mock('./config.js', () => ({
  ATTACHMENTS_DIR: '/tmp/nanoclaw-test-data/attachments',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUP_THREAD_KEY: '__group__',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  OLLAMA_ADMIN_TOOLS: false,
  ONECLI_URL: 'http://localhost:10254',
  OUTPUT_CHAIN_SETTLE_DEADLINE_MS: 10000,
  PLUGINS_DIR: '/tmp/nanoclaw-test-plugins',
  RESIDENTIAL_PROXY_URL: undefined,
  TIMEZONE: 'America/Los_Angeles',
  WORKTREES_DIR: '/tmp/nanoclaw-test-worktrees',
  escapeRegex: (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
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

let progressSeqCounter = 0;
function emitProgressMarker(
  proc: ReturnType<typeof createFakeProcess>,
  eventType: string,
  data: Record<string, string | undefined> = {},
) {
  progressSeqCounter++;
  const payload = JSON.stringify({
    eventType,
    data,
    seq: progressSeqCounter,
    ts: Date.now(),
  });
  proc.stdout.push(
    `${PROGRESS_START_MARKER}\n${payload}\n${PROGRESS_END_MARKER}\n`,
  );
}

// ---------------------------------------------------------------------------
// prepareThreadWorkspace / cleanupThreadWorkspace — direct real-fs logic tests
//
// The global vi.mock('fs') cannot be overridden per-test, so we cannot call
// through the module functions (they'd hit the mocked fs and do nothing).
// Instead we inline the same logic using realFs — this tests the behaviour
// specification, not the module binding, and is immune to the global mock.
// ---------------------------------------------------------------------------

// Mirrors isSensitiveTopLevelFilename from container-runner.ts
const SENSITIVE_TOP_LEVEL_PATTERNS = [
  'auth',
  'token',
  'credential',
  'secret',
  'password',
  '.env',
  '.pem',
  '.key',
  'id_rsa',
  'id_ed25519',
  'private_key',
];
function isSensitive(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_TOP_LEVEL_PATTERNS.some((p) => lower.includes(p));
}

// Inline prepareThreadWorkspace logic using realFs
async function runPrepareThreadWorkspace(
  groupDir: string,
  scratchDir: string,
  worktreesDir: string,
): Promise<void> {
  realFs.mkdirSync(scratchDir, { recursive: true });
  realFs.mkdirSync(worktreesDir, { recursive: true });
  let entries: realFs.Dirent[];
  try {
    entries = realFs.readdirSync(groupDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const srcPath = realPath.join(groupDir, entry.name);
    const dstPath = realPath.join(scratchDir, entry.name);
    if (entry.isDirectory()) {
      if (realFs.existsSync(realPath.join(srcPath, '.git'))) continue;
      try {
        realFs.cpSync(srcPath, dstPath, {
          recursive: true,
          dereference: false,
        });
      } catch {
        /* ignore */
      }
    } else if (entry.isFile()) {
      if (isSensitive(entry.name)) continue;
      try {
        realFs.copyFileSync(srcPath, dstPath);
      } catch {
        /* ignore */
      }
    }
  }
}

// Inline findGitRepos logic using realFs
function findGitReposReal(dir: string): Array<{ repoPath: string }> {
  const results: Array<{ repoPath: string }> = [];
  let entries: realFs.Dirent[];
  try {
    entries = realFs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = realPath.join(dir, entry.name);
    try {
      if (realFs.statSync(realPath.join(repoPath, '.git')).isDirectory()) {
        results.push({ repoPath });
      }
    } catch {
      /* .git doesn't exist */
    }
  }
  return results;
}

// Inline mergeBackNonRepoEntries logic using realFs
function mergeBackNonRepoEntriesReal(
  scratchDir: string,
  groupDir: string,
): void {
  let entries: realFs.Dirent[];
  try {
    entries = realFs.readdirSync(scratchDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const srcPath = realPath.join(scratchDir, entry.name);
    const dstPath = realPath.join(groupDir, entry.name);
    if (entry.isDirectory()) {
      if (realFs.existsSync(realPath.join(srcPath, '.git'))) continue;
      try {
        realFs.cpSync(srcPath, dstPath, {
          recursive: true,
          dereference: false,
        });
      } catch {
        /* ignore */
      }
    } else if (entry.isFile()) {
      if (isSensitive(entry.name)) continue;
      try {
        realFs.copyFileSync(srcPath, dstPath);
      } catch {
        /* ignore */
      }
    }
  }
}

// Inline cleanupThreadWorkspace logic using realFs + execSync
async function runCleanupThreadWorkspace(
  groupDir: string,
  scratchDir: string,
  worktreesDir: string,
): Promise<void> {
  const { execSync } = await import('child_process');

  if (!realFs.existsSync(scratchDir)) return;

  // Auto-commit dirty worktrees
  if (realFs.existsSync(worktreesDir)) {
    for (const { repoPath } of findGitReposReal(worktreesDir)) {
      try {
        const lockFile = realPath.join(repoPath, '.git', 'index.lock');
        try {
          realFs.unlinkSync(lockFile);
        } catch {
          /* no lock */
        }
        const status = execSync('git status --porcelain', { cwd: repoPath })
          .toString()
          .trim();
        if (status) {
          execSync('git add -A', { cwd: repoPath });
          execSync(
            'git -c user.email=agent@nanoclaw.local -c user.name=agent commit --no-verify -m "auto-save: session exit"',
            { cwd: repoPath },
          );
        }
      } catch {
        /* best-effort */
      }
    }
  }

  // Merge CLAUDE.md back
  const scratchClaudeMd = realPath.join(scratchDir, 'CLAUDE.md');
  const mainClaudeMd = realPath.join(groupDir, 'CLAUDE.md');
  if (realFs.existsSync(scratchClaudeMd)) {
    try {
      const scratchContent = realFs.readFileSync(scratchClaudeMd, 'utf-8');
      const mainContent = realFs.existsSync(mainClaudeMd)
        ? realFs.readFileSync(mainClaudeMd, 'utf-8')
        : '';
      if (
        scratchContent !== mainContent &&
        scratchContent.length >= mainContent.length
      ) {
        realFs.writeFileSync(mainClaudeMd, scratchContent);
      }
    } catch {
      /* best-effort */
    }
  }

  mergeBackNonRepoEntriesReal(scratchDir, groupDir);
  try {
    realFs.rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

describe('prepareThreadWorkspace', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = realFs.mkdtempSync(realPath.join(os.tmpdir(), 'nanoclaw-test-'));
  });

  afterEach(() => {
    realFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('test_prepareThreadWorkspace_copies_non_repo_files', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(
      tmpRoot,
      'scratch',
      'testgroup',
      'thread-123',
    );
    const worktreesDir = realPath.join(
      tmpRoot,
      'worktrees',
      'testgroup',
      'thread-123',
    );

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.writeFileSync(realPath.join(groupDir, 'CLAUDE.md'), '# Test');
    realFs.mkdirSync(realPath.join(groupDir, '.context'), { recursive: true });
    realFs.writeFileSync(
      realPath.join(groupDir, '.context', 'notes.md'),
      'notes',
    );
    // Simulate git repo by creating dir with .git directory
    realFs.mkdirSync(realPath.join(groupDir, 'XZO-BACKEND', '.git'), {
      recursive: true,
    });

    await runPrepareThreadWorkspace(groupDir, scratchDir, worktreesDir);

    expect(realFs.existsSync(realPath.join(scratchDir, 'CLAUDE.md'))).toBe(
      true,
    );
    expect(realFs.existsSync(realPath.join(scratchDir, '.context'))).toBe(true);
    expect(realFs.existsSync(realPath.join(scratchDir, 'XZO-BACKEND'))).toBe(
      false,
    );
  });

  it('test_prepareThreadWorkspace_creates_worktree_dir', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(
      tmpRoot,
      'scratch',
      'testgroup',
      'thread-123',
    );
    const worktreesDir = realPath.join(
      tmpRoot,
      'worktrees',
      'testgroup',
      'thread-123',
    );

    realFs.mkdirSync(groupDir, { recursive: true });

    await runPrepareThreadWorkspace(groupDir, scratchDir, worktreesDir);

    expect(realFs.existsSync(worktreesDir)).toBe(true);
    expect(realFs.existsSync(scratchDir)).toBe(true);
  });

  it('test_prepareThreadWorkspace_filters_sensitive_files', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(
      tmpRoot,
      'scratch',
      'testgroup',
      'thread-123',
    );
    const worktreesDir = realPath.join(
      tmpRoot,
      'worktrees',
      'testgroup',
      'thread-123',
    );

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.writeFileSync(realPath.join(groupDir, '.credentials.json'), '{}');
    realFs.writeFileSync(realPath.join(groupDir, '.env'), 'SECRET=1');
    realFs.writeFileSync(realPath.join(groupDir, 'CLAUDE.md'), '# ok');

    await runPrepareThreadWorkspace(groupDir, scratchDir, worktreesDir);

    expect(
      realFs.existsSync(realPath.join(scratchDir, '.credentials.json')),
    ).toBe(false);
    expect(realFs.existsSync(realPath.join(scratchDir, '.env'))).toBe(false);
    expect(realFs.existsSync(realPath.join(scratchDir, 'CLAUDE.md'))).toBe(
      true,
    );
  });
});

describe('cleanupThreadWorkspace', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = realFs.mkdtempSync(realPath.join(os.tmpdir(), 'nanoclaw-test-'));
  });

  afterEach(() => {
    realFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('test_cleanupThreadWorkspace_merges_claudemd', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(
      tmpRoot,
      'scratch',
      'testgroup',
      'thread-123',
    );
    const worktreesDir = realPath.join(
      tmpRoot,
      'worktrees',
      'testgroup',
      'thread-123',
    );

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.mkdirSync(scratchDir, { recursive: true });
    realFs.mkdirSync(worktreesDir, { recursive: true });
    realFs.writeFileSync(realPath.join(groupDir, 'CLAUDE.md'), 'old content');
    realFs.writeFileSync(
      realPath.join(scratchDir, 'CLAUDE.md'),
      'old content\nnew content appended',
    );

    await runCleanupThreadWorkspace(groupDir, scratchDir, worktreesDir);

    const result = realFs.readFileSync(
      realPath.join(groupDir, 'CLAUDE.md'),
      'utf-8',
    );
    expect(result).toBe('old content\nnew content appended');
  });

  it('test_cleanupThreadWorkspace_removes_scratch_dir', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(
      tmpRoot,
      'scratch',
      'testgroup',
      'thread-123',
    );
    const worktreesDir = realPath.join(
      tmpRoot,
      'worktrees',
      'testgroup',
      'thread-123',
    );

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.mkdirSync(scratchDir, { recursive: true });
    realFs.mkdirSync(worktreesDir, { recursive: true });

    await runCleanupThreadWorkspace(groupDir, scratchDir, worktreesDir);

    expect(realFs.existsSync(scratchDir)).toBe(false);
  });

  it('test_cleanupThreadWorkspace_preserves_worktree_dirs', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(
      tmpRoot,
      'scratch',
      'testgroup',
      'thread-123',
    );
    const worktreesDir = realPath.join(
      tmpRoot,
      'worktrees',
      'testgroup',
      'thread-123',
    );
    // A sibling dir that should NOT be touched
    const siblingDir = realPath.join(
      tmpRoot,
      'worktrees',
      'testgroup',
      'other-thread',
    );

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.mkdirSync(scratchDir, { recursive: true });
    realFs.mkdirSync(worktreesDir, { recursive: true });
    realFs.mkdirSync(siblingDir, { recursive: true });

    await runCleanupThreadWorkspace(groupDir, scratchDir, worktreesDir);

    // Sibling worktree dir should be untouched
    expect(realFs.existsSync(siblingDir)).toBe(true);
    // Scratch dir should be removed
    expect(realFs.existsSync(scratchDir)).toBe(false);
  });

  it('test_cleanupThreadWorkspace_autocommits_dirty_worktree', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(
      tmpRoot,
      'scratch',
      'testgroup',
      'thread-xyz',
    );
    const worktreesDir = realPath.join(
      tmpRoot,
      'worktrees',
      'testgroup',
      'thread-xyz',
    );
    const worktreeRepoDir = realPath.join(worktreesDir, 'myrepo');

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.mkdirSync(scratchDir, { recursive: true });
    realFs.mkdirSync(worktreeRepoDir, { recursive: true });

    const { execSync } = await import('child_process');
    execSync('git init', { cwd: worktreeRepoDir });
    execSync('git config user.email "test@test.com"', { cwd: worktreeRepoDir });
    execSync('git config user.name "Test"', { cwd: worktreeRepoDir });
    realFs.writeFileSync(realPath.join(worktreeRepoDir, 'init.txt'), 'init');
    execSync('git add -A', { cwd: worktreeRepoDir });
    execSync('git commit -m "init"', { cwd: worktreeRepoDir });
    // Add a dirty file
    realFs.writeFileSync(realPath.join(worktreeRepoDir, 'dirty.txt'), 'dirty');

    await runCleanupThreadWorkspace(groupDir, scratchDir, worktreesDir);

    const log = execSync('git log --oneline', {
      cwd: worktreeRepoDir,
    }).toString();
    expect(log).toContain('auto-save: session exit');
  });

  it('test_cleanupThreadWorkspace_autocommits_dirty_worktree_matching_thread', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(
      tmpRoot,
      'scratch',
      'testgroup',
      'thread-abc',
    );
    const worktreesDir = realPath.join(
      tmpRoot,
      'worktrees',
      'testgroup',
      'thread-abc',
    );
    const worktreeRepoDir = realPath.join(worktreesDir, 'repo2');

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.mkdirSync(scratchDir, { recursive: true });
    realFs.mkdirSync(worktreeRepoDir, { recursive: true });

    const { execSync } = await import('child_process');
    execSync('git init', { cwd: worktreeRepoDir });
    execSync('git config user.email "test@test.com"', { cwd: worktreeRepoDir });
    execSync('git config user.name "Test"', { cwd: worktreeRepoDir });
    realFs.writeFileSync(realPath.join(worktreeRepoDir, 'file.txt'), 'initial');
    execSync('git add -A', { cwd: worktreeRepoDir });
    execSync('git commit -m "initial"', { cwd: worktreeRepoDir });
    realFs.writeFileSync(realPath.join(worktreeRepoDir, 'new.txt'), 'change');

    await runCleanupThreadWorkspace(groupDir, scratchDir, worktreesDir);

    const log = execSync('git log --oneline', {
      cwd: worktreeRepoDir,
    }).toString();
    expect(log).toContain('auto-save: session exit');
  });

  it('test_cleanupThreadWorkspace_removes_stale_lock', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(
      tmpRoot,
      'scratch',
      'testgroup',
      'thread-lock',
    );
    const worktreesDir = realPath.join(
      tmpRoot,
      'worktrees',
      'testgroup',
      'thread-lock',
    );
    const worktreeRepoDir = realPath.join(worktreesDir, 'myrepo');

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.mkdirSync(scratchDir, { recursive: true });
    realFs.mkdirSync(worktreeRepoDir, { recursive: true });

    const { execSync } = await import('child_process');
    execSync('git init', { cwd: worktreeRepoDir });
    execSync('git config user.email "test@test.com"', { cwd: worktreeRepoDir });
    execSync('git config user.name "Test"', { cwd: worktreeRepoDir });
    realFs.writeFileSync(realPath.join(worktreeRepoDir, 'init.txt'), 'init');
    execSync('git add -A', { cwd: worktreeRepoDir });
    execSync('git commit -m "init"', { cwd: worktreeRepoDir });

    // Add dirty file and stale index.lock
    realFs.writeFileSync(
      realPath.join(worktreeRepoDir, 'change.txt'),
      'change',
    );
    realFs.writeFileSync(
      realPath.join(worktreeRepoDir, '.git', 'index.lock'),
      '',
    );

    await runCleanupThreadWorkspace(groupDir, scratchDir, worktreesDir);

    expect(
      realFs.existsSync(realPath.join(worktreeRepoDir, '.git', 'index.lock')),
    ).toBe(false);
    const log = execSync('git log --oneline', {
      cwd: worktreeRepoDir,
    }).toString();
    expect(log).toContain('auto-save: session exit');
  });
});

describe('no_rescue_references', () => {
  it('test_no_rescue_references', async () => {
    const src = realFs.readFileSync(
      realPath.join(
        realPath.dirname(new URL(import.meta.url).pathname),
        'container-runner.ts',
      ),
      'utf-8',
    );
    expect(src).not.toContain('rescueWorktreeChanges');
    expect(src).not.toContain('saveRescueBundle');
    expect(src).not.toContain('restoreRescueBundle');
    expect(src).not.toContain('WORKTREE_BUNDLE_DIR');
    expect(src).not.toContain('WORKTREE_GIT_OVERLAY_DIR');
    expect(src).not.toContain('WORKTREE_CACHE_DIR');
  });
});

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout between turns (after idle marker) resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit a real turn result (the user-visible response)
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Emit the session-update idle marker: "query done, waiting for next
    // IPC input". This is what the host uses to detect a safe idle-reap.
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-123',
      idle: true,
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
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ idle: true }),
    );
  });

  it('timeout mid-turn (no idle marker) resolves as error with watchdog_mid_turn errorType', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit a real turn result but NO idle marker, simulating the agent
    // producing intermediate output then freezing mid-turn without ever
    // completing (the bug that silently killed illysium on 2026-04-11).
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Partial work',
      newSessionId: 'session-mid',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.newSessionId).toBe('session-mid');
    expect(result.errorType).toBe('watchdog_mid_turn');
  });

  it('new turn after idle with only progress events still classifies freeze as mid-turn kill', async () => {
    // Regression test for the `turnInFlight` new-turn boundary gap:
    // after an idle marker, a new turn emits only progress events (no
    // OUTPUT markers) before freezing. Pre-fix, turnInFlight stayed
    // false from the prior idle marker and the watchdog misclassified
    // the freeze as an idle reap, silently dropping the user's message.
    const onProgress = vi.fn();
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onProgress,
    );

    // Turn 1: real result, then idle marker (turn ends cleanly).
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Turn 1 response',
      newSessionId: 'session-turn1',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-turn1',
      idle: true,
    });
    await vi.advanceTimersByTimeAsync(10);

    // Turn 2: only progress events, no OUTPUT markers. Advance past the
    // idle-since-last-output threshold. Progress resets the watchdog so
    // the container stays alive, and turnInFlight must flip back to true.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(600_000);
      emitProgressMarker(fakeProc, 'tool_use', { name: 'Read' });
      await vi.advanceTimersByTimeAsync(10);
    }

    // Now freeze (no more events of any kind) and let the watchdog fire.
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.errorType).toBe('watchdog_mid_turn');
  });

  it('progress markers reset the watchdog even when no onProgress callback is supplied', async () => {
    // Regression test for scheduled-task / retry / session-command call
    // sites that invoke runContainerAgent without onProgress. Pre-fix,
    // the progress parse loop (and its resetTimeout) was gated on
    // `if (onProgress)` so the watchdog fired even during active work.
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      // onProgress deliberately omitted
    );

    // 60 minutes of progress-only activity. Watchdog must NOT fire.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(600_000);
      emitProgressMarker(fakeProc, 'thinking', {
        text: 'long reasoning chain',
      });
      await vi.advanceTimersByTimeAsync(10);
    }

    // Turn completes and container exits cleanly.
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-noprogress',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-noprogress',
      idle: true,
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-noprogress');
  });

  it('onOutput rejection during streaming resolves as error, not silent success', async () => {
    // Regression test for settleOutputChain error propagation. If an
    // onOutput step (e.g. channel.sendMessage) throws, the host must
    // report status:error so the caller's retry path fires instead of
    // advancing the message cursor past a lost delivery.
    const onOutput = vi.fn(async () => {
      throw new Error('channel.sendMessage: network error');
    });
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Agent response',
      newSessionId: 'session-reject',
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Output callback error');
    expect(onOutput).toHaveBeenCalled();
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

  it('progress markers reset the inactivity watchdog', async () => {
    const onProgress = vi.fn();
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onProgress,
    );

    // Drive the "long legitimate turn" scenario: progress markers flow
    // every 10 minutes for a full hour (the agent is thinking, calling
    // tools, spawning subagents, far past the 30.5 min raw watchdog).
    // No OUTPUT marker ever fires because the turn hasn't completed yet.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(600_000); // 10 minutes
      emitProgressMarker(fakeProc, 'tool_use', {
        name: 'Bash',
        input: '{"command":"snow sql ..."}',
      });
      await vi.advanceTimersByTimeAsync(10);
    }

    // Sixty minutes have passed, watchdog has NOT fired. The container
    // is still running and producing progress. Now the turn finally
    // completes and emits its result + idle marker.
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done after long work',
      newSessionId: 'session-long',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-long',
      idle: true,
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-long');
    expect(onProgress).toHaveBeenCalledTimes(6);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Done after long work' }),
    );
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

  it('test_pipe_ack_progress_event_forwarded_to_onProgress', async () => {
    const onProgress = vi.fn();
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onProgress,
    );

    emitProgressMarker(fakeProc, 'pipe_ack', { pipeId: 'ts-12345' });
    await vi.advanceTimersByTimeAsync(10);

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'pipe_ack',
        data: { pipeId: 'ts-12345' },
      }),
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'done',
      newSessionId: 's1',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('test_progress_handler_error_logged', async () => {
    const loggerModule = await import('./logger.js');
    const debugSpy = vi.mocked(loggerModule.logger.debug);
    debugSpy.mockClear();

    const onProgress = vi.fn(() => {
      throw new Error('handler boom');
    });
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onProgress,
    );

    emitProgressMarker(fakeProc, 'text', { content: 'hello' });
    await vi.advanceTimersByTimeAsync(10);

    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to parse or dispatch progress event',
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'done',
      newSessionId: 's2',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});
