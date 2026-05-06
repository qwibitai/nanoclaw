/**
 * Read/write the host-side backup status file. Lives outside DATA_DIR
 * deliberately — a project-level restore must not roll the backup clock
 * back, which would force an immediate redundant run on next sweep tick.
 */
import fs from 'fs';
import path from 'path';

import { BACKUP_STATUS_FILE } from '../config.js';

export interface BackupStatus {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_archive_name: string | null;
  last_error: string | null;
  /** SHA-256 of the most-recently-notified error message; lets the failure DM
   *  dedup so the same SQLITE_CORRUPT doesn't ping the owner every day. */
  last_notified_error_hash: string | null;
}

const DEFAULT_STATUS: BackupStatus = {
  last_attempt_at: null,
  last_success_at: null,
  last_archive_name: null,
  last_error: null,
  last_notified_error_hash: null,
};

export function readBackupStatus(): BackupStatus {
  if (!fs.existsSync(BACKUP_STATUS_FILE)) return { ...DEFAULT_STATUS };
  const raw = fs.readFileSync(BACKUP_STATUS_FILE, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<BackupStatus>;
  return { ...DEFAULT_STATUS, ...parsed };
}

export function writeBackupStatus(status: BackupStatus): void {
  fs.mkdirSync(path.dirname(BACKUP_STATUS_FILE), { recursive: true });
  fs.writeFileSync(BACKUP_STATUS_FILE, JSON.stringify(status, null, 2));
}
