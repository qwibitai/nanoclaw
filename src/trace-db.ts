import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { STORE_DIR } from './config.js';

const DB_PATH = path.join(STORE_DIR, 'traces.db');
const RETENTION_DAYS = 90;

let db: Database.Database;

export function initTraceDb(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      is_scheduled INTEGER NOT NULL DEFAULT 0,
      prompt_preview TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_traces_started ON traces(started_at);
    CREATE INDEX IF NOT EXISTS idx_traces_group ON traces(group_folder);

    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      model TEXT,
      stop_reason TEXT,
      FOREIGN KEY (trace_id) REFERENCES traces(id)
    );
    CREATE INDEX IF NOT EXISTS idx_llm_trace ON llm_calls(trace_id);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      input_preview TEXT,
      output_preview TEXT,
      FOREIGN KEY (trace_id) REFERENCES traces(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_trace ON tool_calls(trace_id);
  `);
  // Migrate existing DBs that lack input_preview column
  try {
    db.exec('ALTER TABLE tool_calls ADD COLUMN input_preview TEXT');
  } catch {
    /* already exists */
  }
  purgeOldTraces();
}

export function purgeOldTraces(): void {
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 86400_000,
  ).toISOString();
  db.prepare(
    'DELETE FROM tool_calls WHERE trace_id IN (SELECT id FROM traces WHERE started_at < ?)',
  ).run(cutoff);
  db.prepare(
    'DELETE FROM llm_calls WHERE trace_id IN (SELECT id FROM traces WHERE started_at < ?)',
  ).run(cutoff);
  db.prepare('DELETE FROM traces WHERE started_at < ?').run(cutoff);
}

export function upsertTrace(
  id: string,
  group: string,
  chatJid: string,
  isScheduled: boolean,
  promptPreview: string,
): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO traces (id, group_folder, chat_jid, is_scheduled, prompt_preview, started_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    group,
    chatJid,
    isScheduled ? 1 : 0,
    promptPreview,
    new Date().toISOString(),
  );
}

export function finishTrace(id: string, status: string, error?: string): void {
  db.prepare(
    'UPDATE traces SET finished_at = ?, status = ?, error = ? WHERE id = ?',
  ).run(new Date().toISOString(), status, error ?? null, id);
}

// Per-trace state: current open LLM call row id and open tool_id→row id map
const openLlmCalls = new Map<string, number>();
const openToolCalls = new Map<string, Map<string, number>>();

export function startLlmCall(
  traceId: string,
  inputTokens: number | null,
  model: string | null,
): void {
  const result = db
    .prepare(
      `
    INSERT INTO llm_calls (trace_id, started_at, input_tokens, model) VALUES (?, ?, ?, ?)
  `,
    )
    .run(
      traceId,
      new Date().toISOString(),
      inputTokens,
      model,
    ) as Database.RunResult;
  openLlmCalls.set(traceId, result.lastInsertRowid as number);
}

export function endLlmCall(
  traceId: string,
  outputTokens: number | null,
  stopReason: string | null,
): void {
  const rowId = openLlmCalls.get(traceId);
  if (rowId == null) return;
  db.prepare(
    'UPDATE llm_calls SET finished_at = ?, output_tokens = ?, stop_reason = ? WHERE id = ?',
  ).run(new Date().toISOString(), outputTokens, stopReason, rowId);
  openLlmCalls.delete(traceId);
}

export function startToolCall(
  traceId: string,
  toolId: string,
  toolName: string,
  isSubagent: boolean,
  inputPreview?: string,
): void {
  const result = db
    .prepare(
      `
    INSERT INTO tool_calls (trace_id, tool_id, tool_name, is_subagent, started_at, input_preview)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      traceId,
      toolId,
      toolName,
      isSubagent ? 1 : 0,
      new Date().toISOString(),
      inputPreview ?? null,
    ) as Database.RunResult;
  if (!openToolCalls.has(traceId)) openToolCalls.set(traceId, new Map());
  openToolCalls.get(traceId)!.set(toolId, result.lastInsertRowid as number);
}

export function endToolCall(
  traceId: string,
  toolId: string,
  outputPreview: string,
): void {
  const rowId = openToolCalls.get(traceId)?.get(toolId);
  if (rowId == null) return;
  db.prepare(
    'UPDATE tool_calls SET finished_at = ?, output_preview = ? WHERE id = ?',
  ).run(new Date().toISOString(), outputPreview, rowId);
  openToolCalls.get(traceId)?.delete(toolId);
}

// ── Read API ──────────────────────────────────────────────────────────────────

export function getTraces(limit = 50, offset = 0): unknown[] {
  return db
    .prepare(
      `
    SELECT t.*,
      COUNT(DISTINCT lc.id) AS llm_calls,
      SUM(lc.input_tokens) AS total_input_tokens,
      SUM(lc.output_tokens) AS total_output_tokens,
      COUNT(DISTINCT tc.id) AS tool_calls
    FROM traces t
    LEFT JOIN llm_calls lc ON lc.trace_id = t.id
    LEFT JOIN tool_calls tc ON tc.trace_id = t.id
    GROUP BY t.id
    ORDER BY t.started_at DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(limit, offset);
}

export function getTrace(id: string): unknown {
  return db.prepare('SELECT * FROM traces WHERE id = ?').get(id);
}

export function getLlmCalls(traceId: string): unknown[] {
  return db
    .prepare('SELECT * FROM llm_calls WHERE trace_id = ? ORDER BY started_at')
    .all(traceId);
}

export function getToolCalls(traceId: string): unknown[] {
  return db
    .prepare('SELECT * FROM tool_calls WHERE trace_id = ? ORDER BY started_at')
    .all(traceId);
}

export function getStats(): unknown {
  return db
    .prepare(
      `
    SELECT
      COUNT(*) AS total_traces,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_traces,
      SUM(lc.input_tokens) AS total_input_tokens,
      SUM(lc.output_tokens) AS total_output_tokens,
      COUNT(DISTINCT tc.id) AS total_tool_calls
    FROM traces t
    LEFT JOIN llm_calls lc ON lc.trace_id = t.id
    LEFT JOIN tool_calls tc ON tc.trace_id = t.id
    WHERE t.started_at >= datetime('now', '-7 days')
  `,
    )
    .get();
}
