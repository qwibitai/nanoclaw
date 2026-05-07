import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMnemonIngestMigrations } from './019-mnemon-ingest-db.js';
import { runMnemonRecallFactContentMigration } from './023-mnemon-recall-fact-content.js';

let db: Database.Database | null = null;

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
});

function makeDb(): Database.Database {
  return new Database(':memory:');
}

describe('023-mnemon-recall-fact-content', () => {
  it('adds fact_content_excerpt column with empty default', () => {
    db = makeDb();
    runMnemonIngestMigrations(db);
    runMnemonRecallFactContentMigration(db);

    const cols = db.prepare(`PRAGMA table_info(recall_outcomes)`).all() as {
      name: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const fce = cols.find((c) => c.name === 'fact_content_excerpt');
    expect(fce).toBeDefined();
    expect(fce!.notnull).toBe(1);
    expect(fce!.dflt_value).toBe("''");
  });

  it('is idempotent — second run is a no-op', () => {
    db = makeDb();
    runMnemonIngestMigrations(db);
    runMnemonRecallFactContentMigration(db);
    runMnemonRecallFactContentMigration(db);

    const versions = db
      .prepare(`SELECT name FROM schema_version WHERE name = 'mnemon-recall-fact-content-v1'`)
      .all() as { name: string }[];
    expect(versions.length).toBe(1);
  });

  it('preserves existing recall_outcomes rows during ALTER', () => {
    db = makeDb();
    runMnemonIngestMigrations(db);

    const insertBefore = db.prepare(`
      INSERT INTO recall_outcomes (recall_event_id, fact_id, judge_prompt_version, agent_group_id, query_strategy, trigger_sent_at, created_at, judge_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertBefore.run('e1', 'f1', 'v1', 'g1', 'raw', '2026-05-07T00:00:00Z', '2026-05-07T00:00:00Z', 'pending');

    runMnemonRecallFactContentMigration(db);

    const rows = db.prepare(`SELECT recall_event_id, fact_id, fact_content_excerpt FROM recall_outcomes`).all() as {
      recall_event_id: string;
      fact_id: string;
      fact_content_excerpt: string;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.fact_content_excerpt).toBe('');
  });

  it('schema_version row records new migration', () => {
    db = makeDb();
    runMnemonIngestMigrations(db);
    runMnemonRecallFactContentMigration(db);

    const row = db
      .prepare(`SELECT version, name FROM schema_version WHERE name = 'mnemon-recall-fact-content-v1'`)
      .get() as { version: number; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('mnemon-recall-fact-content-v1');
  });
});
