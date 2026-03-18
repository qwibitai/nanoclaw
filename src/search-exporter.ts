/**
 * Search Exporter — maintains per-group search.db (SQLite + FTS5)
 * for deterministically isolated conversation search.
 *
 * Each registered group gets its own search.db in its group folder.
 * Agent containers access only their own group's search.db via the
 * filesystem mount boundary — no code-level isolation needed.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, STORE_DIR } from './config.js';
import { getAllRegisteredGroups } from './db.js';
import { logger } from './logger.js';

const SYNC_INTERVAL = 600_000; // 10 minutes
const BATCH_SIZE = 500;

let mainDb: Database.Database;
let syncTimer: ReturnType<typeof setInterval> | null = null;

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

  CREATE TABLE IF NOT EXISTS reactions (
    message_id  TEXT NOT NULL,
    sender      TEXT NOT NULL,
    sender_name TEXT,
    emoji       TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    PRIMARY KEY (message_id, sender)
  );
`;

function openSearchDb(dbPath: string): Database.Database {
  const searchDb = new Database(dbPath);
  searchDb.pragma('journal_mode = WAL');
  searchDb.exec(SEARCH_SCHEMA);
  return searchDb;
}

function syncGroup(groupFolder: string, chatJid: string): void {
  const searchDbPath = path.join(GROUPS_DIR, groupFolder, 'search.db');
  let searchDb: Database.Database | null = null;

  try {
    searchDb = openSearchDb(searchDbPath);

    const lastTs =
      (
        searchDb
          .prepare(
            "SELECT value FROM meta WHERE key = 'last_exported_timestamp'",
          )
          .get() as { value: string } | undefined
      )?.value ?? '';

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

    if (rows.length === 0) return;

    const insert = searchDb.prepare(`
      INSERT OR IGNORE INTO messages (id, sender_name, content, timestamp, is_from_me)
      VALUES (@id, @sender_name, @content, @timestamp, @is_from_me)
    `);

    const upsertMeta = searchDb.prepare(`
      INSERT OR REPLACE INTO meta (key, value)
      VALUES ('last_exported_timestamp', ?)
    `);

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
        if (batch.length > 0) {
          upsertMeta.run(batch[batch.length - 1].timestamp);
        }
      },
    );

    insertMany(rows);

    logger.debug(
      { groupFolder, exported: rows.length },
      'Search export sync complete',
    );

    // If we hit the batch limit, there may be more — schedule another pass
    if (rows.length === BATCH_SIZE) {
      setImmediate(() => syncGroup(groupFolder, chatJid));
    }
  } catch (err) {
    logger.error({ groupFolder, err }, 'Search export sync failed');
  } finally {
    searchDb?.close();
  }
}

function syncAllGroups(): void {
  const groups = getAllRegisteredGroups();
  for (const [chatJid, group] of Object.entries(groups)) {
    syncGroup(group.folder, chatJid);
  }
}

/**
 * Export a single message to its group's search.db in real time.
 * Called from the onMessage hook after storeMessage().
 */
export function exportMessage(
  groupFolder: string,
  msg: {
    id: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me?: boolean;
    is_bot_message?: boolean;
  },
): void {
  // Skip bot messages and empty content
  if (msg.is_bot_message) return;
  if (!msg.content || msg.content.length <= 2) return;

  const searchDbPath = path.join(GROUPS_DIR, groupFolder, 'search.db');
  let searchDb: Database.Database | null = null;

  try {
    searchDb = openSearchDb(searchDbPath);

    searchDb
      .prepare(
        `
      INSERT OR IGNORE INTO messages (id, sender_name, content, timestamp, is_from_me)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(
        msg.id,
        msg.sender_name,
        msg.content,
        msg.timestamp,
        msg.is_from_me ? 1 : 0,
      );

    // Update sync cursor so background loop doesn't re-export this message
    searchDb
      .prepare(
        `
      INSERT INTO meta (key, value) VALUES ('last_exported_timestamp', ?)
      ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)
    `,
      )
      .run(msg.timestamp);
  } catch (err) {
    logger.error(
      { groupFolder, msgId: msg.id, err },
      'Real-time search export failed',
    );
  } finally {
    searchDb?.close();
  }
}

/**
 * Export a reaction to the group's search.db in real time.
 * If emoji is empty/null, the reaction is removed.
 */
export function exportReaction(
  groupFolder: string,
  reaction: {
    message_id: string;
    sender: string;
    sender_name?: string;
    emoji: string | null;
    timestamp: string;
  },
): void {
  const searchDbPath = path.join(GROUPS_DIR, groupFolder, 'search.db');
  let searchDb: Database.Database | null = null;

  try {
    searchDb = openSearchDb(searchDbPath);

    if (!reaction.emoji) {
      // Reaction removed
      searchDb
        .prepare(
          `DELETE FROM reactions WHERE message_id = ? AND sender = ?`,
        )
        .run(reaction.message_id, reaction.sender);
    } else {
      // Upsert reaction (one reaction per user per message)
      searchDb
        .prepare(
          `INSERT INTO reactions (message_id, sender, sender_name, emoji, timestamp)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(message_id, sender) DO UPDATE SET
             emoji = excluded.emoji,
             sender_name = excluded.sender_name,
             timestamp = excluded.timestamp`,
        )
        .run(
          reaction.message_id,
          reaction.sender,
          reaction.sender_name || reaction.sender.split('@')[0],
          reaction.emoji,
          reaction.timestamp,
        );
    }
  } catch (err) {
    logger.error(
      { groupFolder, messageId: reaction.message_id, err },
      'Real-time reaction export failed',
    );
  } finally {
    searchDb?.close();
  }
}

/**
 * Start the search exporter. Called once during startup.
 * Opens a read-only connection to the main messages.db and begins
 * syncing messages to per-group search.db files.
 */
export function startSearchExporter(): void {
  const mainDbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(mainDbPath)) {
    logger.warn('Main messages.db not found, search exporter deferred');
    return;
  }

  mainDb = new Database(mainDbPath, { readonly: true });
  logger.info('Search exporter started');

  // Initial full sync for all groups
  syncAllGroups();

  // Background loop for catch-up sync
  syncTimer = setInterval(syncAllGroups, SYNC_INTERVAL);
}

/**
 * Stop the search exporter (for graceful shutdown).
 */
export function stopSearchExporter(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (mainDb) {
    mainDb.close();
  }
}
