/**
 * Auto-commit and push agent workspace changes after each run.
 * Only commits groups/ and data/ directories.
 */
import { exec } from 'child_process';
import { logger } from './logger.js';

let syncing = false;

export function gitSyncAfterRun(): void {
  if (syncing) return; // don't stack up concurrent syncs
  syncing = true;

  const cwd = process.cwd();
  const cmd = [
    'git add groups/',
    'git diff --cached --quiet || git commit -m "auto: sync agent data"',
    'git push',
  ].join(' && ');

  exec(cmd, { cwd, timeout: 30_000 }, (err, _stdout, stderr) => {
    syncing = false;
    if (err) {
      // Exit code 1 from diff --quiet means "no changes" — that's fine
      if (err.code === 1 && !stderr) return;
      logger.warn({ err: err.message, stderr }, 'Git sync failed');
      return;
    }
    logger.info('Git sync: pushed agent data');
  });
}
