/**
 * Disable the memory integration for a group.
 *
 * Usage: pnpm exec tsx scripts/disable-memory.ts <group-folder>
 *
 * Steps:
 *   1. Remove the memory block from groups/<g>/container.json (atomic write).
 *   2. Cancel the synthesise scheduled task in the group's session inbound.db.
 *   3. Remove watermarks rows for this agentGroupId from data/mnemon-ingest.db.
 *   4. Preserve dead_letters rows (operator review).
 *   5. Preserve ~/.mnemon/data/<agentGroupId>/ (operator audit trail).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { openMnemonIngestDb, runMnemonIngestMigrations } from '../src/db/migrations/019-mnemon-ingest-db.js';
import { restartGroupContainers } from './lib/restart-group-containers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'v2.db');

const SYNTH_SERIES_PREFIX = 'memory-synth-';

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

async function main(): Promise<void> {
  const folder = process.argv[2];
  if (!folder) {
    console.error('Usage: pnpm exec tsx scripts/disable-memory.ts <group-folder>');
    process.exit(1);
  }

  const groupDir = path.join(GROUPS_DIR, folder);
  if (!fs.existsSync(groupDir)) {
    console.error(`Group folder not found: ${groupDir}`);
    process.exit(1);
  }

  const containerJsonPath = path.join(groupDir, 'container.json');
  if (!fs.existsSync(containerJsonPath)) {
    console.error(`container.json not found: ${containerJsonPath}`);
    process.exit(1);
  }

  initDb(DB_PATH);

  // Read container.json
  const raw = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8')) as Record<string, unknown>;
  const agentGroupId = raw.agentGroupId as string | undefined;
  if (!agentGroupId) {
    console.error(`container.json for '${folder}' is missing agentGroupId field`);
    process.exit(1);
  }

  const memoryBlock = raw.memory as { enabled?: boolean } | undefined;
  if (!memoryBlock?.enabled) {
    console.log(`Memory is already disabled for ${folder}. Nothing to do.`);
    process.exit(0);
  }

  // Step 1: remove memory block from container.json (atomic write)
  delete raw.memory;
  atomicWriteJson(containerJsonPath, raw);
  console.log(`[1/3] memory block removed from groups/${folder}/container.json`);

  // Step 2: cancel synthesise scheduled task wherever it lives.
  //
  // Pre-2026-05-08 the synth task could land in either a thread session's
  // inbound.db (legacy MCP-route) or the channel-root session (correct
  // route). Post-fix it always lives in the channel-root session for the
  // (agent, primary MG) pair. To handle both worlds safely without a central
  // DB lookup, scan every session inbound.db belonging to the agent group
  // and delete + de-recur on whichever has the series.
  const seriesId = `${SYNTH_SERIES_PREFIX}${agentGroupId}`;
  const groupSessionsDir = path.join(DATA_DIR, 'v2-sessions', agentGroupId);
  let totalDeleted = 0;
  let totalCleared = 0;
  let scanned = 0;
  if (fs.existsSync(groupSessionsDir)) {
    for (const sessId of fs.readdirSync(groupSessionsDir)) {
      const inboundDbPath = path.join(groupSessionsDir, sessId, 'inbound.db');
      if (!fs.existsSync(inboundDbPath)) continue;
      scanned += 1;
      const db = new Database(inboundDbPath);
      db.pragma('journal_mode = DELETE');
      db.pragma('busy_timeout = 5000');
      try {
        const deleted = db
          .prepare(
            "DELETE FROM messages_in WHERE series_id = ? AND status IN ('pending', 'paused') AND kind = 'task'",
          )
          .run(seriesId);
        // Clear recurrence on completed/failed rows so the recurrence handler
        // can't clone a fresh pending instance from a terminal row.
        const cleared = db
          .prepare(
            "UPDATE messages_in SET recurrence = NULL WHERE series_id = ? AND recurrence IS NOT NULL AND kind = 'task'",
          )
          .run(seriesId);
        totalDeleted += deleted.changes;
        totalCleared += cleared.changes;
      } finally {
        db.close();
      }
    }
  }
  if (totalDeleted > 0 || totalCleared > 0) {
    console.log(
      `[2/3] cancelled synthesise task (seriesId: ${seriesId}) across ${scanned} session DB(s): ${totalDeleted} active row(s) deleted, ${totalCleared} terminal row(s) cleared of recurrence`,
    );
  } else {
    console.log(
      `[2/3] no synthesise task found for seriesId: ${seriesId} across ${scanned} session DB(s) (already cancelled or never scheduled)`,
    );
  }

  // Step 3: remove watermarks rows for this agentGroupId from mnemon-ingest.db
  // Preserve dead_letters (operator review).
  const ingestDb = openMnemonIngestDb(path.join(DATA_DIR, 'mnemon-ingest.db'));
  try {
    runMnemonIngestMigrations(ingestDb);
    const r = ingestDb
      .prepare('DELETE FROM watermarks WHERE agent_group_id = ?')
      .run(agentGroupId);
    console.log(`[3/3] removed ${r.changes} watermark row(s) for ${agentGroupId} from data/mnemon-ingest.db`);
    console.log(`      dead_letters rows preserved for operator review`);
    console.log(`      ~/.mnemon/data/${agentGroupId}/ preserved for operator audit`);
  } finally {
    ingestDb.close();
  }

  // Restart any running container so the next message respawns WITHOUT
  // MNEMON_STORE — capture hooks won't run, no orphan inbox writes.
  const restart = restartGroupContainers(folder);
  if (restart.errors.length > 0) {
    console.warn(`[4/4] container restart errors (best-effort): ${restart.errors.join('; ')}`);
  }
  if (restart.stopped > 0) {
    console.log(`[4/4] stopped ${restart.stopped} running container(s) — next inbound message will respawn without memory hooks`);
  } else {
    console.log(`[4/4] no running containers to restart`);
  }

  console.log(
    `\nMemory disabled for ${folder}. Host daemon closes its watcher on the next 60s sweep; the container respawns on the next inbound message without capture hooks.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
