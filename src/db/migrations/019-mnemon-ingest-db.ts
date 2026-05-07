import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../../config.js';
import { runMnemonRecallFeedbackMigration } from './021-mnemon-recall-feedback.js';
import { runMnemonDaemonStateMigration } from './022-mnemon-daemon-state.js';
import { runMnemonRecallFactContentMigration } from './023-mnemon-recall-fact-content.js';

export const MNEMON_INGEST_DB_PATH = path.join(DATA_DIR, 'mnemon-ingest.db');

export function openMnemonIngestDb(dbPath?: string): Database.Database {
  const resolved = dbPath ?? MNEMON_INGEST_DB_PATH;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMnemonIngestMigrations(db: Database.Database): void {
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

  if (!applied.has('mnemon-ingest-db-v1')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS processed_pairs (
          agent_group_id        TEXT NOT NULL,
          user_run_first_id     TEXT NOT NULL,
          classifier_version    TEXT NOT NULL,
          prompt_version        TEXT NOT NULL,
          is_orphan             INTEGER NOT NULL DEFAULT 0,
          user_run_last_id      TEXT,
          assistant_run_first_id TEXT,
          assistant_run_last_id  TEXT,
          classified_at         TEXT NOT NULL,
          facts_written         INTEGER NOT NULL,
          PRIMARY KEY (agent_group_id, user_run_first_id, classifier_version, prompt_version, is_orphan)
        );

        CREATE TABLE IF NOT EXISTS processed_sources (
          agent_group_id     TEXT NOT NULL,
          content_sha256     TEXT NOT NULL,
          extractor_version  TEXT NOT NULL,
          prompt_version     TEXT NOT NULL,
          source_path        TEXT NOT NULL,
          ingested_at        TEXT NOT NULL,
          facts_written      INTEGER NOT NULL,
          PRIMARY KEY (agent_group_id, content_sha256, extractor_version, prompt_version)
        );

        CREATE TABLE IF NOT EXISTS watermarks (
          agent_group_id          TEXT NOT NULL PRIMARY KEY,
          last_classified_sent_at TEXT,
          scan_cursor             TEXT,
          updated_at              TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dead_letters (
          id                TEXT PRIMARY KEY,
          item_type         TEXT NOT NULL,
          item_key          TEXT NOT NULL,
          agent_group_id    TEXT NOT NULL,
          failure_count     INTEGER NOT NULL DEFAULT 0,
          last_error        TEXT,
          last_attempted_at TEXT NOT NULL,
          next_retry_at     TEXT,
          poisoned_at       TEXT,
          payload_json      TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_dead_letters_retry
          ON dead_letters(next_retry_at) WHERE poisoned_at IS NULL;
      `);

      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number })
        .v;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        next,
        'mnemon-ingest-db-v1',
        new Date().toISOString(),
      );
    })();
  }

  if (!applied.has('mnemon-ingest-counters-v2')) {
    db.transaction(() => {
      // Per-pair / per-source instrumentation columns. The chat-pair filter
      // (classifier.ts:364) and source-ingest filter (source-ingest.ts) both
      // gate at importance >= MIN_FACT_IMPORTANCE; without these counters the
      // operator can't see the drop rate by group/path. Codex F1 follow-up:
      // emitted = total facts the classifier produced (pre any filter);
      // dropped_low_importance = facts filtered by the threshold; the existing
      // facts_written column = facts actually stored. Redaction drops can be
      // derived as emitted - facts_written - dropped_low_importance.
      db.exec(`
        ALTER TABLE processed_pairs ADD COLUMN facts_emitted INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE processed_pairs ADD COLUMN facts_dropped_low_importance INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE processed_sources ADD COLUMN facts_emitted INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE processed_sources ADD COLUMN facts_dropped_low_importance INTEGER NOT NULL DEFAULT 0;
      `);

      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number })
        .v;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        next,
        'mnemon-ingest-counters-v2',
        new Date().toISOString(),
      );
    })();
  }

  if (!applied.has('mnemon-idempotency-keys-v1')) {
    db.transaction(() => {
      // action + fact_id are stored so an idempotent replay returns the
      // original successful RememberResult shape (action ∈ {added,updated,
      // replaced}, factId from mnemon). Returning {action:'skipped',
      // factId:''} on replay would be misread by callers as a write
      // failure and lose remaining facts in a multi-fact retry — see
      // mnemon-impl.ts:remember() for the full reasoning.
      db.exec(`
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          agent_group_id  TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          action          TEXT NOT NULL,
          fact_id         TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          PRIMARY KEY (agent_group_id, idempotency_key)
        );

        CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created
          ON idempotency_keys(created_at);
      `);

      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number })
        .v;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        next,
        'mnemon-idempotency-keys-v1',
        new Date().toISOString(),
      );
    })();
  }

  runMnemonRecallFeedbackMigration(db);
  runMnemonDaemonStateMigration(db);
  runMnemonRecallFactContentMigration(db);
}
