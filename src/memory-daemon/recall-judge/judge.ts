/**
 * Daemon-side judge sweep processor (Task C3).
 * Polls recall_outcomes for pending rows and scores them via the LLM judge.
 */

import { createHash } from 'crypto';
import path from 'path';
import Database from 'better-sqlite3';
import { openMnemonIngestDb } from '../../db/migrations/019-mnemon-ingest-db.js';
import { DATA_DIR } from '../../config.js';
import { callJudge, JUDGE_PROMPT_VERSION, JUDGE_SYSTEM_PROMPT, JudgeParseError } from './judge-client.js';
import { recordOrIncrementFailure, deleteAfterSuccess } from '../dead-letters.js';

export interface JudgeProcessorOpts {
  agentGroupId: string;
  graceMs?: number; // default 60_000
  judgeTimeoutMs?: number; // default 30_000
  signal?: AbortSignal;
}

export interface JudgeProcessorResult {
  processed: number;
  ambiguous: number;
  judged: number;
  retried: number;
  failed: number;
}

let _db: Database.Database | null = null;
let _archiveDb: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = openMnemonIngestDb();
  }
  return _db;
}

function getArchiveDb(): Database.Database {
  if (!_archiveDb) {
    _archiveDb = new Database(path.join(DATA_DIR, 'archive.db'), { readonly: true });
  }
  return _archiveDb;
}

/** Test-only seam: inject pre-opened ingest DB (with migrations applied). */
export function setJudgeProcessorDbForTest(db: Database.Database | null): void {
  _db = db;
}

/** Test-only seam: inject pre-opened archive DB. */
export function setArchiveDbForTest(db: Database.Database | null): void {
  _archiveDb = db;
}

