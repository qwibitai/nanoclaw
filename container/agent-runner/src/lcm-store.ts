/**
 * LCM (Lossless Context Management) Store
 * SQLite database for persisting messages and summary DAG nodes.
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// --- Types ---

export interface LcmMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  token_estimate: number;
  sequence: number;
  created_at: string;
}

export interface LcmSummary {
  id: string;
  conversation_id: string;
  depth: number;
  content: string;
  token_estimate: number;
  source_message_ids: string | null;   // JSON array of lcm_messages.id (for depth 0)
  parent_summary_ids: string | null;   // JSON array of lcm_summaries.id (for depth 1+)
  child_summary_ids: string | null;    // JSON array of lcm_summaries.id condensed into this node
  min_sequence: number | null;
  max_sequence: number | null;
  created_at: string;
}

// --- Schema ---

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lcm_messages (
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lcm_messages_conversation ON lcm_messages(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS lcm_summaries (
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER,
  source_message_ids TEXT,
  parent_summary_ids TEXT,
  child_summary_ids TEXT,
  min_sequence INTEGER,
  max_sequence INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lcm_summaries_conversation ON lcm_summaries(conversation_id, depth);
`;

// FTS5 tables and triggers - created separately since they use IF NOT EXISTS
const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS lcm_messages_fts USING fts5(
  content, content=lcm_messages, content_rowid=rowid
);
CREATE VIRTUAL TABLE IF NOT EXISTS lcm_summaries_fts USING fts5(
  content, content=lcm_summaries, content_rowid=rowid
);
`;

// Triggers must be created idempotently
const TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS lcm_messages_ai AFTER INSERT ON lcm_messages BEGIN
  INSERT INTO lcm_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS lcm_messages_ad AFTER DELETE ON lcm_messages BEGIN
  INSERT INTO lcm_messages_fts(lcm_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS lcm_messages_au AFTER UPDATE ON lcm_messages BEGIN
  INSERT INTO lcm_messages_fts(lcm_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO lcm_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS lcm_summaries_ai AFTER INSERT ON lcm_summaries BEGIN
  INSERT INTO lcm_summaries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS lcm_summaries_ad AFTER DELETE ON lcm_summaries BEGIN
  INSERT INTO lcm_summaries_fts(lcm_summaries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS lcm_summaries_au AFTER UPDATE ON lcm_summaries BEGIN
  INSERT INTO lcm_summaries_fts(lcm_summaries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO lcm_summaries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

// --- Database ---

let db: Database.Database | null = null;
let dbInitialized = false;

export function initLcmDatabase(dbPath: string): Database.Database {
  if (dbInitialized && db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  db.exec(TRIGGERS_SQL);

  // Migration: rename session_id to conversation_id if needed
  try {
    db.exec(`ALTER TABLE lcm_messages RENAME COLUMN session_id TO conversation_id`);
    db.exec(`ALTER TABLE lcm_summaries RENAME COLUMN session_id TO conversation_id`);
  } catch {
    /* columns already renamed or don't exist */
  }

  dbInitialized = true;
  return db;
}

/** @internal - for tests only. Creates a fresh in-memory LCM database. */
export function _initTestLcmDatabase(): void {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  db.exec(TRIGGERS_SQL);
  dbInitialized = true;
}

export function getLcmDb(): Database.Database {
  if (!db) throw new Error('LCM database not initialized. Call initLcmDatabase() first.');
  return db;
}

// --- Helpers ---

