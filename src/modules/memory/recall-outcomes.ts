/**
 * Inserts pending recall_outcomes rows after a recall injection.
 * One row per fact, atomic transaction. Never throws.
 */
import type Database from 'better-sqlite3';
import { log } from '../../log.js';
import { openMnemonIngestDb, runMnemonIngestMigrations } from '../../db/migrations/019-mnemon-ingest-db.js';
import { JUDGE_PROMPT_VERSION } from '../../memory-daemon/recall-judge/judge-client.js';

// Test seam — override the version for unit tests.
let _judgePromptVersionForTest: string | null = null;
export function _setJudgePromptVersionForTest(v: string): void {
  _judgePromptVersionForTest = v;
}
function activeJudgePromptVersion(): string {
  return _judgePromptVersionForTest ?? JUDGE_PROMPT_VERSION;
}

export interface PendingOutcomeInput {
  recallEventId: string;
  factId: string;
  agentGroupId: string;
  queryStrategy: 'raw' | 'heuristic' | 'llm';
  embeddingSim: number | null;
  triggerThreadId: string | null;
  triggerSentAt: string;
  triggerSenderId: string | null;
  factContentExcerpt: string;
}

let _db: Database.Database | null = null;

export function setIngestDbForTest(db: Database.Database | null): void {
  _db = db;
}

let _prodDb: Database.Database | null = null;

function getDb(): Database.Database | null {
  if (_db !== null) return _db;
  if (_prodDb !== null) return _prodDb;
  // Production path: open the ingest DB synchronously via the static import.
  // The migrations are append-only and idempotent.
  try {
    const db = openMnemonIngestDb();
    runMnemonIngestMigrations(db);
    _prodDb = db;
    return _prodDb;
  } catch (err) {
    log.warn('recall-outcomes: failed to open ingest DB', { err });
    return null;
  }
}

/**
 * Insert pending outcome rows for all facts returned by a recall.
 * All rows are inserted in a single transaction — partial inserts are not possible.
 * Returns {inserted: 0, failed: true} on any DB error. Never throws.
 */
export function insertPendingOutcomes(rows: PendingOutcomeInput[]): { inserted: number; failed: boolean } {
  if (rows.length === 0) return { inserted: 0, failed: false };

  const db = getDb();
  if (!db) {
    log.warn('recall-outcomes: no DB available, skipping outcome insert');
    return { inserted: 0, failed: true };
  }

  const now = new Date().toISOString();
  const version = activeJudgePromptVersion();

  try {
    const stmt = db.prepare(`
      INSERT INTO recall_outcomes (
        recall_event_id, fact_id, judge_prompt_version, agent_group_id,
        query_strategy, embedding_sim, trigger_thread_id, trigger_sent_at,
        trigger_sender_id, judge_score, judge_method, judge_model,
        judge_evidence, response_excerpt_sha, created_at, judged_at,
        fact_content_excerpt
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, NULL, 'pending', NULL,
        NULL, NULL, ?, NULL,
        ?
      )
    `);

    db.transaction(() => {
      for (const row of rows) {
        stmt.run(
          row.recallEventId,
          row.factId,
          version,
          row.agentGroupId,
          row.queryStrategy,
          row.embeddingSim,
          row.triggerThreadId,
          row.triggerSentAt,
          row.triggerSenderId,
          now,
          row.factContentExcerpt.slice(0, 500),
        );
      }
    })();

    return { inserted: rows.length, failed: false };
  } catch (err) {
    log.warn('recall-outcomes: failed to insert pending outcomes', { err });
    return { inserted: 0, failed: true };
  }
}
