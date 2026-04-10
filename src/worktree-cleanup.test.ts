import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as realFs from 'fs';
import * as realPath from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Hoist mutable state so mock factories can reference it
// ---------------------------------------------------------------------------

const mockDirs = vi.hoisted(() => ({
  WORKTREES_DIR: '/tmp/wt-cleanup-test/worktrees',
  GROUPS_DIR: '/tmp/wt-cleanup-test/groups',
}));

// Intercept child_process.execSync. Per-test behavior set via execOverrides.
const execOverrides = vi.hoisted(
  () =>
    ({
      fn: null as null | ((cmd: string, cwd: string) => string),
    }),
);

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (cmd: unknown, opts?: { cwd?: string; encoding?: string; stdio?: unknown }) => {
      const override = execOverrides.fn;
      if (override && typeof cmd === 'string') {
        return override(cmd, opts?.cwd ?? '');
      }
      return (actual.execSync as Function)(cmd, opts);
    },
    execFileSync: (file: unknown, args?: unknown, opts?: { cwd?: string; encoding?: string; stdio?: unknown }) => {
      const override = execOverrides.fn;
      if (override && typeof file === 'string' && Array.isArray(args)) {
        return override(`${file} ${args.join(' ')}`, opts?.cwd ?? '');
      }
      return (actual.execFileSync as Function)(file, args, opts);
    },
  };
});

