import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMnemonIngestMigrations } from '../../db/migrations/019-mnemon-ingest-db.js';
import { runMnemonRecallFeedbackMigration } from '../../db/migrations/021-mnemon-recall-feedback.js';
import { setDeadLettersDb } from '../dead-letters.js';
import { processPendingJudgments, setJudgeProcessorDbForTest, setArchiveDbForTest } from './judge.js';
import { setJudgeBackendForTest, _resetJudgeBackendForTest, JUDGE_PROMPT_VERSION } from './judge-client.js';

function makeIngestDb(): Database.Database {
  const db = new Database(':memory:');
  runMnemonIngestMigrations(db);
  return db;
}

function makeArchiveDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_archive (
      id TEXT PRIMARY KEY,
      agent_group_id TEXT NOT NULL,
      messaging_group_id TEXT,
      channel_type TEXT NOT NULL,
      channel_name TEXT,
      platform_id TEXT,
      thread_id TEXT,
      role TEXT NOT NULL,
      sender_id TEXT,
      sender_name TEXT,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertPendingOutcome(
  db: Database.Database,
  opts: {
    recallEventId: string;
    factId: string;
    agentGroupId: string;
    threadId?: string;
    sentAt?: string;
    createdSecondsAgo?: number;
  },
): void {
  const createdAt = opts.createdSecondsAgo
    ? new Date(Date.now() - opts.createdSecondsAgo * 1000).toISOString()
    : new Date(Date.now() - 90_000).toISOString();

  db.prepare(
    `INSERT INTO recall_outcomes
     (recall_event_id, fact_id, judge_prompt_version, agent_group_id, query_strategy,
      trigger_thread_id, trigger_sent_at, created_at, judge_method)
     VALUES (?, ?, ?, ?, 'raw', ?, ?, ?, 'pending')`,
  ).run(
    opts.recallEventId,
    opts.factId,
    JUDGE_PROMPT_VERSION,
    opts.agentGroupId,
    opts.threadId ?? 'thread-1',
    opts.sentAt ?? new Date(Date.now() - 120_000).toISOString(),
    createdAt,
  );
}

function insertArchiveResponse(
  archiveDb: Database.Database,
  opts: {
    agentGroupId: string;
    threadId: string;
    sentAt: string;
    text: string;
    role?: string;
  },
): void {
  archiveDb
    .prepare(
      `INSERT INTO messages_archive
     (id, agent_group_id, channel_type, thread_id, role, text, sent_at, created_at)
     VALUES (?, ?, 'discord', ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      `msg-${Math.random().toString(36).slice(2)}`,
      opts.agentGroupId,
      opts.threadId,
      opts.role ?? 'assistant',
      opts.text,
      opts.sentAt,
    );
}

beforeEach(() => {
  _resetJudgeBackendForTest();
});

afterEach(() => {
  _resetJudgeBackendForTest();
  setJudgeProcessorDbForTest(null);
  setArchiveDbForTest(null);
});

describe('processPendingJudgments', () => {
  it('test_judges_pending_rows', async () => {
    const db = makeIngestDb();
    const archiveDb = makeArchiveDb();
    setJudgeProcessorDbForTest(db);
    setArchiveDbForTest(archiveDb);
    setDeadLettersDb(db);

    const triggerSentAt = new Date(Date.now() - 120_000).toISOString();
    const agentResponseAt = new Date(Date.now() - 60_000).toISOString();

    insertPendingOutcome(db, {
      recallEventId: 'evt-1',
      factId: 'f1',
      agentGroupId: 'g1',
      threadId: 't1',
      sentAt: triggerSentAt,
    });
    insertArchiveResponse(archiveDb, {
      agentGroupId: 'g1',
      threadId: 't1',
      sentAt: agentResponseAt,
      text: 'Agent used fact f1 here.',
    });

    setJudgeBackendForTest(async () =>
      JSON.stringify({ scores: [{ fact_id: 'f1', score: 2, evidence: 'Agent used fact f1 here.' }] }),
    );

    const result = await processPendingJudgments({ agentGroupId: 'g1' });
    expect(result.judged).toBe(1);

    const row = db.prepare('SELECT * FROM recall_outcomes WHERE recall_event_id=?').get('evt-1') as {
      judge_score: number;
      judge_method: string;
      judged_at: string | null;
    };
    expect(row.judge_score).toBe(2);
    expect(row.judge_method).toBe('llm');
    expect(row.judged_at).not.toBeNull();
  });

  it('test_skips_within_grace_window', async () => {
    const db = makeIngestDb();
    const archiveDb = makeArchiveDb();
    setJudgeProcessorDbForTest(db);
    setArchiveDbForTest(archiveDb);
    setDeadLettersDb(db);

    // Created 30 seconds ago — within default 60s grace
    insertPendingOutcome(db, { recallEventId: 'evt-grace', factId: 'f1', agentGroupId: 'g1', createdSecondsAgo: 30 });

    setJudgeBackendForTest(async () => JSON.stringify({ scores: [] }));

    const result = await processPendingJudgments({ agentGroupId: 'g1', graceMs: 60_000 });
    expect(result.processed).toBe(0);
    expect(result.judged).toBe(0);

    const row = db.prepare('SELECT judged_at FROM recall_outcomes WHERE recall_event_id=?').get('evt-grace') as {
      judged_at: string | null;
    };
    expect(row.judged_at).toBeNull();
  });

  it('test_ambiguity_detection', async () => {
    const db = makeIngestDb();
    const archiveDb = makeArchiveDb();
    setJudgeProcessorDbForTest(db);
    setArchiveDbForTest(archiveDb);
    setDeadLettersDb(db);

    const sentAt = new Date(Date.now() - 120_000).toISOString();
    const sentAt2 = new Date(Date.now() - 110_000).toISOString(); // within 60s of first

    // Two different events in same thread within 30s of each other
    insertPendingOutcome(db, {
      recallEventId: 'evt-a',
      factId: 'f1',
      agentGroupId: 'g1',
      threadId: 'thread-overlap',
      sentAt,
    });
    insertPendingOutcome(db, {
      recallEventId: 'evt-b',
      factId: 'f2',
      agentGroupId: 'g1',
      threadId: 'thread-overlap',
      sentAt: sentAt2,
    });

    let backendCalled = false;
    setJudgeBackendForTest(async () => {
      backendCalled = true;
      return JSON.stringify({ scores: [] });
    });

    const result = await processPendingJudgments({ agentGroupId: 'g1' });
    expect(result.ambiguous).toBeGreaterThan(0);
    expect(backendCalled).toBe(false);

    const rowA = db
      .prepare('SELECT judge_method, judged_at FROM recall_outcomes WHERE recall_event_id=?')
      .get('evt-a') as { judge_method: string; judged_at: string | null };
    expect(rowA.judge_method).toBe('ambiguous-correlation');
    expect(rowA.judged_at).not.toBeNull();
  });

  it('test_no_response_triggers_retry', async () => {
    const db = makeIngestDb();
    const archiveDb = makeArchiveDb();
    setJudgeProcessorDbForTest(db);
    setArchiveDbForTest(archiveDb);
    setDeadLettersDb(db);

    insertPendingOutcome(db, {
      recallEventId: 'evt-noarch',
      factId: 'f1',
      agentGroupId: 'g1',
      threadId: 'no-archive-thread',
    });
    // No archive response inserted

    setJudgeBackendForTest(async () => JSON.stringify({ scores: [] }));

    const result = await processPendingJudgments({ agentGroupId: 'g1' });
    expect(result.retried).toBe(1);

    const row = db.prepare('SELECT judged_at FROM recall_outcomes WHERE recall_event_id=?').get('evt-noarch') as {
      judged_at: string | null;
    };
    expect(row.judged_at).toBeNull();

    const dlRow = db.prepare('SELECT * FROM dead_letters WHERE item_key LIKE ?').get('%evt-noarch%') as
      | { failure_count: number; item_type: string }
      | undefined;
    expect(dlRow).toBeDefined();
    expect(dlRow!.item_type).toBe('recall-judge');
    expect(dlRow!.failure_count).toBe(1);
  });

  it('test_terminal_failure_after_3_retries', async () => {
    const db = makeIngestDb();
    const archiveDb = makeArchiveDb();
    setJudgeProcessorDbForTest(db);
    setArchiveDbForTest(archiveDb);
    setDeadLettersDb(db);

    insertPendingOutcome(db, {
      recallEventId: 'evt-poison',
      factId: 'f1',
      agentGroupId: 'g1',
      threadId: 'poison-thread',
    });

    // Pre-populate dead_letters to simulate 2 prior failures
    db.prepare(
      `INSERT INTO dead_letters (id, item_type, item_key, agent_group_id, failure_count, last_error, last_attempted_at, next_retry_at, poisoned_at)
       VALUES ('dl-1', 'recall-judge', 'recall-judge:evt-poison', 'g1', 2, 'prior error', datetime('now', '-5 minutes'), datetime('now', '-1 minute'), NULL)`,
    ).run();

    setJudgeBackendForTest(async () => JSON.stringify({ scores: [] }));
    // No archive response → will trigger dead-letter path

    const result = await processPendingJudgments({ agentGroupId: 'g1' });
    expect(result.failed).toBe(1);

    const row = db
      .prepare('SELECT judge_method, judged_at FROM recall_outcomes WHERE recall_event_id=?')
      .get('evt-poison') as { judge_method: string; judged_at: string | null };
    expect(row.judge_method).toBe('judge-failed');
    expect(row.judged_at).not.toBeNull();
  });

  it('test_judge_parse_error_dead_letters', async () => {
    const db = makeIngestDb();
    const archiveDb = makeArchiveDb();
    setJudgeProcessorDbForTest(db);
    setArchiveDbForTest(archiveDb);
    setDeadLettersDb(db);

    const sentAt = new Date(Date.now() - 120_000).toISOString();
    const responseAt = new Date(Date.now() - 60_000).toISOString();
    insertPendingOutcome(db, {
      recallEventId: 'evt-parse-err',
      factId: 'f1',
      agentGroupId: 'g1',
      threadId: 'thread-parse',
      sentAt,
    });
    insertArchiveResponse(archiveDb, {
      agentGroupId: 'g1',
      threadId: 'thread-parse',
      sentAt: responseAt,
      text: 'response',
    });

    setJudgeBackendForTest(async () => 'sorry I cannot help');

    const result = await processPendingJudgments({ agentGroupId: 'g1' });
    expect(result.retried).toBe(1);

    const row = db.prepare('SELECT judged_at FROM recall_outcomes WHERE recall_event_id=?').get('evt-parse-err') as {
      judged_at: string | null;
    };
    expect(row.judged_at).toBeNull();

    const dlRow = db.prepare('SELECT failure_count FROM dead_letters WHERE item_key LIKE ?').get('%evt-parse-err%') as
      | { failure_count: number }
      | undefined;
    expect(dlRow).toBeDefined();
    expect(dlRow!.failure_count).toBe(1);
  });

  it('test_drops_unmatched_fact_ids', async () => {
    const db = makeIngestDb();
    const archiveDb = makeArchiveDb();
    setJudgeProcessorDbForTest(db);
    setArchiveDbForTest(archiveDb);
    setDeadLettersDb(db);

    const sentAt = new Date(Date.now() - 120_000).toISOString();
    const responseAt = new Date(Date.now() - 60_000).toISOString();
    insertPendingOutcome(db, {
      recallEventId: 'evt-phantom',
      factId: 'f1',
      agentGroupId: 'g1',
      threadId: 't-phantom',
      sentAt,
    });
    insertPendingOutcome(db, {
      recallEventId: 'evt-phantom',
      factId: 'f2',
      agentGroupId: 'g1',
      threadId: 't-phantom',
      sentAt,
    });
    insertArchiveResponse(archiveDb, {
      agentGroupId: 'g1',
      threadId: 't-phantom',
      sentAt: responseAt,
      text: 'response text',
    });

    // Judge returns f1, f2, and phantom f3
    setJudgeBackendForTest(async () =>
      JSON.stringify({
        scores: [
          { fact_id: 'f1', score: 2, evidence: 'e1' },
          { fact_id: 'f2', score: 1, evidence: 'e2' },
          { fact_id: 'f3', score: 0, evidence: 'phantom' },
        ],
      }),
    );

    await processPendingJudgments({ agentGroupId: 'g1' });

    // f1 and f2 should be updated; f3 should not exist
    const f1 = db.prepare('SELECT judge_score FROM recall_outcomes WHERE fact_id=?').get('f1') as
      | { judge_score: number }
      | undefined;
    const f2 = db.prepare('SELECT judge_score FROM recall_outcomes WHERE fact_id=?').get('f2') as
      | { judge_score: number }
      | undefined;
    expect(f1!.judge_score).toBe(2);
    expect(f2!.judge_score).toBe(1);
    // f3 should not be in the table
    const f3 = db.prepare('SELECT * FROM recall_outcomes WHERE fact_id=?').get('f3');
    expect(f3).toBeUndefined();
  });

  it('test_response_excerpt_truncation', async () => {
    const db = makeIngestDb();
    const archiveDb = makeArchiveDb();
    setJudgeProcessorDbForTest(db);
    setArchiveDbForTest(archiveDb);
    setDeadLettersDb(db);

    const sentAt = new Date(Date.now() - 120_000).toISOString();
    const responseAt = new Date(Date.now() - 60_000).toISOString();
    const longText = 'A'.repeat(5000) + 'B'.repeat(5000); // 10000 chars
    insertPendingOutcome(db, {
      recallEventId: 'evt-trunc',
      factId: 'f1',
      agentGroupId: 'g1',
      threadId: 't-trunc',
      sentAt,
    });
    insertArchiveResponse(archiveDb, { agentGroupId: 'g1', threadId: 't-trunc', sentAt: responseAt, text: longText });

    let capturedPayload = '';
    setJudgeBackendForTest(async (_sys, user) => {
      capturedPayload = user;
      return JSON.stringify({ scores: [{ fact_id: 'f1', score: 0, evidence: 'no use' }] });
    });

    await processPendingJudgments({ agentGroupId: 'g1' });

    const payload = JSON.parse(capturedPayload) as { agent_response_excerpt: string };
    expect(payload.agent_response_excerpt.length).toBe(4000);
    expect(payload.agent_response_excerpt.slice(0, 10)).toBe('A'.repeat(10)); // starts from beginning
    expect(payload.agent_response_excerpt.slice(-10)).toBe('B'.repeat(10)); // ends at end
  });

  it('test_ambiguity_uses_thread_index', () => {
    const db = makeIngestDb();
    setJudgeProcessorDbForTest(db);

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT DISTINCT recall_event_id FROM recall_outcomes
         WHERE agent_group_id = ? AND trigger_thread_id = ?
           AND judged_at IS NULL
           AND trigger_sent_at >= datetime(?, '-60 seconds')
           AND trigger_sent_at <= datetime(?, '+60 seconds')`,
      )
      .all('g1', 't1', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z') as Array<{ detail: string }>;

    const planText = plan.map((r) => r.detail ?? '').join(' ');
    expect(planText).toMatch(/idx_recall_outcomes_thread/i);
  });
});
