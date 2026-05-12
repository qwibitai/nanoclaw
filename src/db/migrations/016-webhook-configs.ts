import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'webhook-configs',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE webhook_configs (
        messaging_group_id        TEXT PRIMARY KEY REFERENCES messaging_groups(id) ON DELETE CASCADE,
        secret                    TEXT NOT NULL,
        auth_mode                 TEXT NOT NULL DEFAULT 'bearer',
        body_format               TEXT NOT NULL DEFAULT 'json',
        default_reply_destination TEXT,
        rate_limit_per_min        INTEGER NOT NULL DEFAULT 60,
        created_at                TEXT NOT NULL,
        updated_at                TEXT NOT NULL
      );
    `);
  },
};