vi.mock('./config.js', () => ({
  get WORKTREES_DIR() {
    return mockDirs.WORKTREES_DIR;
  },
  get GROUPS_DIR() {
    return mockDirs.GROUPS_DIR;
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// withGroupMutex: execute fn directly (no actual mutex needed in tests)
vi.mock('./container-runner.js', () => ({
  withGroupMutex: <T>(_group: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks are registered
// ---------------------------------------------------------------------------

import { logger } from './logger.js';

// We import the internal runCleanup by re-exporting it for testing.
// Since startWorktreeCleanup only wires timers, we test the cleanup logic
// directly by calling startWorktreeCleanup with vi.useFakeTimers() OR
// by testing the behavior through the module's exported function.
// We use a module-level dynamic import to trigger cleanup inline.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot(): string {
  return realFs.mkdtempSync(realPath.join(os.tmpdir(), 'wt-cleanup-'));
}

function makeWorktreeDir(base: string, group: string, threadId: string, repo: string): string {
  const p = realPath.join(base, group, threadId, repo);
  realFs.mkdirSync(p, { recursive: true });
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worktree-cleanup', () => {
  let tmpRoot: string;
  let worktreesDir: string;
  let groupsDir: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
    worktreesDir = realPath.join(tmpRoot, 'worktrees');
    groupsDir = realPath.join(tmpRoot, 'groups');
    realFs.mkdirSync(worktreesDir, { recursive: true });
    realFs.mkdirSync(groupsDir, { recursive: true });
    mockDirs.WORKTREES_DIR = worktreesDir;
    mockDirs.GROUPS_DIR = groupsDir;
    execOverrides.fn = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    realFs.rmSync(tmpRoot, { recursive: true, force: true });
    execOverrides.fn = null;
  });

  // Helper: dynamically re-execute cleanup by importing and using fake timers
  async function runCleanupOnce(): Promise<void> {
    vi.useFakeTimers();
    // Re-import to get fresh module state with updated mockDirs
    const mod = await import('./worktree-cleanup.js?ts=' + Date.now());
    mod.startWorktreeCleanup();
    // Advance past the 60s initial delay
    await vi.advanceTimersByTimeAsync(61_000);
    vi.useRealTimers();
  }

  it('test_cleanup_skips_dirty_worktree: does not remove a dirty worktree even if PR is merged', async () => {
    const worktreePath = makeWorktreeDir(worktreesDir, 'group1', 'thread1', 'myrepo');
    const canonicalRepoPath = realPath.join(groupsDir, 'group1', 'myrepo');
    realFs.mkdirSync(canonicalRepoPath, { recursive: true });

    let worktreeRemoveCalled = false;

    execOverrides.fn = (cmd: string, _cwd: string) => {
      if (cmd.includes('git status --porcelain')) {
        // Non-empty = dirty
        return 'M some-file.ts\n';
      }
      if (cmd.includes('git worktree remove')) {
        worktreeRemoveCalled = true;
        return '';
      }
      if (cmd.includes('git worktree prune')) {
        return '';
      }
      if (cmd.includes('gh pr list')) {
        return '[{"number":42}]';
      }
      return '';
    };

    await runCleanupOnce();

    expect(worktreeRemoveCalled).toBe(false);
    // Worktree directory should still exist
    expect(realFs.existsSync(worktreePath)).toBe(true);
  });

  it('test_cleanup_removes_merged_clean_worktree: removes a clean, fully-pushed worktree with merged PR', async () => {
    const worktreePath = makeWorktreeDir(worktreesDir, 'group2', 'thread2', 'repo2');
    const canonicalRepoPath = realPath.join(groupsDir, 'group2', 'repo2');
    realFs.mkdirSync(canonicalRepoPath, { recursive: true });

    let worktreeRemoveCalled = false;
    let pruneCalled = false;

    execOverrides.fn = (cmd: string, _cwd: string) => {
      if (cmd.includes('git status --porcelain')) {
        return ''; // clean
      }
      if (cmd.includes('git log HEAD --not --remotes')) {
        return ''; // no unpushed commits
      }
      if (cmd.includes('git rev-parse --abbrev-ref HEAD')) {
        return 'feature/my-branch';
      }
      if (cmd.includes('gh pr list')) {
        return '[{"number":99}]'; // merged PR found
      }
      if (cmd.includes('git worktree remove')) {
        worktreeRemoveCalled = true;
        // Actually remove the directory to simulate the git command
        realFs.rmSync(worktreePath, { recursive: true, force: true });
        return '';
      }
      if (cmd.includes('git worktree prune')) {
        pruneCalled = true;
        return '';
      }
      return '';
    };

    await runCleanupOnce();

    expect(worktreeRemoveCalled).toBe(true);
    expect(pruneCalled).toBe(true);
  });

  it('test_cleanup_skips_unpushed: does not remove a worktree with local-only commits', async () => {
    const worktreePath = makeWorktreeDir(worktreesDir, 'group3', 'thread3', 'repo3');

    let worktreeRemoveCalled = false;

    execOverrides.fn = (cmd: string, _cwd: string) => {
      if (cmd.includes('git status --porcelain')) {
        return ''; // clean working tree
      }
      if (cmd.includes('git log HEAD --not --remotes')) {
        return 'abc1234 local commit not pushed'; // unpushed commits
      }
      if (cmd.includes('git worktree remove')) {
        worktreeRemoveCalled = true;
        return '';
      }
      return '';
    };

    await runCleanupOnce();

    expect(worktreeRemoveCalled).toBe(false);
    expect(realFs.existsSync(worktreePath)).toBe(true);
  });

  it('test_cleanup_warns_stale: logs warning for stale worktree without removing it', async () => {
    const worktreePath = makeWorktreeDir(worktreesDir, 'group4', 'thread4', 'repo4');

    // Set mtime to 35 days ago
    const staleTime = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    realFs.utimesSync(worktreePath, staleTime, staleTime);

    let worktreeRemoveCalled = false;

    execOverrides.fn = (cmd: string, _cwd: string) => {
      if (cmd.includes('git status --porcelain')) {
        return ''; // clean
      }
      if (cmd.includes('git log HEAD --not --remotes')) {
        return ''; // no unpushed commits
      }
      if (cmd.includes('git rev-parse --abbrev-ref HEAD')) {
        return 'feature/stale-branch';
      }
      if (cmd.includes('gh pr list')) {
        return '[]'; // no merged PR
      }
      if (cmd.includes('git ls-remote --heads origin')) {
        return 'abc123\trefs/heads/feature/stale-branch'; // branch still exists on remote
      }
      if (cmd.includes('git worktree remove')) {
        worktreeRemoveCalled = true;
        return '';
      }
      return '';
    };

    await runCleanupOnce();

    expect(worktreeRemoveCalled).toBe(false);
    expect(realFs.existsSync(worktreePath)).toBe(true);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ ageDays: expect.any(Number) }),
      expect.stringContaining('stale worktree'),
    );
  });
});
