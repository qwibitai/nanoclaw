/**
 * Worktree Manager for Sovereign
 * Creates isolated per-task git worktrees for delegated work.
 * Each worker gets its own checkout — no cross-task interference.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface WorktreeInfo {
  path: string;
  branch: string;
  taskId: string;
}

/**
 * Create a git worktree for a delegated task.
 * Returns the absolute path to the worktree directory.
 *
 * @param repoDir - Path to the main git repo
 * @param taskId - Unique task identifier (used for branch + directory naming)
 * @param baseBranch - Branch to base the worktree on (default: HEAD)
 */
export function createWorktree(
  repoDir: string,
  taskId: string,
  baseBranch?: string,
): WorktreeInfo {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const branch = `worker/${sanitized}`;
  const worktreeDir = path.join(repoDir, '.worktrees', sanitized);

  // Ensure parent exists
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

  // Create worktree with a new branch from base
  const base = baseBranch || 'HEAD';
  execSync(`git worktree add -b "${branch}" "${worktreeDir}" "${base}"`, {
    cwd: repoDir,
    stdio: 'pipe',
  });

  return { path: worktreeDir, branch, taskId };
}

/**
 * Remove a worktree and its branch after task completion.
 */
export function removeWorktree(repoDir: string, taskId: string): boolean {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const worktreeDir = path.join(repoDir, '.worktrees', sanitized);
  const branch = `worker/${sanitized}`;

  if (!fs.existsSync(worktreeDir)) {
    return false;
  }

  // Remove worktree
  execSync(`git worktree remove "${worktreeDir}" --force`, {
    cwd: repoDir,
    stdio: 'pipe',
  });

  // Delete the branch (ignore errors if already deleted)
  try {
    execSync(`git branch -D "${branch}"`, {
      cwd: repoDir,
      stdio: 'pipe',
    });
  } catch {
    // Branch may already be gone
  }

  return true;
}

/**
 * List all active worktrees for the repo.
 */
export function listWorktrees(repoDir: string): WorktreeInfo[] {
  const worktreesDir = path.join(repoDir, '.worktrees');
  if (!fs.existsSync(worktreesDir)) {
    return [];
  }

  const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
  const results: WorktreeInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const wtPath = path.join(worktreesDir, entry.name);

    // Read the branch from git
    let branch: string;
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: wtPath,
        stdio: 'pipe',
        encoding: 'utf-8',
      }).trim();
    } catch {
      // Worktree may be corrupt — skip
      continue;
    }

    results.push({
      path: wtPath,
      branch,
      taskId: entry.name,
    });
  }

  return results;
}

/**
 * Clean up stale worktrees that no longer have a valid git checkout.
 * Returns the number of worktrees cleaned.
 */
export function pruneWorktrees(repoDir: string): number {
  try {
    execSync('git worktree prune', {
      cwd: repoDir,
      stdio: 'pipe',
    });
  } catch {
    return 0;
  }

  // Also remove empty directories left behind in .worktrees/
  const worktreesDir = path.join(repoDir, '.worktrees');
  if (!fs.existsSync(worktreesDir)) return 0;

  let cleaned = 0;
  for (const entry of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const wtPath = path.join(worktreesDir, entry.name);
    // Valid worktrees have a .git file (not directory) pointing to the main repo.
    // If it's missing, the worktree is stale.
    const gitFile = path.join(wtPath, '.git');
    if (!fs.existsSync(gitFile)) {
      fs.rmSync(wtPath, { recursive: true, force: true });
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Check if a path is inside a git repo.
 */
export function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: dir,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}
