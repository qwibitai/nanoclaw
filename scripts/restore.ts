#!/usr/bin/env tsx
/**
 * Restore a backup archive. CLI only — never wire this to chat.
 *
 *   pnpm run restore --archive <name> [--from local|s3]
 *                    [--agent <agent_group_id>]
 *                    [--dry-run]
 *                    [--force-orphan]
 *
 * If --archive is omitted, the newest archive in the configured backend is used.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { restoreArchive } from '../src/backup/index.js';
import { LocalStorageBackend } from '../src/backup/storage/local.js';
import { S3StorageBackend } from '../src/backup/storage/s3.js';

interface ParsedArgs {
  archive?: string;
  from: 'local' | 's3';
  agent?: string;
  dryRun: boolean;
  forceOrphan: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { from: 'local', dryRun: false, forceOrphan: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--archive') out.archive = argv[++i];
    else if (arg === '--from') out.from = (argv[++i] === 's3' ? 's3' : 'local');
    else if (arg === '--agent') out.agent = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force-orphan') out.forceOrphan = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage: pnpm run restore [--archive <name>] [--from local|s3]
                       [--agent <agent_group_id>] [--dry-run] [--force-orphan]

Credentials for --from s3 come from BACKUP_S3_ACCESS_KEY_ID/_SECRET_ACCESS_KEY
in .env, or the AWS SDK default credential chain (~/.aws/credentials, AWS_PROFILE,
SSO, IMDS) if those aren't set.

Cross-architecture restores (e.g., Apple Silicon → x86) are safe: SQLite files
are arch-agnostic.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  initDb(path.join(DATA_DIR, 'v2.db'));
  const { getDb } = await import('../src/db/connection.js');
  runMigrations(getDb());

  let archiveName = args.archive;
  if (!archiveName) {
    const backend = args.from === 'local' ? new LocalStorageBackend() : new S3StorageBackend();
    const list = await backend.listArchives();
    if (list.length === 0) {
      console.error(`No archives found in ${args.from} backend`);
      process.exit(1);
    }
    archiveName = list[0].name;
    console.log(`No --archive specified; using newest: ${archiveName}`);
  }

  try {
    const result = await restoreArchive({
      archiveName,
      from: args.from,
      onlyAgentGroupId: args.agent,
      dryRun: args.dryRun,
      forceOrphan: args.forceOrphan,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.dryRun) {
      console.log('\nDry-run complete — no changes made. Re-run without --dry-run to apply.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Restore failed: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Restore script crashed:', err);
  process.exit(1);
});
