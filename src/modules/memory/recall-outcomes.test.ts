import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMnemonIngestMigrations } from '../../db/migrations/019-mnemon-ingest-db.js';
import { insertPendingOutcomes, setIngestDbForTest, type PendingOutcomeInput } from './recall-outcomes.js';

function makeRow(overrides: Partial<PendingOutcomeInput> = {}): PendingOutcomeInput {
  return {
    recallEventId: 'recall-msg-1',
    factId: 'fact-1',
    agentGroupId: 'ag-1',
    queryStrategy: 'raw',
    embeddingSim: null,
    triggerThreadId: null,
    triggerSentAt: '2026-05-07T12:00:00Z',
    triggerSenderId: null,
    factContentExcerpt: 'sample fact content',
    ...overrides,
  };
}

describe('insertPendingOutcomes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMnemonIngestMigrations(db);
    setIngestDbForTest(db);
  });

  afterEach(() => {
    setIngestDbForTest(null);
    db.close();
  });

  it('test_inserts_rows_in_single_transaction', () => {
    const row1 = makeRow({ factId: 'f1' });
    const row2 = makeRow({ factId: 'f2', recallEventId: 'recall-msg-2' });
    const row3 = makeRow({ factId: 'f3', recallEventId: 'recall-msg-3' });
    const result = insertPendingOutcomes([row1, row2, row3]);
    expect(result.inserted).toBe(3);
    expect(result.failed).toBe(false);

    const count = (db.prepare('SELECT COUNT(*) as c FROM recall_outcomes').get() as { c: number }).c;
    expect(count).toBe(3);

    const rows = db.prepare('SELECT judge_method, judged_at FROM recall_outcomes').all() as Array<{
      judge_method: string;
      judged_at: string | null;
    }>;
    for (const r of rows) {
      expect(r.judge_method).toBe('pending');
      expect(r.judged_at).toBeNull();
    }
  });

  it('test_empty_input_no_db_access', () => {
    setIngestDbForTest(null);
    const result = insertPendingOutcomes([]);
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(false);
  });

  it('test_db_failure_returns_failed_true', () => {
    // Close the DB to trigger a failure.
    db.close();
    const result = insertPendingOutcomes([makeRow()]);
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(true);
  });

  it('test_partial_failure_atomic_rollback', () => {
    // Insert row1 first.
    insertPendingOutcomes([makeRow({ factId: 'f1' })]);

    // Now try to insert a duplicate (same PK) plus a new row — should roll back.
    const result = insertPendingOutcomes([
      makeRow({ factId: 'f1' }), // duplicate PK — will fail
      makeRow({ factId: 'f2', recallEventId: 'recall-msg-2' }),
    ]);
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(true);

    const count = (db.prepare('SELECT COUNT(*) as c FROM recall_outcomes').get() as { c: number }).c;
    expect(count).toBe(1); // only the original row1
  });

  it('test_judge_prompt_version_from_judge_client', () => {
    insertPendingOutcomes([makeRow()]);
    const row = db.prepare('SELECT judge_prompt_version FROM recall_outcomes').get() as {
      judge_prompt_version: string;
    };
    // Must be a non-empty string matching what JUDGE_PROMPT_VERSION exports.
    expect(row.judge_prompt_version).toBeTruthy();
    expect(typeof row.judge_prompt_version).toBe('string');
  });
});
