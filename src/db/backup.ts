import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import { getDb } from './connection.js';

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_PREFIX = 'v2.db.';
const BACKUP_SUFFIX = '.bak';
const KEEP_COUNT = 60;

/**
 * Snapshot the central DB to data/backups/v2.db.<ISO>.bak using SQLite's
 * online backup API. Safe to call concurrently with writes (WAL mode);
 * the backup is point-in-time.
 *
 * Failures are logged but never thrown — a backup hiccup must not break
 * the host sweep.
 */
export async function backupCentralDb(): Promise<void> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const ts = new Date().toISOString().replace(/[:]/g, '-');
    const dest = path.join(BACKUP_DIR, `${BACKUP_PREFIX}${ts}${BACKUP_SUFFIX}`);

    await getDb().backup(dest);

    pruneOldBackups();
  } catch (err) {
    log.warn('Central DB backup failed', { err: String(err) });
  }
}

function pruneOldBackups(): void {
  const entries = fs
    .readdirSync(BACKUP_DIR)
    .filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith(BACKUP_SUFFIX))
    .map((n) => ({ name: n, mtime: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const e of entries.slice(KEEP_COUNT)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, e.name));
    } catch {
      // best-effort prune; ignore
    }
  }
}
