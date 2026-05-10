import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Spawn rework: drop tasks.target_agent_group_id.
 *
 * Phase 1 modeled cross-group dispatch — orchestrator → other agent group. The
 * rework reframes around self-orchestration: parents spawn child sessions in
 * their OWN agent group, sharing workspace/memory/CLAUDE.md/channels. The
 * target column is no longer meaningful (child agent group always equals
 * parent_agent_group_id).
 *
 * SQLite ALTER TABLE DROP COLUMN works directly on plain columns since 3.35;
 * the index on the dropped column is dropped automatically.
 */
export const migration027: Migration = {
  version: 27,
  name: 'drop-tasks-target-agent-group-id',
  up: (db: Database.Database) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_tasks_target_group;
      ALTER TABLE tasks DROP COLUMN target_agent_group_id;
    `);
  },
};
