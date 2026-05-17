import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'runners',
  up(db: Database.Database) {
    // Runner registry: persistent + ephemeral remote execution hosts.
    db.exec(`
      CREATE TABLE IF NOT EXISTS runners (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        runner_type  TEXT NOT NULL DEFAULT 'persistent',
        runner_token_hash TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'disconnected',
        last_heartbeat TEXT,
        runner_version TEXT,
        protocol_version TEXT,
        created_at   TEXT NOT NULL
      );
    `);

    // Agent groups can be assigned to a remote runner.
    // NULL means central-builtin (in-process execution, existing behavior).
    db.prepare('ALTER TABLE agent_groups ADD COLUMN runner_id TEXT REFERENCES runners(id)').run();
  },
};
