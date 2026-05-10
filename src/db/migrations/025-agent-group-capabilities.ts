import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration025: Migration = {
  version: 25,
  name: 'agent-group-capabilities',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_group_capabilities (
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        role           TEXT NOT NULL,
        config_json    TEXT,
        granted_by     TEXT REFERENCES users(id),
        granted_at     TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, role)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_group_capabilities_role
        ON agent_group_capabilities(role);
    `);
  },
};
