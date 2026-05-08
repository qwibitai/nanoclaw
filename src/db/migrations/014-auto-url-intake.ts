/**
 * Per-channel auto URL intake toggle.
 *
 * Adds `messaging_groups.auto_url_intake INTEGER NOT NULL DEFAULT 0` so the
 * URL intake module can be toggled per-channel via a DB row instead of the
 * env-var allowlist bridge. The env var (`INTAKE_ENABLED_PLATFORM_IDS`)
 * remains active as a transitional fallback until all deployed rows have the
 * column flipped — remove the fallback only after ops confirms every active
 * deployment has run this migration and any desired channels are toggled on
 * via `/intake on`.
 *
 * ALTER TABLE ADD COLUMN is FK-safe (unlike the table rebuild that bit us in
 * migration 011). The PRAGMA table_info guard makes the migration idempotent:
 * running it twice on the same DB is a no-op.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'auto-url-intake',
  up: (db: Database.Database) => {
    // Add auto_url_intake to messaging_groups. Idempotent guard in case the
    // column was added by some other path before this migration ran.
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'auto_url_intake')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN auto_url_intake INTEGER NOT NULL DEFAULT 0`);
    }
  },
};
