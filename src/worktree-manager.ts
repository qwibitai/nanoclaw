/**
 * Worktree Manager — per-dispatch git worktree lifecycle.
 *
 * Creates an isolated git worktree for each Agency HQ dispatch so concurrent
 * tasks targeting the same repository do not share a working tree.
 *
 * Worktrees live under <projectRoot>/.claude/worktrees/ and are cleaned up
 * when the dispatch slot is freed or during startup reconciliation after a crash.
 *
 * Branch naming:  dispatch/<ahqTaskId[0..8]>
 * Worktree path:  <repoPath>/.claude/worktrees/dispatch-<ahqTaskId[0..8]>/
 *
 * Note: the git branch is NOT deleted on cleanup — it may be needed for a PR.
 * Only the working directory and git's internal worktree registration are removed.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const WORKTREES_SUBDIR = path.join('.claude', 'worktrees');

/** Returns the worktrees root directory for a given repository path. */
export function worktreesRoot(repoPath: string): string {
  return path.join(repoPath, WORKTREES_SUBDIR);
}

/**
 * Create a git worktree for an Agency HQ dispatch.
 *
 * Returns the absolute worktree path on success, or null if the repository
 * is not a git repo or worktree creation fails. Failure is non-fatal — the
 * dispatch proceeds without worktree isolation.
 */
export function createWorktree(
  repoPath: string,
  ahqTaskId: string,
): string | null {
  const shortId = ahqTaskId.slice(0, 8);
  const branchName = `dispatch/${shortId}`;
  const root = worktreesRoot(repoPath);
  const worktreePath = path.join(root, `dispatch-${shortId}`);

  try {
    // Verify repoPath is a git repository before attempting anything.
    execSync(`git -C "${repoPath}" rev-parse --git-dir`, { stdio: 'pipe' });

    fs.mkdirSync(root, { recursive: true });

    execSync(
      `git -C "${repoPath}" worktree add -b "${branchName}" "${worktreePath}"`,
      { stdio: 'pipe' },
    );

    logger.info({ ahqTaskId, branchName, worktreePath }, '[worktree] created');
    return worktreePath;
  } catch (err) {
    logger.warn(
      { err, ahqTaskId, repoPath },
      '[worktree] create failed, proceeding without worktree',
    );
    return null;
  }
}

/**
 * Remove a git worktree directory and deregister it from git.
 *
 * The associated branch is NOT deleted so it remains available for PR review.
 * Best-effort: logs warnings but does not throw on failure.
 */
export function removeWorktree(repoPath: string, worktreePath: string): void {
  try {
    execSync(`git -C "${repoPath}" worktree remove --force "${worktreePath}"`, {
      stdio: 'pipe',
    });
    logger.info({ worktreePath }, '[worktree] removed');
  } catch (removeErr) {
    logger.warn(
      { removeErr, worktreePath },
      '[worktree] remove failed, attempting manual cleanup',
    );
    // Manual fallback: delete the directory then prune git's internal tracking.
    try {
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      execSync(`git -C "${repoPath}" worktree prune`, { stdio: 'pipe' });
    } catch (fallbackErr) {
      logger.warn(
        { fallbackErr, worktreePath },
        '[worktree] manual cleanup also failed',
      );
    }
  }
}

/**
 * Clean up a list of orphaned worktree paths from crash recovery.
 *
 * Called during startup reconciliation after stale slots are freed.
 * Removes each path that still exists on disk, then prunes git metadata.
 */
export function cleanupOrphanedWorktrees(
  repoPath: string,
  worktreePaths: (string | null)[],
): void {
  let cleaned = 0;
  for (const wt of worktreePaths) {
    if (wt && fs.existsSync(wt)) {
      removeWorktree(repoPath, wt);
      cleaned++;
    }
  }

  // Prune stale git metadata regardless of whether we removed anything.
  try {
    execSync(`git -C "${repoPath}" worktree prune`, { stdio: 'pipe' });
  } catch {
    // Best effort — not a git repo or git not available.
  }

  if (cleaned > 0) {
    logger.info({ repoPath, cleaned }, '[worktree] orphan cleanup complete');
  }
}
