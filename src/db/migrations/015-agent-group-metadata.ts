/**
 * Per-agent-group metadata blob (TEXT column holding a JSON object).
 *
 * Used for ad-hoc structured fields that don't justify a dedicated column —
 * the class feature stashes `student_email` + `drive_folder_id` here, future
 * features can reuse the same blob via `setAgentGroupMetadataKey`. Nullable;
 * existing groups have no blob until first write.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'agent-group-metadata',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN metadata TEXT`);
  },
};