interface RecallOutcomeRow {
  recall_event_id: string;
  fact_id: string;
  judge_prompt_version: string;
  agent_group_id: string;
  query_strategy: string;
  embedding_sim: number | null;
  trigger_thread_id: string | null;
  trigger_sent_at: string;
  trigger_sender_id: string | null;
  judge_score: number | null;
  judge_method: string | null;
  judge_model: string | null;
  judge_evidence: string | null;
  response_excerpt_sha: string | null;
  created_at: string;
  judged_at: string | null;
  fact_content_excerpt: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function buildResponseExcerpt(text: string): string {
  if (text.length <= 4000) return text;
  return text.slice(0, 2000) + text.slice(-2000);
}

export async function processPendingJudgments(opts: JudgeProcessorOpts): Promise<JudgeProcessorResult> {
  const { agentGroupId, graceMs = 60_000, judgeTimeoutMs = 30_000, signal } = opts;
  const db = getDb();
  const archiveDb = getArchiveDb();

  const result: JudgeProcessorResult = { processed: 0, ambiguous: 0, judged: 0, retried: 0, failed: 0 };

  // Convert graceMs to seconds for SQLite datetime arithmetic
  const graceSecs = Math.floor(graceMs / 1000);

  // 1. Query pending rows older than grace window.
  // Use strftime(...,'now') to produce ISO8601 format consistent with JS timestamps
  // (new Date().toISOString() = 'YYYY-MM-DDTHH:MM:SS.sssZ'). SQLite datetime('now')
  // returns 'YYYY-MM-DD HH:MM:SS' which sorts BEFORE ISO8601 due to ' ' < 'T' in ASCII.
  const pendingRows = db
    .prepare(
      `SELECT * FROM recall_outcomes
       WHERE agent_group_id = ? AND judged_at IS NULL
         AND created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${graceSecs} seconds')
       ORDER BY recall_event_id, created_at`,
    )
    .all(agentGroupId) as RecallOutcomeRow[];

  if (pendingRows.length === 0) return result;

  // 2. Group by recall_event_id
  const byEvent = new Map<string, RecallOutcomeRow[]>();
  for (const row of pendingRows) {
    const rows = byEvent.get(row.recall_event_id) ?? [];
    rows.push(row);
    byEvent.set(row.recall_event_id, rows);
  }

  // E6 helper: track events terminally marked ambiguous so subsequent loop
  // iterations don't re-process them. We populate this when the ambiguity
  // check in one event's processing also marks its peer(s).
  const ambiguousEventIds = new Set<string>();

  // Snapshot dead-letter retry state once per sweep — avoids N round-trips.
  const deadLetterRetry = new Map<string, string | null>(); // event_id → next_retry_at (ISO) or null
  const dlRows = db
    .prepare(
      `SELECT item_key, next_retry_at FROM dead_letters
       WHERE agent_group_id = ? AND item_type = 'recall-judge' AND poisoned_at IS NULL`,
    )
    .all(agentGroupId) as Array<{ item_key: string; next_retry_at: string | null }>;
  for (const dlRow of dlRows) {
    // item_key is `recall-judge:<event_id>`
    const eventId = dlRow.item_key.startsWith('recall-judge:')
      ? dlRow.item_key.slice('recall-judge:'.length)
      : dlRow.item_key;
    deadLetterRetry.set(eventId, dlRow.next_retry_at);
  }

  for (const [recallEventId, eventRows] of byEvent) {
    result.processed++;
    const representative = eventRows[0]!;

    // E3: Honor dead-letter backoff. If a prior failure recorded a future
    // next_retry_at, skip this event until the window elapses. The dead-letter
    // backoff schedule (60s/300s/900s) lives in dead-letters.ts; we just gate on it.
    const nextRetryAt = deadLetterRetry.get(recallEventId);
    if (nextRetryAt && nextRetryAt > new Date().toISOString()) {
      continue;
    }

    // 3. Ambiguity check: if multiple events in same (agent_group_id, trigger_thread_id)
    //    within ±60s of this event's trigger_sent_at, mark ALL of them ambiguous and skip.
    //    E6 fix: previously we only marked the current event, which let the
    //    second overlapping event slip through (the original first event was no
    //    longer "pending" by the time the loop hit it, so the size-check failed
    //    and judge ran). Now we mark every overlapping event terminally in one
    //    transaction and remember them so the rest of the loop skips them too.
    const threadId = representative.trigger_thread_id;
    if (threadId && !ambiguousEventIds.has(recallEventId)) {
      // Compute ISO8601 window bounds in JS so SQLite receives normalized strings.
      // trigger_sent_at is stored as ISO8601 (YYYY-MM-DDTHH:MM:SS.sssZ). Comparing
      // directly as strings is valid since ISO8601 is lexicographically sortable.
      const triggerMs = new Date(representative.trigger_sent_at).getTime();
      const windowLow = new Date(triggerMs - 60_000).toISOString();
      const windowHigh = new Date(triggerMs + 60_000).toISOString();
      const overlapRows = db
        .prepare(
          `SELECT DISTINCT recall_event_id FROM recall_outcomes
           WHERE agent_group_id = ? AND trigger_thread_id = ?
             AND judged_at IS NULL
             AND trigger_sent_at >= ?
             AND trigger_sent_at <= ?`,
        )
        .all(agentGroupId, threadId, windowLow, windowHigh) as Array<{
        recall_event_id: string;
      }>;

      const distinctEventIds = new Set(overlapRows.map((r) => r.recall_event_id));
      if (distinctEventIds.size > 1) {
        const nowIso = new Date().toISOString();
        db.transaction(() => {
          const stmt = db.prepare(
            `UPDATE recall_outcomes
             SET judge_method = 'ambiguous-correlation', judged_at = ?
             WHERE agent_group_id = ? AND recall_event_id = ? AND judged_at IS NULL`,
          );
          for (const eid of distinctEventIds) {
            stmt.run(nowIso, agentGroupId, eid);
            ambiguousEventIds.add(eid);
            if (eid !== recallEventId && byEvent.has(eid)) {
              // We'll skip these when the loop reaches them.
              result.ambiguous++;
            }
          }
        })();
        result.ambiguous++; // for the current event
        continue;
      }
    }
    if (ambiguousEventIds.has(recallEventId)) {
      // Already marked terminally by an earlier overlapping event in this sweep.
      continue;
    }

    // 4. Look up agent response from archive.db
    const archiveRow = archiveDb
      .prepare(
        `SELECT text FROM messages_archive
         WHERE agent_group_id = ? AND thread_id = ?
           AND sent_at > ? AND role = 'assistant'
         ORDER BY sent_at
         LIMIT 1`,
      )
      .get(agentGroupId, threadId ?? '', representative.trigger_sent_at) as { text: string } | undefined;

    const deadLetterKey = `recall-judge:${recallEventId}`;

    if (!archiveRow) {
      // No response yet — dead-letter for retry
      const dlResult = recordOrIncrementFailure({
        itemType: 'recall-judge',
        itemKey: deadLetterKey,
        agentGroupId,
        error: 'No assistant response found in archive',
      });
      result.retried++;

      if (dlResult.poisoned) {
        // After 3 retries: mark judge-failed
        db.transaction(() => {
          db.prepare(
            `UPDATE recall_outcomes
             SET judge_method = 'judge-failed', judged_at = ?
             WHERE agent_group_id = ? AND recall_event_id = ? AND judged_at IS NULL`,
          ).run(new Date().toISOString(), agentGroupId, recallEventId);
        })();
        result.failed++;
      }
      continue;
    }

    // 5. Build judge user prompt
    const responseExcerpt = buildResponseExcerpt(archiveRow.text);

    // Look up user message from archive (the trigger message that caused the recall)
    const userMsgRow = threadId
      ? (archiveDb
          .prepare(
            `SELECT text FROM messages_archive
             WHERE agent_group_id = ? AND thread_id = ?
               AND sent_at <= ? AND role = 'user'
             ORDER BY sent_at DESC
             LIMIT 1`,
          )
          .get(agentGroupId, threadId, representative.trigger_sent_at) as { text: string } | undefined)
      : undefined;

    const candidateFacts = eventRows.map((r) => ({
      fact_id: r.fact_id,
      content: r.fact_content_excerpt ?? '',
    }));
    const knownFactIds = new Set(eventRows.map((r) => r.fact_id));

    const userPayload = JSON.stringify({
      user_message: userMsgRow?.text ?? `[trigger at ${representative.trigger_sent_at}]`,
      agent_response_excerpt: responseExcerpt,
      candidate_facts: candidateFacts,
    });

    // 6. Call judge
    let judgeOutput;
    try {
      judgeOutput = await callJudge(JUDGE_SYSTEM_PROMPT, userPayload, {
        timeoutMs: judgeTimeoutMs,
        signal,
        knownFactIds,
      });
    } catch (err) {
      const isParseError = err instanceof JudgeParseError;
      const errMsg = err instanceof Error ? err.message : String(err);

      const dlResult = recordOrIncrementFailure({
        itemType: 'recall-judge',
        itemKey: deadLetterKey,
        agentGroupId,
        error: errMsg,
      });
      result.retried++;

      if (dlResult.poisoned || (isParseError && dlResult.failureCount >= 3)) {
        db.transaction(() => {
          db.prepare(
            `UPDATE recall_outcomes
             SET judge_method = 'judge-failed', judged_at = ?
             WHERE agent_group_id = ? AND recall_event_id = ? AND judged_at IS NULL`,
          ).run(new Date().toISOString(), agentGroupId, recallEventId);
        })();
        result.failed++;
      }
      continue;
    }

    // 7. Write scores in single transaction.
    // E7 fix: require complete coverage of every fact_id we sent to the judge.
    // If the LLM omits any fact (validation drop, model truncation, prompt
    // injection bypassing one fact, etc.), we mark the omitted facts terminally
    // as judge-failed instead of leaving them pending. Otherwise the partial
    // index keeps re-fetching them every sweep, repeating cost without bound.
    const responseExcerptSha = sha256(responseExcerpt);
    const judgeModel = process.env.MEMORY_RECALL_JUDGE_BACKEND ?? 'anthropic:haiku-4-5:default';

    const scoredIds = new Set(judgeOutput.scores.map((s) => s.fact_id));
    const omittedIds = [...knownFactIds].filter((id) => !scoredIds.has(id));

    const nowIso = new Date().toISOString();
    db.transaction(() => {
      for (const score of judgeOutput.scores) {
        db.prepare(
          `UPDATE recall_outcomes
           SET judge_score = ?, judge_method = 'llm', judge_model = ?,
               judge_evidence = ?, response_excerpt_sha = ?, judged_at = ?
           WHERE agent_group_id = ? AND recall_event_id = ? AND fact_id = ?
             AND judge_prompt_version = ? AND judged_at IS NULL`,
        ).run(
          score.score,
          judgeModel,
          score.evidence,
          responseExcerptSha,
          nowIso,
          agentGroupId,
          recallEventId,
          score.fact_id,
          JUDGE_PROMPT_VERSION,
        );
      }
      if (omittedIds.length > 0) {
        const omitStmt = db.prepare(
          `UPDATE recall_outcomes
           SET judge_method = 'judge-failed', judged_at = ?
           WHERE agent_group_id = ? AND recall_event_id = ? AND fact_id = ?
             AND judge_prompt_version = ? AND judged_at IS NULL`,
        );
        for (const factId of omittedIds) {
          omitStmt.run(nowIso, agentGroupId, recallEventId, factId, JUDGE_PROMPT_VERSION);
        }
      }
    })();

    // E3: Clear any prior dead-letter row for this event after success — otherwise
    // success-after-retry leaves stale failure_count/next_retry_at telemetry behind.
    if (deadLetterRetry.has(recallEventId)) {
      deleteAfterSuccess(deadLetterKey, agentGroupId);
    }

    result.judged++;
  }

  return result;
}
