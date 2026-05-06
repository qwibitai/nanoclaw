/**
 * Public entry point for the backup feature.
 *
 *   runDailyBackup({ force? })  — orchestrate one backup attempt
 *   restoreArchive({ ... })     — re-export from restore.ts for the CLI
 *
 * Concurrency: one attempt at a time, gated by an O_CREAT|O_EXCL lockfile
 * at `data/.backup.lock`. The marker file (host-side, outside DATA_DIR)
 * tracks last attempt / success and dedupes failure notifications.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, INSTALL_SLUG } from '../config.js';
import { hasTable } from '../db/connection.js';
import { getDb } from '../db/connection.js';
import { log } from '../log.js';

import { buildArchive } from './archive.js';
import { enumerateBackupTargets } from './inventory.js';
import { hashError, notifyOwnerOfBackupFailure } from './notify.js';
import { readBackupStatus, writeBackupStatus, type BackupStatus } from './state.js';
import { resolveBackends, type StorageBackend } from './storage/index.js';

const NANOCLAW_VERSION = '2.0.14';

export interface RunDailyBackupOptions {
  /** If true, skip the daily-throttle and the BACKUP_HOUR window check. */
  force?: boolean;
}

export interface RunDailyBackupResult {
  success: boolean;
  archiveName?: string;
  bytes?: number;
  error?: string;
  /** Per-backend outcome — success / error string. */
  backends: Array<{ name: string; ok: boolean; error?: string; url?: string }>;
}

const LOCK_FILE = () => path.join(DATA_DIR, '.backup.lock');
const STAGING_BASE = () => path.join(DATA_DIR, '.backup-staging');
const STAGING_LOCAL = () => path.join(DATA_DIR, '.backup-archives');

function timestampForName(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export async function runDailyBackup(options: RunDailyBackupOptions = {}): Promise<RunDailyBackupResult> {
  const { force = false } = options;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Acquire lock. O_CREAT|O_EXCL ensures only one process owns the file at
  // a time; on failure we surface a deterministic error string the test can
  // assert on. PID is written for stale-lock detection in long-lived hosts.
  const lockPath = LOCK_FILE();
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        success: false,
        error: 'backup already in progress (lock held)',
        backends: [],
      };
    }
    throw err;
  }
  fs.writeSync(lockFd, String(process.pid));
  fs.closeSync(lockFd);

  // Throttle check is the scheduler's responsibility. The CLI passes
  // force=true; the scheduler only enters this code path after its own
  // decideShouldBackup() returned `run: true`. Either way, by the time we
  // hold the lock we always run.
  void force;

  const startedAt = new Date();
  const archiveName = `${INSTALL_SLUG}-${timestampForName(startedAt)}.tar.gz`;

  let manifestSummary: Awaited<ReturnType<typeof buildArchive>> | null = null;
  const backendResults: RunDailyBackupResult['backends'] = [];

  // Update last_attempt_at before doing any work so a hard crash still
  // counts as an attempt — protects against a poison archive that crashes
  // the process every retry.
  const status = readBackupStatus();
  const newStatus: BackupStatus = {
    ...status,
    last_attempt_at: startedAt.toISOString(),
  };
  writeBackupStatus(newStatus);

  try {
    const stagingDir = path.join(STAGING_BASE(), timestampForName(startedAt));
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(STAGING_LOCAL(), { recursive: true });
    const stagedArchivePath = path.join(STAGING_LOCAL(), archiveName);

    manifestSummary = await buildArchive({
      targets: enumerateBackupTargets(),
      centralDbPath: path.join(DATA_DIR, 'v2.db'),
      archivePath: stagedArchivePath,
      stagingDir,
      nanoclawVersion: NANOCLAW_VERSION,
      centralTablesPresent: listCentralTables(),
    });

    // Push to each backend independently. One backend's failure does not
    // abort the others; per-backend errors are recorded in the result and
    // also rolled into status.last_error for the notify path.
    const backends = resolveBackends();
    for (const backend of backends) {
      const r = await runOneBackend(backend, stagedArchivePath, archiveName);
      backendResults.push(r);
    }

    // Clean up the per-archive staging dir — but leave STAGING_LOCAL so
    // the local backend (if used) doesn't have to recopy. The Local backend
    // already copies to BACKUP_LOCAL_DIR if that path differs from the
    // staging path; tests use BACKUP_LOCAL_DIR equal to STAGING_LOCAL so
    // the copy is a no-op.
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch (err) {
    const errorString = err instanceof Error ? err.message : String(err);
    log.error('Backup run failed', { error: errorString });
    writeBackupStatus({ ...newStatus, last_error: errorString });
    await maybeNotifyFailure(errorString, status.last_notified_error_hash);
    fs.unlinkSync(lockPath);
    return { success: false, error: errorString, backends: backendResults };
  }

  // If at least one backend succeeded, the backup is considered successful
  // and last_success_at advances. A "all backends failed" case still reports
  // failure overall.
  const anyOk = backendResults.some((r) => r.ok);
  if (anyOk) {
    const finalStatus: BackupStatus = {
      ...newStatus,
      last_success_at: new Date().toISOString(),
      last_archive_name: archiveName,
      last_error: backendResults.find((r) => !r.ok)?.error ?? null,
      last_notified_error_hash: null,
    };
    writeBackupStatus(finalStatus);
    log.info('Backup completed', { archiveName, bytes: manifestSummary?.bytes, backends: backendResults });
    fs.unlinkSync(lockPath);
    return {
      success: true,
      archiveName,
      bytes: manifestSummary?.bytes,
      backends: backendResults,
    };
  }

  const aggregateError = backendResults.map((r) => `${r.name}: ${r.error ?? 'unknown'}`).join('; ');
  writeBackupStatus({ ...newStatus, last_error: aggregateError });
  await maybeNotifyFailure(aggregateError, status.last_notified_error_hash);
  fs.unlinkSync(lockPath);
  return {
    success: false,
    error: aggregateError,
    backends: backendResults,
  };
}

async function runOneBackend(
  backend: StorageBackend,
  archivePath: string,
  archiveName: string,
): Promise<RunDailyBackupResult['backends'][number]> {
  try {
    const { url, bytes } = await backend.writeArchive(archivePath, archiveName);
    return { name: backend.name, ok: true, url, error: undefined };
    void bytes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Backup backend "${backend.name}" failed`, { error: message });
    return { name: backend.name, ok: false, error: message };
  }
}

function listCentralTables(): string[] {
  if (!hasTable) return [];
  return (
    getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  ).map((r) => r.name);
}

async function maybeNotifyFailure(error: string, lastNotifiedHash: string | null): Promise<void> {
  const errorHash = hashError(error);
  if (errorHash === lastNotifiedHash) {
    log.info('Backup failure DM skipped — same error hash as last notification', { errorHash });
    return;
  }
  try {
    const result = await notifyOwnerOfBackupFailure({
      errorHash,
      message: `Backup failed: ${error}. Run \`pnpm run backup:status\` for detail.`,
    });
    if (result.delivered) {
      const cur = readBackupStatus();
      writeBackupStatus({ ...cur, last_notified_error_hash: errorHash });
    }
  } catch (notifyErr) {
    log.error('Backup failure DM threw', { err: notifyErr });
  }
}

export { restoreArchive } from './restore.js';
