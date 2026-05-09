/**
 * `recent_denials` — short-lived memory of admin-rejected approval requests.
 *
 * Without this, an agent that drives its own approvals (today: install_plugin,
 * tomorrow: any agent-initiated self-mod) can wake the admin repeatedly with
 * the same card after a single Deny, because the agent's transcript still
 * shows the install as its last attempt and it has no built-in "denied
 * recently" memory.
 *
 * The approvals primitive consults this table on opt-in calls
 * (`dedupeDenials: true`) and short-circuits with a `notifyAgent` instead of
 * creating a fresh pending row.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'recent-denials',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recent_denials (
        agent_group_id TEXT NOT NULL,
        action_hash    TEXT NOT NULL,
        denied_at      INTEGER NOT NULL,
        denied_by      TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, action_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_recent_denials_denied_at ON recent_denials(denied_at);
    `);
  },
};
