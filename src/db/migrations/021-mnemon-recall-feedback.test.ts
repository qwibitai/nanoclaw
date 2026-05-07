import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMnemonIngestMigrations } from './019-mnemon-ingest-db.js';
import { runMnemonRecallFeedbackMigration } from './021-mnemon-recall-feedback.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

const dbs: Database.Database[] = [];
function tracked(db: Database.Database): Database.Database {
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  dbs.length = 0;
});

describe('migration 021: mnemon-recall-feedback', () => {
  it('test_migration_creates_table', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    runMnemonRecallFeedbackMigration(db);

    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='recall_outcomes'`).get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe('recall_outcomes');

    const versionRow = db.prepare(`SELECT name FROM schema_version WHERE name='mnemon-recall-feedback-v1'`).get() as
      | { name: string }
      | undefined;
    expect(versionRow?.name).toBe('mnemon-recall-feedback-v1');
  });

  it('test_migration_is_idempotent', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    runMnemonRecallFeedbackMigration(db);
    expect(() => runMnemonRecallFeedbackMigration(db)).not.toThrow();

    const count = (
      db.prepare(`SELECT COUNT(*) AS c FROM schema_version WHERE name='mnemon-recall-feedback-v1'`).get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);
  });

  it('test_pending_index_filters_correctly', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    runMnemonRecallFeedbackMigration(db);

    const now = new Date().toISOString();
    const judgedAt = new Date(Date.now() - 1000).toISOString();

    db.prepare(
      `
      INSERT INTO recall_outcomes
        (recall_event_id, fact_id, judge_prompt_version, agent_group_id, query_strategy,
         trigger_sent_at, created_at, judged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('evt-1', 'fact-1', 'v1', 'ag-1', 'raw', now, now, null);

    db.prepare(
      `
      INSERT INTO recall_outcomes
        (recall_event_id, fact_id, judge_prompt_version, agent_group_id, query_strategy,
         trigger_sent_at, created_at, judged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('evt-2', 'fact-2', 'v1', 'ag-1', 'raw', now, now, judgedAt);

    // Force the pending index explicitly — without INDEXED BY, the planner may
    // prefer idx_recall_outcomes_thread (also covers judged_at IS NULL).
    // The goal is to verify the index exists and is structurally usable.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM recall_outcomes INDEXED BY idx_recall_outcomes_pending WHERE agent_group_id=? AND judged_at IS NULL`,
      )
      .all('ag-1') as { detail: string }[];

    const planText = plan.map((r) => r.detail).join(' ');
    expect(planText).toContain('idx_recall_outcomes_pending');
  });

  it('test_no_decided_at_column', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    runMnemonRecallFeedbackMigration(db);

    const cols = (db.prepare(`PRAGMA table_info(recall_outcomes)`).all() as { name: string }[]).map((r) => r.name);
    expect(cols).not.toContain('decided_at');
  });

  it('test_pk_includes_judge_prompt_version', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    runMnemonRecallFeedbackMigration(db);

    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO recall_outcomes
        (recall_event_id, fact_id, judge_prompt_version, agent_group_id, query_strategy,
         trigger_sent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('evt-1', 'fact-1', 'v1', 'ag-1', 'raw', now, now);

    // Same recall_event_id + fact_id but different judge_prompt_version — must not conflict
    expect(() => {
      db.prepare(
        `
        INSERT INTO recall_outcomes
          (recall_event_id, fact_id, judge_prompt_version, agent_group_id, query_strategy,
           trigger_sent_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run('evt-1', 'fact-1', 'v2', 'ag-1', 'raw', now, now);
    }).not.toThrow();

    const count = (db.prepare('SELECT COUNT(*) AS c FROM recall_outcomes').get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('test_all_columns_present', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    runMnemonRecallFeedbackMigration(db);

    const cols = (db.prepare(`PRAGMA table_info(recall_outcomes)`).all() as { name: string }[]).map((r) => r.name);
    const expected = [
      // 021 columns (16):
      'recall_event_id',
      'fact_id',
      'judge_prompt_version',
      'agent_group_id',
      'query_strategy',
      'embedding_sim',
      'trigger_thread_id',
      'trigger_sent_at',
      'trigger_sender_id',
      'judge_score',
      'judge_method',
      'judge_model',
      'judge_evidence',
      'response_excerpt_sha',
      'created_at',
      'judged_at',
      // 023 column (1):
      'fact_content_excerpt',
    ];
    for (const col of expected) {
      expect(cols).toContain(col);
    }
    expect(cols.length).toBe(expected.length);
  });
});
