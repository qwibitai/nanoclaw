import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Dashboard tables.
 *
 * dashboard_tokens: stores HMAC-of-token (NOT raw bearer), one-time-use
 * gate for the browser auth flow.
 *
 * steer_idempotency: deduplicates steer write requests per (user, key) with
 * body binding (request_hash) and echo gating (echo_attempted).
 */
export const migration028: Migration = {
  version: 28,
  name: 'dashboard-tables',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE dashboard_tokens (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT NOT NULL REFERENCES users(id),
        token_hmac  TEXT NOT NULL UNIQUE,
        issued_at   TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        used_at     TEXT
      );
      CREATE INDEX idx_dashboard_tokens_unused
        ON dashboard_tokens(user_id, expires_at)
        WHERE used_at IS NULL;

      CREATE TABLE steer_idempotency (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         TEXT NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL,
        task_id         TEXT NOT NULL,
        message_id      TEXT NOT NULL,
        text            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        reserved_at     TEXT NOT NULL,
        applied_at      TEXT,
        cached_response TEXT,
        echo_attempted  INTEGER NOT NULL DEFAULT 0,
        request_hash    TEXT NOT NULL,
        UNIQUE(user_id, idempotency_key)
      );
      CREATE INDEX idx_steer_idempotency_age
        ON steer_idempotency(reserved_at);
    `);
  },
};
