/**
 * Brain Sync — clones/pulls Anton's knowledge base repo.
 * Called at startup to ensure brain is available.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { BRAIN_DIR, BRAIN_REPO_URL } from './config.js';
import { logger } from './logger.js';

let cachedBrainPath: string | null = null;

/**
 * Sync the brain repo. Clones on first run, pulls on subsequent runs.
 * Caches the result so container launches don't block on network calls.
 */
export function syncBrain(): void {
  if (!BRAIN_REPO_URL) return;

  try {
    // If directory exists but isn't a git repo, re-clone
    if (
      fs.existsSync(BRAIN_DIR) &&
      !fs.existsSync(path.join(BRAIN_DIR, '.git'))
    ) {
      logger.warn('Brain directory exists but is not a git repo, re-cloning');
      fs.rmSync(BRAIN_DIR, { recursive: true, force: true });
    }

    if (!fs.existsSync(BRAIN_DIR)) {
      logger.info({ repo: BRAIN_REPO_URL }, 'Cloning brain repo');
      execFileSync(
        'git',
        ['clone', '--depth', '1', BRAIN_REPO_URL, BRAIN_DIR],
        {
          stdio: 'pipe',
          timeout: 30_000,
        },
      );
    } else {
      logger.debug('Pulling latest brain');
      execFileSync('git', ['pull', '--ff-only'], {
        cwd: BRAIN_DIR,
        stdio: 'pipe',
        timeout: 15_000,
      });
    }

    const brainPath = path.join(BRAIN_DIR, 'brain');
    if (!fs.existsSync(brainPath)) {
      logger.warn({ brainPath }, 'brain/ subdirectory not found in repo');
      return;
    }

    cachedBrainPath = brainPath;
  } catch (err) {
    logger.error({ err }, 'Failed to sync brain repo');
  }
}

/**
 * Get the cached brain path. Returns null if brain is disabled or sync failed.
 */
export function getBrainPath(): string | null {
  return cachedBrainPath;
}
