#!/usr/bin/env tsx
/**
 * Manual trigger for a backup. Bypasses the daily-throttle.
 *
 *   pnpm run backup
 *   pnpm run backup --force         (alias for the default; no throttle)
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { runDailyBackup } from '../src/backup/index.js';

async function main(): Promise<void> {
  initDb(path.join(DATA_DIR, 'v2.db'));
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const { getDb } = await import('../src/db/connection.js');
  runMigrations(getDb());

  const result = await runDailyBackup({ force: true });
  if (result.success) {
    console.log(JSON.stringify(
      {
        ok: true,
        archive: result.archiveName,
        bytes: result.bytes,
        backends: result.backends,
      },
      null,
      2,
    ));
    process.exit(0);
  } else {
    console.error(JSON.stringify({ ok: false, error: result.error, backends: result.backends }, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Backup script crashed:', err);
  process.exit(1);
});
