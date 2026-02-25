/**
 * Brain Sync — clones/pulls Anton's knowledge base repo.
 * Called at startup and periodically to keep brain fresh.
 */
import { execSync } from 'child_process';
import fs from 'fs';

import { BRAIN_DIR, BRAIN_REPO_URL } from './config.js';
import { logger } from './logger.js';

/**
 * Sync the brain repo. Clones on first run, pulls on subsequent runs.
 * Returns the path to brain/ subdirectory, or null if disabled/failed.
 */
export function syncBrain(): string | null {
  if (!BRAIN_REPO_URL) return null;

  try {
    if (!fs.existsSync(BRAIN_DIR)) {
      logger.info({ repo: BRAIN_REPO_URL }, 'Cloning brain repo');
      execSync(`git clone --depth 1 ${BRAIN_REPO_URL} ${BRAIN_DIR}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
    } else {
      logger.debug('Pulling latest brain');
      execSync('git pull --ff-only', {
        cwd: BRAIN_DIR,
        stdio: 'pipe',
        timeout: 15_000,
      });
    }

    const brainPath = `${BRAIN_DIR}/brain`;
    if (!fs.existsSync(brainPath)) {
      logger.warn({ brainPath }, 'brain/ subdirectory not found in repo');
      return null;
    }

    return brainPath;
  } catch (err) {
    logger.error({ err }, 'Failed to sync brain repo');
    return null;
  }
}
