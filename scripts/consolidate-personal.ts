#!/usr/bin/env tsx
/**
 * Consolidate redundant "main" group folders into a single `personal` folder.
 *
 * Merges: telegram_main, whatsapp_main, discord_main, main → personal
 *
 * Run while the NanoClaw service is stopped:
 *   npx tsx scripts/consolidate-personal.ts
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

const TARGET = 'personal';
const OLD_FOLDERS = ['telegram_main', 'whatsapp_main', 'discord_main', 'main'];

// ---------------------------------------------------------------------------
// 1. Database migration
// ---------------------------------------------------------------------------

console.log('Opening database:', DB_PATH);
const db = new Database(DB_PATH);

db.transaction(() => {
  // Re-point registered JIDs to personal
  const repoint = db.prepare(
    `UPDATE registered_groups SET folder = ? WHERE jid IN ('tg:475857948', '12018999497@s.whatsapp.net')`,
  );
  const repointResult = repoint.run(TARGET);
  console.log(`registered_groups: re-pointed ${repointResult.changes} JIDs → ${TARGET}`);

  // Update group_folder in all scoped tables (except sessions_v2 which needs special handling)
  const tables = [
    'sessions',
    'scheduled_tasks',
    'memories',
    'thread_metadata',
    'ship_log',
    'backlog',
    'commit_digest_state',
    'pending_gates',
    'user_groups',
    'mcp_servers',
  ];

  for (const table of tables) {
    try {
      const stmt = db.prepare(
        `UPDATE ${table} SET group_folder = ? WHERE group_folder IN (${OLD_FOLDERS.map(() => '?').join(', ')})`,
      );
      const result = stmt.run(TARGET, ...OLD_FOLDERS);
      if (result.changes > 0) {
        console.log(`${table}: updated ${result.changes} rows`);
      }
    } catch (err) {
      // Table might not exist in older installs
      console.log(`${table}: skipped (${(err as Error).message})`);
    }
  }

  // Special handling for sessions_v2: session_key is PK derived from group_folder
  const oldSessions = db
    .prepare(
      `SELECT * FROM sessions_v2 WHERE group_folder IN (${OLD_FOLDERS.map(() => '?').join(', ')})`,
    )
    .all(...OLD_FOLDERS) as Array<Record<string, unknown>>;

  for (const row of oldSessions) {
    const oldKey = row.session_key as string;
    const threadId = row.thread_id as string | null;
    const newKey = threadId ? `${TARGET}:thread:${threadId}` : TARGET;

    // Check if target key already exists
    const existing = db
      .prepare('SELECT last_activity FROM sessions_v2 WHERE session_key = ?')
      .get(newKey) as { last_activity: string } | undefined;

    if (existing) {
      // Keep the one with newer activity
      const oldActivity = row.last_activity as string;
      if (oldActivity > existing.last_activity) {
        db.prepare('DELETE FROM sessions_v2 WHERE session_key = ?').run(newKey);
        db.prepare('DELETE FROM sessions_v2 WHERE session_key = ?').run(oldKey);
        db.prepare(
          `INSERT INTO sessions_v2 (session_key, group_folder, thread_id, session_id, last_activity, created_at, processing, chat_jid, model, effort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newKey, TARGET, threadId, row.session_id, row.last_activity,
          row.created_at, row.processing ?? 0, row.chat_jid, row.model, row.effort,
        );
        console.log(`sessions_v2: replaced ${oldKey} → ${newKey} (newer activity)`);
      } else {
        db.prepare('DELETE FROM sessions_v2 WHERE session_key = ?').run(oldKey);
        console.log(`sessions_v2: dropped ${oldKey} (${newKey} has newer activity)`);
      }
    } else {
      db.prepare('DELETE FROM sessions_v2 WHERE session_key = ?').run(oldKey);
      db.prepare(
        `INSERT INTO sessions_v2 (session_key, group_folder, thread_id, session_id, last_activity, created_at, processing, chat_jid, model, effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newKey, TARGET, threadId, row.session_id, row.last_activity,
        row.created_at, row.processing ?? 0, row.chat_jid, row.model, row.effort,
      );
      console.log(`sessions_v2: migrated ${oldKey} → ${newKey}`);
    }
  }

  console.log('Database migration complete.');
})();

db.close();

// ---------------------------------------------------------------------------
// 2. Filesystem consolidation
// ---------------------------------------------------------------------------

const targetDir = path.join(GROUPS_DIR, TARGET);
fs.mkdirSync(path.join(targetDir, 'conversations'), { recursive: true });
fs.mkdirSync(path.join(targetDir, 'logs'), { recursive: true });

function moveFiles(srcDir: string, destDir: string): number {
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  for (const file of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, file);
    const dest = path.join(destDir, file);
    if (fs.existsSync(dest)) {
      // Avoid overwriting — prefix with source folder name
      const parent = path.basename(path.dirname(path.dirname(src)));
      const renamed = path.join(destDir, `${parent}_${file}`);
      fs.renameSync(src, renamed);
    } else {
      fs.renameSync(src, dest);
    }
    count++;
  }
  return count;
}

for (const folder of OLD_FOLDERS) {
  const folderPath = path.join(GROUPS_DIR, folder);
  if (!fs.existsSync(folderPath)) continue;

  // Move conversations
  const convMoved = moveFiles(
    path.join(folderPath, 'conversations'),
    path.join(targetDir, 'conversations'),
  );
  if (convMoved > 0) console.log(`Moved ${convMoved} conversations from ${folder}`);

  // Move logs
  const logsMoved = moveFiles(
    path.join(folderPath, 'logs'),
    path.join(targetDir, 'logs'),
  );
  if (logsMoved > 0) console.log(`Moved ${logsMoved} logs from ${folder}`);

  // Remove the now-empty folder tree
  fs.rmSync(folderPath, { recursive: true, force: true });
  console.log(`Removed groups/${folder}/`);
}

// Clean up ephemeral IPC directories
for (const folder of OLD_FOLDERS) {
  const ipcDir = path.join(DATA_DIR, 'ipc', folder);
  if (fs.existsSync(ipcDir)) {
    fs.rmSync(ipcDir, { recursive: true, force: true });
    console.log(`Removed data/ipc/${folder}/`);
  }
}

// Clean up stale session directories
for (const folder of OLD_FOLDERS) {
  const sessionDir = path.join(DATA_DIR, 'sessions', folder);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log(`Removed data/sessions/${folder}/`);
  }
}

console.log('\nConsolidation complete. Restart NanoClaw to pick up the changes.');
