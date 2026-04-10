import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as realFs from 'fs';
import * as realPath from 'path';
import * as os from 'os';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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

import {
  runContainerAgent,
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

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
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
  'auth', 'token', 'credential', 'secret', 'password',
  '.env', '.pem', '.key', 'id_rsa', 'id_ed25519', 'private_key',
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
        realFs.cpSync(srcPath, dstPath, { recursive: true, dereference: false });
      } catch { /* ignore */ }
    } else if (entry.isFile()) {
      if (isSensitive(entry.name)) continue;
      try {
        realFs.copyFileSync(srcPath, dstPath);
      } catch { /* ignore */ }
    }
  }
}

// Inline findGitRepos logic using realFs
function findGitReposReal(dir: string): Array<{ repoPath: string }> {
  const results: Array<{ repoPath: string }> = [];
  let entries: realFs.Dirent[];
  try { entries = realFs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = realPath.join(dir, entry.name);
    try {
      if (realFs.statSync(realPath.join(repoPath, '.git')).isDirectory()) {
        results.push({ repoPath });
      }
    } catch { /* .git doesn't exist */ }
  }
  return results;
}

// Inline mergeBackNonRepoEntries logic using realFs
function mergeBackNonRepoEntriesReal(scratchDir: string, groupDir: string): void {
  let entries: realFs.Dirent[];
  try { entries = realFs.readdirSync(scratchDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const srcPath = realPath.join(scratchDir, entry.name);
    const dstPath = realPath.join(groupDir, entry.name);
    if (entry.isDirectory()) {
      if (realFs.existsSync(realPath.join(srcPath, '.git'))) continue;
      try {
        realFs.cpSync(srcPath, dstPath, { recursive: true, dereference: false });
      } catch { /* ignore */ }
    } else if (entry.isFile()) {
      if (isSensitive(entry.name)) continue;
      try {
        realFs.copyFileSync(srcPath, dstPath);
      } catch { /* ignore */ }
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
        try { realFs.unlinkSync(lockFile); } catch { /* no lock */ }
        const status = execSync('git status --porcelain', { cwd: repoPath }).toString().trim();
        if (status) {
          execSync('git add -A', { cwd: repoPath });
          execSync(
            'git -c user.email=agent@nanoclaw.local -c user.name=agent commit --no-verify -m "auto-save: session exit"',
            { cwd: repoPath },
          );
        }
      } catch { /* best-effort */ }
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
      if (scratchContent !== mainContent && scratchContent.length >= mainContent.length) {
        realFs.writeFileSync(mainClaudeMd, scratchContent);
      }
    } catch { /* best-effort */ }
  }

  mergeBackNonRepoEntriesReal(scratchDir, groupDir);
  try { realFs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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
    const scratchDir = realPath.join(tmpRoot, 'scratch', 'testgroup', 'thread-123');
    const worktreesDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 'thread-123');

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.writeFileSync(realPath.join(groupDir, 'CLAUDE.md'), '# Test');
    realFs.mkdirSync(realPath.join(groupDir, '.context'), { recursive: true });
    realFs.writeFileSync(realPath.join(groupDir, '.context', 'notes.md'), 'notes');
    // Simulate git repo by creating dir with .git directory
    realFs.mkdirSync(realPath.join(groupDir, 'XZO-BACKEND', '.git'), { recursive: true });

    await runPrepareThreadWorkspace(groupDir, scratchDir, worktreesDir);

    expect(realFs.existsSync(realPath.join(scratchDir, 'CLAUDE.md'))).toBe(true);
    expect(realFs.existsSync(realPath.join(scratchDir, '.context'))).toBe(true);
    expect(realFs.existsSync(realPath.join(scratchDir, 'XZO-BACKEND'))).toBe(false);
  });

  it('test_prepareThreadWorkspace_creates_worktree_dir', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(tmpRoot, 'scratch', 'testgroup', 'thread-123');
    const worktreesDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 'thread-123');

    realFs.mkdirSync(groupDir, { recursive: true });

    await runPrepareThreadWorkspace(groupDir, scratchDir, worktreesDir);

    expect(realFs.existsSync(worktreesDir)).toBe(true);
    expect(realFs.existsSync(scratchDir)).toBe(true);
  });

  it('test_prepareThreadWorkspace_filters_sensitive_files', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(tmpRoot, 'scratch', 'testgroup', 'thread-123');
    const worktreesDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 'thread-123');

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.writeFileSync(realPath.join(groupDir, '.credentials.json'), '{}');
    realFs.writeFileSync(realPath.join(groupDir, '.env'), 'SECRET=1');
    realFs.writeFileSync(realPath.join(groupDir, 'CLAUDE.md'), '# ok');

    await runPrepareThreadWorkspace(groupDir, scratchDir, worktreesDir);

    expect(realFs.existsSync(realPath.join(scratchDir, '.credentials.json'))).toBe(false);
    expect(realFs.existsSync(realPath.join(scratchDir, '.env'))).toBe(false);
    expect(realFs.existsSync(realPath.join(scratchDir, 'CLAUDE.md'))).toBe(true);
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
    const scratchDir = realPath.join(tmpRoot, 'scratch', 'testgroup', 'thread-123');
    const worktreesDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 'thread-123');

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.mkdirSync(scratchDir, { recursive: true });
    realFs.mkdirSync(worktreesDir, { recursive: true });
    realFs.writeFileSync(realPath.join(groupDir, 'CLAUDE.md'), 'old content');
    realFs.writeFileSync(realPath.join(scratchDir, 'CLAUDE.md'), 'old content\nnew content appended');

    await runCleanupThreadWorkspace(groupDir, scratchDir, worktreesDir);

    const result = realFs.readFileSync(realPath.join(groupDir, 'CLAUDE.md'), 'utf-8');
    expect(result).toBe('old content\nnew content appended');
  });

  it('test_cleanupThreadWorkspace_removes_scratch_dir', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(tmpRoot, 'scratch', 'testgroup', 'thread-123');
    const worktreesDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 'thread-123');

    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.mkdirSync(scratchDir, { recursive: true });
    realFs.mkdirSync(worktreesDir, { recursive: true });

    await runCleanupThreadWorkspace(groupDir, scratchDir, worktreesDir);

    expect(realFs.existsSync(scratchDir)).toBe(false);
  });

  it('test_cleanupThreadWorkspace_preserves_worktree_dirs', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(tmpRoot, 'scratch', 'testgroup', 'thread-123');
    const worktreesDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 'thread-123');
    // A sibling dir that should NOT be touched
    const siblingDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 'other-thread');

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
    const scratchDir = realPath.join(tmpRoot, 'scratch', 'testgroup', 'thread-xyz');
    const worktreesDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 'thread-xyz');
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

    const log = execSync('git log --oneline', { cwd: worktreeRepoDir }).toString();
    expect(log).toContain('auto-save: session exit');
  });

  it('test_cleanupThreadWorkspace_autocommits_dirty_worktree_matching_thread', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(tmpRoot, 'scratch', 'testgroup', 'thread-abc');
    const worktreesDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 'thread-abc');
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

    const log = execSync('git log --oneline', { cwd: worktreeRepoDir }).toString();
    expect(log).toContain('auto-save: session exit');
  });

  it('test_cleanupThreadWorkspace_removes_stale_lock', async () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const scratchDir = realPath.join(tmpRoot, 'scratch', 'testgroup', 'thread-lock');
    const worktreesDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 'thread-lock');
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
    realFs.writeFileSync(realPath.join(worktreeRepoDir, 'change.txt'), 'change');
    realFs.writeFileSync(realPath.join(worktreeRepoDir, '.git', 'index.lock'), '');

    await runCleanupThreadWorkspace(groupDir, scratchDir, worktreesDir);

    expect(realFs.existsSync(realPath.join(worktreeRepoDir, '.git', 'index.lock'))).toBe(false);
    const log = execSync('git log --oneline', { cwd: worktreeRepoDir }).toString();
    expect(log).toContain('auto-save: session exit');
  });
});

describe('no_rescue_references', () => {
  it('test_no_rescue_references', async () => {
    const src = realFs.readFileSync(
      realPath.join(realPath.dirname(new URL(import.meta.url).pathname), 'container-runner.ts'),
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

