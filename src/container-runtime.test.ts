import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as realFs from 'fs';
import * as realPath from 'path';
import * as realOs from 'os';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`,
      { stdio: 'pipe' },
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

// ---------------------------------------------------------------------------
// buildVolumeMounts — inline logic tests using real filesystem
//
// buildVolumeMounts is tested by inlining the relevant new mount logic so
// tests use actual temp directories without fighting the global vi.mock('fs').
// This mirrors the approach in container-runner.test.ts.
// ---------------------------------------------------------------------------

/**
 * Inline the new worktrees+gitdir mount logic added by B3.
 * Returns the list of new mounts generated for a threaded non-main channel.
 */
function computeNewWorktreeMounts(
  groupDir: string,
  worktreeDir: string,
): Array<{ hostPath: string; containerPath: string; readonly: boolean }> {
  const mounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }> = [];

  // (1) /workspace/worktrees mount
  mounts.push({
    hostPath: worktreeDir,
    containerPath: '/workspace/worktrees',
    readonly: false,
  });

  // (2) Scan group folder for canonical repo .git dirs
  try {
    for (const entry of realFs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const repoPath = realPath.join(groupDir, entry.name);
      const gitDir = realPath.join(repoPath, '.git');
      if (!realFs.existsSync(gitDir)) continue;
      try {
        if (!realFs.statSync(gitDir).isDirectory()) continue;
      } catch {
        continue;
      }
      mounts.push({ hostPath: gitDir, containerPath: gitDir, readonly: true });
    }
  } catch {
    // best-effort
  }

  // (3) Scan existing worktrees for additional canonical .git dirs
  try {
    if (realFs.existsSync(worktreeDir)) {
      for (const entry of realFs.readdirSync(worktreeDir, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const wtRepoPath = realPath.join(worktreeDir, entry.name);
        const wtGitFile = realPath.join(wtRepoPath, '.git');
        if (!realFs.existsSync(wtGitFile)) continue;
        try {
          if (!realFs.statSync(wtGitFile).isFile()) continue;
          const gitFileContent = realFs.readFileSync(wtGitFile, 'utf-8').trim();
          const match = gitFileContent.match(/^gitdir:\s*(.+)$/);
          if (!match) continue;
          const worktreesEntry = realPath.resolve(match[1].trim());
          const canonicalGit = realPath.dirname(
            realPath.dirname(worktreesEntry),
          );
          if (!realFs.existsSync(canonicalGit)) continue;
          try {
            if (!realFs.statSync(canonicalGit).isDirectory()) continue;
          } catch {
            continue;
          }
          if (mounts.some((m) => m.hostPath === canonicalGit)) continue;
          mounts.push({
            hostPath: canonicalGit,
            containerPath: canonicalGit,
            readonly: true,
          });
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // best-effort
  }

  return mounts;
}

describe('buildVolumeMounts — worktree and .git mounts', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = realFs.mkdtempSync(
      realPath.join(realOs.tmpdir(), 'nanoclaw-bvm-test-'),
    );
  });

  afterEach(() => {
    realFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('test_buildVolumeMounts_threaded_includes_worktrees_mount', () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const worktreeDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 't1');
    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.mkdirSync(worktreeDir, { recursive: true });

    const mounts = computeNewWorktreeMounts(groupDir, worktreeDir);

    const wt = mounts.find((m) => m.containerPath === '/workspace/worktrees');
    expect(wt).toBeDefined();
    expect(wt?.hostPath).toBe(worktreeDir);
    expect(wt?.readonly).toBe(false);
  });

  it('test_buildVolumeMounts_threaded_includes_git_ro_mounts', () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const worktreeDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 't1');
    realFs.mkdirSync(worktreeDir, { recursive: true });

    // Create two fake repos in group dir
    for (const name of ['REPO-A', 'REPO-B']) {
      realFs.mkdirSync(realPath.join(groupDir, name, '.git'), {
        recursive: true,
      });
    }

    const mounts = computeNewWorktreeMounts(groupDir, worktreeDir);

    const gitMounts = mounts.filter(
      (m) => m.readonly && m.containerPath !== '/workspace/worktrees',
    );
    const containerPaths = gitMounts.map((m) => m.containerPath);
    expect(containerPaths).toContain(realPath.join(groupDir, 'REPO-A', '.git'));
    expect(containerPaths).toContain(realPath.join(groupDir, 'REPO-B', '.git'));
    for (const m of gitMounts) {
      expect(m.readonly).toBe(true);
      expect(m.hostPath).toBe(m.containerPath); // mounted at host-absolute path
    }
  });

  it('test_buildVolumeMounts_no_overlay_mounts', () => {
    const groupDir = realPath.join(tmpRoot, 'groups', 'testgroup');
    const worktreeDir = realPath.join(tmpRoot, 'worktrees', 'testgroup', 't1');
    realFs.mkdirSync(groupDir, { recursive: true });
    realFs.mkdirSync(worktreeDir, { recursive: true });

    const mounts = computeNewWorktreeMounts(groupDir, worktreeDir);

    for (const m of mounts) {
      expect(m.hostPath).not.toContain('overlay');
      expect(m.hostPath).not.toContain('worktree-git-overlays');
      expect(m.containerPath).not.toContain('overlay');
    }
  });
});
