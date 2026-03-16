/**
 * iMessage Host Handler
 * Reads messages from macOS chat.db via SQLite, sends via AppleScript.
 * Called by IPC handler when container agents use imessage_* tools.
 */

import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const CHAT_DB_PATH = path.join(
  process.env.HOME || '/Users',
  'Library/Messages/chat.db',
);

// Apple's CoreData epoch: 2001-01-01 00:00:00 UTC
const APPLE_EPOCH_OFFSET = 978307200;
// chat.db stores nanoseconds
const NANOSECOND_DIVISOR = 1_000_000_000;

interface MessageRow {
  rowid: number;
  date: number;
  text: string | null;
  is_from_me: number;
  handle_id: string | null;
  cache_roomnames: string | null;
}

interface SearchResult {
  id: number;
  timestamp: string;
  contact: string;
  is_from_me: boolean;
  text: string;
  group_chat: string | null;
}

interface ConversationResult {
  contact: string;
  messages: Array<{
    timestamp: string;
    is_from_me: boolean;
    text: string;
  }>;
}

function openChatDb(): Database.Database {
  if (!fs.existsSync(CHAT_DB_PATH)) {
    throw new Error(`iMessage database not found at ${CHAT_DB_PATH}`);
  }
  return new Database(CHAT_DB_PATH, { readonly: true });
}

function appleTimestampToISO(appleNs: number): string {
  const unixSeconds = appleNs / NANOSECOND_DIVISOR + APPLE_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000).toISOString();
}

export function imessageSearch(params: {
  query?: string;
  contact?: string;
  since_days?: number;
  limit?: number;
}): SearchResult[] {
  const db = openChatDb();
  try {
    const limit = Math.min(params.limit || 50, 200);
    const sinceDays = params.since_days || 30;
    const cutoffNs =
      (Date.now() / 1000 - APPLE_EPOCH_OFFSET - sinceDays * 86400) *
      NANOSECOND_DIVISOR;

    let sql = `
      SELECT m.rowid, m.date, m.text, m.is_from_me,
             h.id as handle_id, m.cache_roomnames
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.rowid
      WHERE m.text IS NOT NULL
        AND m.date > ?
    `;
    const sqlParams: (string | number)[] = [cutoffNs];

    if (params.contact) {
      sql += ` AND h.id LIKE ?`;
      sqlParams.push(`%${params.contact}%`);
    }
    if (params.query) {
      sql += ` AND m.text LIKE ?`;
      sqlParams.push(`%${params.query}%`);
    }

    sql += ` ORDER BY m.date DESC LIMIT ?`;
    sqlParams.push(limit);

    const rows = db.prepare(sql).all(...sqlParams) as MessageRow[];

    return rows.map((row) => ({
      id: row.rowid,
      timestamp: appleTimestampToISO(row.date),
      contact: row.handle_id || 'unknown',
      is_from_me: row.is_from_me === 1,
      text:
        row.text && row.text.length > 200
          ? row.text.slice(0, 200) + '...'
          : row.text || '',
      group_chat: row.cache_roomnames || null,
    }));
  } finally {
    db.close();
  }
}

export function imessageRead(params: {
  contact: string;
  limit?: number;
  since_days?: number;
}): ConversationResult {
  const db = openChatDb();
  try {
    const limit = Math.min(params.limit || 50, 200);
    const sinceDays = params.since_days || 7;
    const cutoffNs =
      (Date.now() / 1000 - APPLE_EPOCH_OFFSET - sinceDays * 86400) *
      NANOSECOND_DIVISOR;

    const rows = db
      .prepare(
        `
      SELECT m.date, m.text, m.is_from_me, h.id as handle_id
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.rowid
      WHERE m.text IS NOT NULL
        AND m.date > ?
        AND h.id LIKE ?
      ORDER BY m.date ASC
      LIMIT ?
    `,
      )
      .all(cutoffNs, `%${params.contact}%`, limit) as MessageRow[];

    return {
      contact: params.contact,
      messages: rows.map((row) => ({
        timestamp: appleTimestampToISO(row.date),
        is_from_me: row.is_from_me === 1,
        text: row.text || '',
      })),
    };
  } finally {
    db.close();
  }
}

export async function imessageSend(params: {
  to: string;
  text: string;
}): Promise<{ success: boolean; message: string }> {
  // Validate recipient format (phone or email)
  if (!/^[+\d][\d\s()-]+$/.test(params.to) && !params.to.includes('@')) {
    return {
      success: false,
      message: `Invalid recipient: "${params.to}". Must be a phone number or email.`,
    };
  }

  // Limit message length
  if (params.text.length > 10000) {
    return {
      success: false,
      message: 'Message too long (max 10000 characters).',
    };
  }

  const script = `
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${params.to}" of targetService
  send "${params.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}" to targetBuddy
end tell
`;

  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', script],
      { timeout: 15000 },
      (err, _stdout, stderr) => {
        if (err) {
          logger.warn({ err, to: params.to }, 'iMessage send failed');
          resolve({
            success: false,
            message: `Failed to send: ${stderr || err.message}`,
          });
        } else {
          logger.info({ to: params.to }, 'iMessage sent');
          resolve({ success: true, message: `Message sent to ${params.to}` });
        }
      },
    );
  });
}

export function imessageListContacts(params: {
  since_days?: number;
  limit?: number;
}): Array<{ contact: string; message_count: number; last_message: string }> {
  const db = openChatDb();
  try {
    const sinceDays = params.since_days || 30;
    const limit = Math.min(params.limit || 30, 100);
    const cutoffNs =
      (Date.now() / 1000 - APPLE_EPOCH_OFFSET - sinceDays * 86400) *
      NANOSECOND_DIVISOR;

    const rows = db
      .prepare(
        `
      SELECT h.id as contact, COUNT(*) as message_count, MAX(m.date) as last_date
      FROM message m
      JOIN handle h ON m.handle_id = h.rowid
      WHERE m.text IS NOT NULL AND m.date > ?
      GROUP BY h.id
      ORDER BY last_date DESC
      LIMIT ?
    `,
      )
      .all(cutoffNs, limit) as Array<{
      contact: string;
      message_count: number;
      last_date: number;
    }>;

    return rows.map((row) => ({
      contact: row.contact,
      message_count: row.message_count,
      last_message: appleTimestampToISO(row.last_date),
    }));
  } finally {
    db.close();
  }
}
