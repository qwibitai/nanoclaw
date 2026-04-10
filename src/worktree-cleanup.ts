import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, WORKTREES_DIR } from './config.js';
import { withGroupMutex } from './container-runner.js';
import { logger } from './logger.js';

const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const STALE_WARNING_DAYS = 30;

function execSafe(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function isDirty(worktreePath: string): boolean | null {
  const out = execSafe('git status --porcelain', worktreePath);
  if (out === null) return null; // git command failed — unknown state
  return out.length > 0;
}

function hasUnpushedCommits(worktreePath: string): boolean | null {
  const out = execSafe('git log HEAD --not --remotes --oneline', worktreePath);
  if (out === null) return null; // git command failed — unknown state
  return out.length > 0;
}

function getBranchName(worktreePath: string): string | null {
  return execSafe('git rev-parse --abbrev-ref HEAD', worktreePath);
}

function isPRMerged(branch: string, worktreePath: string): boolean {
  const out = execSafe(
    `gh pr list --head ${branch} --state merged --json number --limit 1`,
    worktreePath,
  );
  if (out === null) return false;
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function isBranchDeletedOnRemote(branch: string, worktreePath: string): boolean {
  // If the remote tracking branch no longer exists, the branch was deleted
  const out = execSafe(`git ls-remote --heads origin ${branch}`, worktreePath);
  return out !== null && out.length === 0;
}

function getLastModifiedDays(worktreePath: string): number {
  try {
    const stat = fs.statSync(worktreePath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs / (1000 * 60 * 60 * 24);
  } catch {
    return 0;
  }
}

function removeWorktree(canonicalRepoPath: string, worktreePath: string): void {
  execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: canonicalRepoPath,
    stdio: 'pipe',
  });
  execFileSync('git', ['worktree', 'prune'], { cwd: canonicalRepoPath, stdio: 'pipe' });
}

async function cleanupGroupWorktrees(group: string): Promise<void> {
  const groupWorktreesDir = path.join(WORKTREES_DIR, group);
  if (!fs.existsSync(groupWorktreesDir)) return;

  let threadDirs: string[];
  try {
    threadDirs = fs.readdirSync(groupWorktreesDir);
  } catch {
    return;
  }

  for (const threadId of threadDirs) {
    const threadPath = path.join(groupWorktreesDir, threadId);
    let repoDirs: string[];
    try {
      repoDirs = fs.readdirSync(threadPath);
    } catch {
      continue;
    }

    for (const repo of repoDirs) {
      const worktreePath = path.join(threadPath, repo);
      // Canonical repo lives in the group's groups dir
      const canonicalRepoPath = path.join(GROUPS_DIR, group, repo);

      await withGroupMutex(group, async () => {
        try {
          // SF-1: Distinguish git failure from actual dirty/unpushed state
          const dirtyResult = isDirty(worktreePath);
          if (dirtyResult === null) {
            logger.warn({ group, threadId, repo }, 'Worktree cleanup: git status failed — skipping (possible corrupt worktree)');
            return;
          }
          if (dirtyResult) {
            logger.debug({ group, threadId, repo }, 'Worktree cleanup: skipping dirty worktree');
            return;
          }

          // SF-3: Check for detached HEAD before checking unpushed commits
          // (detached HEAD causes git log --not --remotes to fail/return misleading results)
          const branch = getBranchName(worktreePath);
          if (!branch || branch === 'HEAD') {
            logger.debug(
              { group, threadId, repo },
              'Worktree cleanup: skipping detached HEAD worktree',
            );
            return;
          }

          const unpushedResult = hasUnpushedCommits(worktreePath);
          if (unpushedResult === null) {
            logger.warn({ group, threadId, repo }, 'Worktree cleanup: git log failed — skipping (possible corrupt worktree)');
            return;
          }
          if (unpushedResult) {
            logger.debug(
              { group, threadId, repo },
              'Worktree cleanup: skipping worktree with unpushed commits',
            );
            return;
          }

          const merged = isPRMerged(branch, worktreePath);
          const branchGone = isBranchDeletedOnRemote(branch, worktreePath);

          if (merged || branchGone) {
            logger.info(
              { group, threadId, repo, branch, merged, branchGone },
              'Worktree cleanup: removing worktree (PR merged or branch deleted)',
            );
            removeWorktree(canonicalRepoPath, worktreePath);
            return;
          }

          const ageDays = getLastModifiedDays(worktreePath);
          if (ageDays > STALE_WARNING_DAYS) {
            logger.warn(
              { group, threadId, repo, branch, ageDays: Math.round(ageDays) },
              'Worktree cleanup: stale worktree (>30 days, no merged PR)',
            );
          }
        } catch (err) {
          logger.error({ err, group, threadId, repo }, 'Worktree cleanup: error processing worktree');
        }
      });
    }

    // Remove empty thread directory after processing all repos
    try {
      const remaining = fs.readdirSync(threadPath);
      if (remaining.length === 0) {
        fs.rmdirSync(threadPath);
        logger.debug({ group, threadId }, 'Worktree cleanup: removed empty thread directory');
      }
    } catch {
      // Not critical if this fails
    }
  }
}

async function runCleanup(): Promise<void> {
  if (!fs.existsSync(WORKTREES_DIR)) return;

  let groups: string[];
  try {
    groups = fs.readdirSync(WORKTREES_DIR);
  } catch (err) {
    logger.error({ err }, 'Worktree cleanup: failed to read worktrees directory');
    return;
  }

  for (const group of groups) {
    await cleanupGroupWorktrees(group);
  }
}

export function startWorktreeCleanup(): void {
  // Run once at startup (delayed 60s to not compete with init)
  setTimeout(() => {
    runCleanup().catch((err) => {
      logger.error({ err }, 'Worktree cleanup run failed');
    });
  }, 60_000);
  // Then every 6 hours
  setInterval(() => {
    runCleanup().catch((err) => {
      logger.error({ err }, 'Worktree cleanup run failed');
    });
  }, CLEANUP_INTERVAL);
}
