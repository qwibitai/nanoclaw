/**
 * Usage logging — fork-only mod.
 *
 * Records token/cost usage from each Claude SDK result into outbound.db.
 * The dashboard at nanoclawv2-dashboard reads these rows read-only to
 * display the Costs panel. Schema is additive; ensureTable runs idempotently
 * on first write so existing session DBs adopt it without a formal migration.
 *
 * Every row corresponds to one `result` message from the Claude Agent SDK
 * — i.e. one query (handle of N inbound messages → final assistant turn).
 * total_cost_usd is the SDK's own computation (model-aware), so we do not
 * maintain a pricing table here.
 */
import { getOutboundDb } from './connection.js';

export interface UsageRecord {
  sdkSessionId: string | null;
  model: string | null;
  numTurns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  resultSubtype: string | null;
}

function ensureUsageLogTable(): void {
  // CREATE TABLE IF NOT EXISTS is cheap and a no-op when the table already
  // exists, so we run it on every call rather than caching at module scope —
  // a module-level cache would go stale if getOutboundDb() returns a fresh
  // connection (e.g. between tests, or after a reconnect).
  const db = getOutboundDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                          TEXT NOT NULL DEFAULT (datetime('now')),
      sdk_session_id              TEXT,
      model                       TEXT,
      num_turns                   INTEGER,
      duration_ms                 INTEGER,
      input_tokens                INTEGER,
      output_tokens               INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens     INTEGER,
      total_cost_usd              REAL,
      result_subtype              TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_log_ts ON usage_log(ts);`);
}

export function recordUsage(rec: UsageRecord): void {
  ensureUsageLogTable();
  getOutboundDb()
    .prepare(
      `INSERT INTO usage_log
       (sdk_session_id, model, num_turns, duration_ms,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        total_cost_usd, result_subtype)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.sdkSessionId,
      rec.model,
      rec.numTurns,
      rec.durationMs,
      rec.inputTokens,
      rec.outputTokens,
      rec.cacheCreationInputTokens,
      rec.cacheReadInputTokens,
      rec.totalCostUsd,
      rec.resultSubtype,
    );
}