export function contentHash(conversationId: string, role: string, content: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(`${conversationId}:${role}:${content}`);
  return hash.digest('hex').slice(0, 16);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- Store functions ---

/**
 * Store messages in the LCM database with content-hash dedup.
 * Returns the number of newly inserted messages (0 for duplicates).
 */
export function storeMessages(
  conversationId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  startSequence: number = 0,
): number {
  const database = getLcmDb();
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO lcm_messages (id, conversation_id, role, content, token_estimate, sequence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let insertedCount = 0;
  const insertMany = database.transaction((msgs: typeof messages) => {
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      const seq = startSequence + i;
      const id = contentHash(conversationId, msg.role, msg.content);
      const result = stmt.run(id, conversationId, msg.role, msg.content, estimateTokens(msg.content), seq, new Date().toISOString());
      if (result.changes > 0) insertedCount++;
    }
  });

  insertMany(messages);
  return insertedCount;
}

export function storeSummary(summary: Omit<LcmSummary, 'token_estimate'>): void {
  const database = getLcmDb();
  const tokenEstimate = estimateTokens(summary.content);
  database.prepare(`
    INSERT OR IGNORE INTO lcm_summaries (id, conversation_id, depth, content, token_estimate, source_message_ids, parent_summary_ids, child_summary_ids, min_sequence, max_sequence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    summary.id,
    summary.conversation_id,
    summary.depth,
    summary.content,
    tokenEstimate,
    summary.source_message_ids,
    summary.parent_summary_ids,
    summary.child_summary_ids,
    summary.min_sequence,
    summary.max_sequence,
    summary.created_at,
  );
}

export function getSummariesForConversation(
  conversationId: string,
  opts?: { depth?: number; minSequence?: number; maxSequence?: number },
): LcmSummary[] {
  const database = getLcmDb();
  let sql = 'SELECT * FROM lcm_summaries WHERE conversation_id = ?';
  const params: unknown[] = [conversationId];

  if (opts?.depth !== undefined) {
    sql += ' AND depth = ?';
    params.push(opts.depth);
  }
  if (opts?.minSequence !== undefined) {
    sql += ' AND max_sequence >= ?';
    params.push(opts.minSequence);
  }
  if (opts?.maxSequence !== undefined) {
    sql += ' AND min_sequence <= ?';
    params.push(opts.maxSequence);
  }

  sql += ' ORDER BY min_sequence ASC';
  return database.prepare(sql).all(...params) as LcmSummary[];
}

export function getSummaryById(id: string): LcmSummary | undefined {
  const database = getLcmDb();
  return database.prepare('SELECT * FROM lcm_summaries WHERE id = ?').get(id) as LcmSummary | undefined;
}

export function getMessagesForSummary(summaryId: string): LcmMessage[] {
  const database = getLcmDb();
  const summary = database.prepare('SELECT source_message_ids FROM lcm_summaries WHERE id = ?').get(summaryId) as { source_message_ids: string | null } | undefined;
  if (!summary?.source_message_ids) return [];

  const ids: string[] = JSON.parse(summary.source_message_ids);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  return database.prepare(`SELECT * FROM lcm_messages WHERE id IN (${placeholders}) ORDER BY sequence`).all(...ids) as LcmMessage[];
}

export function getMessagesBySequenceRange(conversationId: string, minSeq: number, maxSeq: number): LcmMessage[] {
  const database = getLcmDb();
  return database.prepare(
    'SELECT * FROM lcm_messages WHERE conversation_id = ? AND sequence >= ? AND sequence <= ? ORDER BY sequence',
  ).all(conversationId, minSeq, maxSeq) as LcmMessage[];
}

export function getMaxSequence(conversationId: string): number {
  const database = getLcmDb();
  const row = database.prepare('SELECT MAX(sequence) as max_seq FROM lcm_messages WHERE conversation_id = ?').get(conversationId) as { max_seq: number | null } | undefined;
  return row?.max_seq ?? -1;
}

export function searchMessages(queryStr: string, limit: number = 20): Array<LcmMessage & { rank: number }> {
  const database = getLcmDb();
  return database.prepare(`
    SELECT m.*, fts.rank
    FROM lcm_messages_fts fts
    JOIN lcm_messages m ON m.rowid = fts.rowid
    WHERE lcm_messages_fts MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `).all(queryStr, limit) as Array<LcmMessage & { rank: number }>;
}

export function searchSummaries(queryStr: string, limit: number = 20): Array<LcmSummary & { rank: number }> {
  const database = getLcmDb();
  return database.prepare(`
    SELECT s.*, fts.rank
    FROM lcm_summaries_fts fts
    JOIN lcm_summaries s ON s.rowid = fts.rowid
    WHERE lcm_summaries_fts MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `).all(queryStr, limit) as Array<LcmSummary & { rank: number }>;
}

export function getChildSummaries(summaryId: string): LcmSummary[] {
  const database = getLcmDb();
  const summary = getSummaryById(summaryId);
  if (!summary?.child_summary_ids) return [];

  const ids: string[] = JSON.parse(summary.child_summary_ids);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  return database.prepare(`SELECT * FROM lcm_summaries WHERE id IN (${placeholders}) ORDER BY min_sequence`).all(...ids) as LcmSummary[];
}
