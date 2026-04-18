/**
 * Read-only wrapper for ~/Library/Messages/chat.db
 *
 * Requires Full Disk Access for the process (System Settings → Privacy & Security → Full Disk Access).
 * Opens the database in readonly mode to avoid any writes to the live Messages store.
 */

import os from 'os';
import path from 'path';

import Database, { Database as Db } from 'better-sqlite3';

import { logger } from '../logger.js';

// Apple epoch offset: macOS CoreData timestamps start 2001-01-01, not 1970-01-01
const APPLE_EPOCH_OFFSET = 978307200;

const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

export interface ChatMessage {
  ROWID: number;
  guid: string;
  text: string | null;
  unix_ts: number;
  is_from_me: number;
  sender_id: string | null;
  chat_id: number;
  chat_identifier: string;
  display_name: string | null;
}

const NEW_MESSAGES_SQL = `
SELECT m.ROWID, m.guid, m.text, m.date / 1000000000 + ${APPLE_EPOCH_OFFSET} AS unix_ts,
       m.is_from_me, h.id AS sender_id, cmj.chat_id,
       c.chat_identifier, c.display_name
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
INNER JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.ROWID > ?
ORDER BY m.ROWID ASC
LIMIT 100
`;

/**
 * Open chat.db in readonly mode.
 * Returns null if the file cannot be accessed (most likely missing Full Disk Access).
 */
export function openChatDb(): Db | null {
  try {
    const db = new Database(CHAT_DB_PATH, { readonly: true });
    logger.info({ path: CHAT_DB_PATH }, 'iMessage chat.db opened');
    return db;
  } catch (err: any) {
    if (err?.code === 'SQLITE_CANTOPEN') {
      logger.error(
        'iMessage: cannot open chat.db — grant Full Disk Access to this process in System Settings → Privacy & Security → Full Disk Access',
      );
    } else {
      logger.error({ err }, 'iMessage: failed to open chat.db');
    }
    return null;
  }
}

/**
 * Fetch messages with ROWID > afterRowId.
 * Returns up to 100 messages ordered by ROWID ascending.
 */
export function getNewMessages(db: Db, afterRowId: number): ChatMessage[] {
  try {
    return db.prepare(NEW_MESSAGES_SQL).all(afterRowId) as ChatMessage[];
  } catch (err) {
    logger.error({ err, afterRowId }, 'iMessage: failed to query new messages');
    return [];
  }
}

/**
 * Resolve a chat_id to its chat_identifier string.
 * Returns null if not found.
 */
export function getChatIdentifier(db: Db, chatId: number): string | null {
  try {
    const row = db
      .prepare('SELECT chat_identifier FROM chat WHERE ROWID = ?')
      .get(chatId) as { chat_identifier: string } | undefined;
    return row?.chat_identifier ?? null;
  } catch (err) {
    logger.error(
      { err, chatId },
      'iMessage: failed to resolve chat_identifier',
    );
    return null;
  }
}
