#!/usr/bin/env npx tsx
/**
 * Backfill search.db for all registered groups from store/messages.db.
 * Run once: npx tsx scripts/backfill-search.ts
 *
 * Safe to re-run — uses INSERT OR IGNORE so existing rows are skipped.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();
const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');

const SEARCH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    sender_name TEXT NOT NULL,
    content     TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    is_from_me  INTEGER NOT NULL DEFAULT 0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    sender_name,
    content='messages',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, sender_name)
    VALUES (new.rowid, new.content, new.sender_name);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
    VALUES ('delete', old.rowid, old.content, old.sender_name);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
    VALUES ('delete', old.rowid, old.content, old.sender_name);
    INSERT INTO messages_fts(rowid, content, sender_name)
    VALUES (new.rowid, new.content, new.sender_name);
  END;

  CREATE TABLE IF NOT EXISTS collections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    source_path TEXT NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(name, source_path)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS collections_fts USING fts5(
    title,
    content,
    content='collections',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS collections_fts_ai AFTER INSERT ON collections BEGIN
    INSERT INTO collections_fts(rowid, title, content)
    VALUES (new.rowid, new.title, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS collections_fts_ad AFTER DELETE ON collections BEGIN
    INSERT INTO collections_fts(collections_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.title, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS collections_fts_au AFTER UPDATE ON collections BEGIN
    INSERT INTO collections_fts(collections_fts, rowid, title, content)
    VALUES ('delete', old.rowid, old.title, old.content);
    INSERT INTO collections_fts(rowid, title, content)
    VALUES (new.rowid, new.title, new.content);
  END;
`;

const BATCH_SIZE = 500;

function backfillGroup(
  mainDb: Database.Database,
  groupFolder: string,
  chatJid: string,
): number {
  const searchDbPath = path.join(GROUPS_DIR, groupFolder, 'search.db');
  const searchDb = new Database(searchDbPath);
  searchDb.pragma('journal_mode = WAL');
  searchDb.exec(SEARCH_SCHEMA);

  const insert = searchDb.prepare(`
    INSERT OR IGNORE INTO messages (id, sender_name, content, timestamp, is_from_me)
    VALUES (@id, @sender_name, @content, @timestamp, @is_from_me)
  `);

  const upsertMeta = searchDb.prepare(`
    INSERT OR REPLACE INTO meta (key, value)
    VALUES ('last_exported_timestamp', ?)
  `);

  let totalExported = 0;
  let lastTs = '';

  while (true) {
    const rows = mainDb
      .prepare(
        `
      SELECT id, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ?
        AND timestamp > ?
        AND is_bot_message = 0
        AND content != ''
        AND length(content) > 2
      ORDER BY timestamp ASC
      LIMIT ?
    `,
      )
      .all(chatJid, lastTs, BATCH_SIZE) as Array<{
      id: string;
      sender_name: string;
      content: string;
      timestamp: string;
      is_from_me: number;
    }>;

    if (rows.length === 0) break;

    const insertMany = searchDb.transaction(
      (
        batch: Array<{
          id: string;
          sender_name: string;
          content: string;
          timestamp: string;
          is_from_me: number;
        }>,
      ) => {
        for (const row of batch) insert.run(row);
        upsertMeta.run(batch[batch.length - 1].timestamp);
      },
    );

    insertMany(rows);
    totalExported += rows.length;
    lastTs = rows[rows.length - 1].timestamp;

    if (rows.length < BATCH_SIZE) break;
  }

  searchDb.close();
  return totalExported;
}

function main(): void {
  const mainDbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(mainDbPath)) {
    console.error('Error: store/messages.db not found. Run the app first.');
    process.exit(1);
  }

  const mainDb = new Database(mainDbPath, { readonly: true });

  // Get all registered groups
  const groups = mainDb
    .prepare('SELECT jid, folder, name FROM registered_groups')
    .all() as Array<{ jid: string; folder: string; name: string }>;

  if (groups.length === 0) {
    console.log('No registered groups found.');
    mainDb.close();
    return;
  }

  console.log(`Backfilling search.db for ${groups.length} group(s)...\n`);

  for (const group of groups) {
    const groupDir = path.join(GROUPS_DIR, group.folder);
    if (!fs.existsSync(groupDir)) {
      console.log(
        `  Skipping ${group.name} — folder ${group.folder} not found`,
      );
      continue;
    }

    const count = backfillGroup(mainDb, group.folder, group.jid);
    console.log(
      `  ${group.name} (${group.folder}): ${count} messages exported`,
    );
  }

  mainDb.close();
  console.log('\nBackfill complete.');
}

main();
