/**
 * Inserts pending recall_outcomes rows after a recall injection.
 * One row per fact, atomic transaction. Never throws.
 */
import type Database from 'better-sqlite3';
import { log } from '../../log.js';

// JUDGE_PROMPT_VERSION is owned by Group C (src/memory-daemon/recall-judge/judge-client.ts).
// Import it from there so version bumps cascade automatically. If C1 hasn't
// been created yet, TypeScript will catch the missing module at typecheck time.
let _judgePromptVersion: string | null = null;

async function getJudgePromptVersion(): Promise<string> {
  if (_judgePromptVersion !== null) return _judgePromptVersion;
  try {
    const mod = await import('../../memory-daemon/recall-judge/judge-client.js');
    _judgePromptVersion = (mod as { JUDGE_PROMPT_VERSION?: string }).JUDGE_PROMPT_VERSION ?? 'v1';
  } catch {
    _judgePromptVersion = 'v1';
  }
  return _judgePromptVersion;
}

// Synchronous version used internally — populated lazily on first insert.
// We use a module-level preload so tests that inject a DB get the version synced.
let _judgePromptVersionSync: string = 'v1';
void getJudgePromptVersion().then((v) => {
  _judgePromptVersionSync = v;
});

// Test seam — override the sync version for unit tests.
export function _setJudgePromptVersionForTest(v: string): void {
  _judgePromptVersionSync = v;
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
}

let _db: Database.Database | null = null;

export function setIngestDbForTest(db: Database.Database | null): void {
  _db = db;
}

let _prodDb: Database.Database | null = null;

function getDb(): Database.Database | null {
  if (_db !== null) return _db;
  if (_prodDb !== null) return _prodDb;
  // Production path: open the ingest DB synchronously. We can't use dynamic
  // import here because insertPendingOutcomes is synchronous. The production
  // caller (recall-injection.ts) is in the same process and has already
  // imported 019 migrations, so they're in the module cache.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m =
      require('../../db/migrations/019-mnemon-ingest-db.js') as typeof import('../../db/migrations/019-mnemon-ingest-db.js');
    const db = m.openMnemonIngestDb();
    m.runMnemonIngestMigrations(db);
    _prodDb = db;
    return _prodDb;
  } catch {
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
  const version = _judgePromptVersionSync;

  try {
    const stmt = db.prepare(`
      INSERT INTO recall_outcomes (
        recall_event_id, fact_id, judge_prompt_version, agent_group_id,
        query_strategy, embedding_sim, trigger_thread_id, trigger_sent_at,
        trigger_sender_id, judge_score, judge_method, judge_model,
        judge_evidence, response_excerpt_sha, created_at, judged_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, NULL, 'pending', NULL,
        NULL, NULL, ?, NULL
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
        );
      }
    })();

    return { inserted: rows.length, failed: false };
  } catch (err) {
    log.warn('recall-outcomes: failed to insert pending outcomes', { err });
    return { inserted: 0, failed: true };
  }
}
