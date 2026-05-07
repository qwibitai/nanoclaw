import Database from 'better-sqlite3';

export function runMnemonRecallFeedbackMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);

  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
  );

  if (!applied.has('mnemon-recall-feedback-v1')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS recall_outcomes (
          recall_event_id      TEXT NOT NULL,
          fact_id              TEXT NOT NULL,
          judge_prompt_version TEXT NOT NULL,
          agent_group_id       TEXT NOT NULL,
          query_strategy       TEXT NOT NULL,
          embedding_sim        REAL,
          trigger_thread_id    TEXT,
          trigger_sent_at      TEXT NOT NULL,
          trigger_sender_id    TEXT,
          judge_score          INTEGER,
          judge_method         TEXT,
          judge_model          TEXT,
          judge_evidence       TEXT,
          response_excerpt_sha TEXT,
          created_at           TEXT NOT NULL,
          judged_at            TEXT,
          PRIMARY KEY (recall_event_id, fact_id, judge_prompt_version)
        );

        CREATE INDEX IF NOT EXISTS idx_recall_outcomes_pending
          ON recall_outcomes(agent_group_id, created_at)
          WHERE judged_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_recall_outcomes_recent
          ON recall_outcomes(agent_group_id, judged_at)
          WHERE judged_at IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_recall_outcomes_thread
          ON recall_outcomes(agent_group_id, trigger_thread_id, trigger_sent_at)
          WHERE judged_at IS NULL;
      `);

      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number })
        .v;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        next,
        'mnemon-recall-feedback-v1',
        new Date().toISOString(),
      );
    })();
  }
}
