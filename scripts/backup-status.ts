#!/usr/bin/env tsx
/**
 * Print the current backup status — last attempt, last success, last error,
 * configured backends, and a warning if the last successful backup is more
 * than 36h ago (which means today's run hasn't completed yet).
 *
 *   pnpm run backup:status
 */
import { BACKUP_BACKENDS, BACKUP_HOUR, BACKUP_LOCAL_DIR, BACKUP_STATUS_FILE, TIMEZONE } from '../src/config.js';
import { readBackupStatus } from '../src/backup/state.js';

const STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000;

function main(): void {
  const status = readBackupStatus();
  const now = Date.now();

  console.log('Backup status');
  console.log('─────────────');
  console.log(`Status file:      ${BACKUP_STATUS_FILE}`);
  console.log(`Backends:         ${BACKUP_BACKENDS.join(', ') || '(none)'}`);
  console.log(`Local dir:        ${BACKUP_LOCAL_DIR}`);
  console.log(`Daily window:     ${String(BACKUP_HOUR).padStart(2, '0')}:00 ${TIMEZONE}`);
  console.log('');
  console.log(`Last attempt:     ${status.last_attempt_at ?? '(never)'}`);
  console.log(`Last success:     ${status.last_success_at ?? '(never)'}`);
  console.log(`Last archive:     ${status.last_archive_name ?? '(none)'}`);
  console.log(`Last error:       ${status.last_error ?? '(none)'}`);

  if (status.last_success_at) {
    const ageMs = now - new Date(status.last_success_at).getTime();
    const ageH = (ageMs / 3_600_000).toFixed(1);
    if (ageMs > STALE_THRESHOLD_MS) {
      console.log('');
      console.log(`⚠ Last successful backup was ${ageH}h ago (threshold ${STALE_THRESHOLD_MS / 3_600_000}h).`);
      process.exitCode = 2;
    }
  } else {
    console.log('');
    console.log('⚠ No successful backup on record yet.');
    process.exitCode = 2;
  }
}

main();
