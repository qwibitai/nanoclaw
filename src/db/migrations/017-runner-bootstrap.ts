import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'runner-bootstrap',
  up(db: Database.Database) {
    // Recreate runners with nullable runner_token_hash and new credential-lifecycle columns.
    // SQLite doesn't support ALTER COLUMN, so we rebuild the table.
    db.exec(`
      CREATE TABLE runners_v2 (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL UNIQUE,
        runner_type           TEXT NOT NULL DEFAULT 'persistent',
        runner_token_hash     TEXT,
        bootstrap_token_hash  TEXT,
        bootstrap_expires_at  TEXT,
        bootstrap_used_at     TEXT,
        credential_hash       TEXT,
        credential_rotated_at TEXT,
        status                TEXT NOT NULL DEFAULT 'disconnected',
        last_heartbeat        TEXT,
        runner_version        TEXT,
        protocol_version      TEXT,
        created_at            TEXT NOT NULL
      );

      INSERT INTO runners_v2 (
        id, name, runner_type, runner_token_hash,
        status, last_heartbeat, runner_version, protocol_version, created_at
      )
      SELECT
        id, name, runner_type, runner_token_hash,
        status, last_heartbeat, runner_version, protocol_version, created_at
      FROM runners;

      DROP TABLE runners;
      ALTER TABLE runners_v2 RENAME TO runners;

      CREATE INDEX idx_runners_bootstrap ON runners(bootstrap_token_hash);
      CREATE INDEX idx_runners_credential ON runners(credential_hash);
    `);
  },
};
