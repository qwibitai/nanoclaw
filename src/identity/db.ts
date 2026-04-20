import type Database from 'better-sqlite3';

export function applyIdentitySchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS people (
      canonical_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS person_channels (
      channel TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      canonical_id TEXT NOT NULL REFERENCES people(canonical_id) ON DELETE CASCADE,
      PRIMARY KEY (channel, channel_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_person_channels_canonical ON person_channels(canonical_id);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      canonical_id TEXT,
      capability TEXT,
      decision TEXT NOT NULL,
      context TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_canonical_id ON audit_log(canonical_id);
  `);
}
