/**
 * Atomic Rollback Deploys — symlink-based release management.
 *
 * releases/<sha>/ — immutable snapshots
 * current → <sha> — atomic symlink switch
 *
 * Pure functions for testing. All filesystem operations use injected baseDir.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ── Types ───────────────────────────────────────────────────────────

export interface ReleaseInfo {
  sha: string;
  timestamp: number;
  isCurrent: boolean;
}

export interface DeployResult {
  success: boolean;
  sha: string;
  releasePath: string;
  message: string;
}

export interface RollbackResult {
  success: boolean;
  previousSha: string;
  rolledBackTo: string;
  message: string;
}

// ── Constants ───────────────────────────────────────────────────────

export const RELEASES_DIR = 'releases';
export const CURRENT_LINK = 'current';
export const MAX_RELEASES = 5;

// ── Pure helpers ────────────────────────────────────────────────────

/**
 * Get the current git SHA (short).
 */
export function getGitSha(cwd?: string): string {
  return execSync('git rev-parse --short HEAD', {
    cwd: cwd || process.cwd(),
    encoding: 'utf-8',
  }).trim();
}

/**
 * List all releases sorted by timestamp (newest first).
 */
export function listReleases(baseDir: string): ReleaseInfo[] {
  const releasesDir = path.join(baseDir, RELEASES_DIR);
  if (!fs.existsSync(releasesDir)) return [];

  const currentSha = getCurrentRelease(baseDir);

  const entries = fs.readdirSync(releasesDir).filter((entry) => {
    const full = path.join(releasesDir, entry);
    return fs.statSync(full).isDirectory();
  });

  return entries
    .map((sha) => {
      const stat = fs.statSync(path.join(releasesDir, sha));
      return {
        sha,
        timestamp: stat.mtimeMs,
        isCurrent: sha === currentSha,
      };
    })
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Get the SHA that `current` symlink points to, or null.
 */
export function getCurrentRelease(baseDir: string): string | null {
  const linkPath = path.join(baseDir, CURRENT_LINK);
  try {
    const target = fs.readlinkSync(linkPath);
    // Target is like "releases/<sha>" — extract sha
    return path.basename(target);
  } catch {
    return null;
  }
}

/**
 * Create an immutable release snapshot.
 * Copies the dist/ directory into releases/<sha>/.
 */
export function createRelease(
  baseDir: string,
  sha: string,
  sourceDir: string,
): DeployResult {
  const releasesDir = path.join(baseDir, RELEASES_DIR);
  const releasePath = path.join(releasesDir, sha);

  if (fs.existsSync(releasePath)) {
    return {
      success: false,
      sha,
      releasePath,
      message: `Release ${sha} already exists`,
    };
  }

  fs.mkdirSync(releasePath, { recursive: true });

  // Copy source files to release directory
  copyDirSync(sourceDir, releasePath);

  return {
    success: true,
    sha,
    releasePath,
    message: `Release ${sha} created`,
  };
}

/**
 * Atomically switch the `current` symlink to a release.
 * Uses rename for atomicity (write temp link, then rename over current).
 */
export function switchToRelease(baseDir: string, sha: string): boolean {
  const releasePath = path.join(baseDir, RELEASES_DIR, sha);
  if (!fs.existsSync(releasePath)) return false;

  const linkPath = path.join(baseDir, CURRENT_LINK);
  const tempLink = `${linkPath}.tmp.${Date.now()}`;

  // Create temp symlink pointing to releases/<sha>
  fs.symlinkSync(path.join(RELEASES_DIR, sha), tempLink);

  // Atomic rename over the current symlink
  fs.renameSync(tempLink, linkPath);

  return true;
}

/**
 * Rollback to the previous release.
 */
export function rollback(baseDir: string): RollbackResult {
  const releases = listReleases(baseDir);
  const currentSha = getCurrentRelease(baseDir);

  if (!currentSha) {
    return {
      success: false,
      previousSha: '',
      rolledBackTo: '',
      message: 'No current release to rollback from',
    };
  }

  // Find the release before the current one
  const currentIdx = releases.findIndex((r) => r.sha === currentSha);
  if (currentIdx === -1 || currentIdx >= releases.length - 1) {
    return {
      success: false,
      previousSha: currentSha,
      rolledBackTo: '',
      message: 'No previous release to rollback to',
    };
  }

  const previous = releases[currentIdx + 1];
  const switched = switchToRelease(baseDir, previous.sha);

  if (!switched) {
    return {
      success: false,
      previousSha: currentSha,
      rolledBackTo: previous.sha,
      message: `Failed to switch to release ${previous.sha}`,
    };
  }

  return {
    success: true,
    previousSha: currentSha,
    rolledBackTo: previous.sha,
    message: `Rolled back from ${currentSha} to ${previous.sha}`,
  };
}

/**
 * Prune old releases, keeping the most recent N.
 * Never prunes the current release.
 */
export function pruneReleases(
  baseDir: string,
  keepCount: number = MAX_RELEASES,
): string[] {
  const releases = listReleases(baseDir);
  const pruned: string[] = [];

  // Keep the newest `keepCount` releases + always keep current
  const toKeep = new Set(releases.slice(0, keepCount).map((r) => r.sha));
  const currentSha = getCurrentRelease(baseDir);
  if (currentSha) toKeep.add(currentSha);

  for (const release of releases) {
    if (!toKeep.has(release.sha)) {
      const releasePath = path.join(baseDir, RELEASES_DIR, release.sha);
      fs.rmSync(releasePath, { recursive: true, force: true });
      pruned.push(release.sha);
    }
  }

  return pruned;
}

/**
 * Full deploy: build snapshot → create release → switch → prune.
 */
export function deploy(
  baseDir: string,
  sourceDir: string,
  sha?: string,
): DeployResult {
  const releaseSha = sha || getGitSha(baseDir);

  const result = createRelease(baseDir, releaseSha, sourceDir);
  if (!result.success) return result;

  const switched = switchToRelease(baseDir, releaseSha);
  if (!switched) {
    return {
      ...result,
      success: false,
      message: `Created release ${releaseSha} but failed to switch`,
    };
  }

  const pruned = pruneReleases(baseDir);

  return {
    success: true,
    sha: releaseSha,
    releasePath: result.releasePath,
    message: `Deployed ${releaseSha}${pruned.length > 0 ? `, pruned ${pruned.length} old release(s)` : ''}`,
  };
}

// ── Internal helpers ────────────────────────────────────────────────

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
