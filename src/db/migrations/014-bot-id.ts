import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'messaging-groups-bot-id',
  up(db: Database.Database) {
    // SQLite can't ALTER TABLE to drop or modify a UNIQUE constraint, so we
    // recreate the table with the new schema: bot_id column + new unique
    // constraint on (channel_type, platform_id, bot_id).
    db.exec(`
      CREATE TABLE messaging_groups_new (
        id                    TEXT PRIMARY KEY,
        channel_type          TEXT NOT NULL,
        platform_id           TEXT NOT NULL,
        bot_id                TEXT,
        name                  TEXT,
        is_group              INTEGER DEFAULT 0,
        unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
        created_at            TEXT NOT NULL,
        denied_at             TEXT,
        UNIQUE(channel_type, platform_id, bot_id)
      );

      INSERT INTO messaging_groups_new (id, channel_type, platform_id, bot_id, name, is_group, unknown_sender_policy, created_at, denied_at)
        SELECT id, channel_type, platform_id, NULL, name, is_group, unknown_sender_policy, created_at, denied_at
          FROM messaging_groups;

      DROP TABLE messaging_groups;
      ALTER TABLE messaging_groups_new RENAME TO messaging_groups;

      -- SQLite treats NULLs as distinct in UNIQUE constraints, so the
      -- table-level UNIQUE(channel_type, platform_id, bot_id) doesn't
      -- prevent duplicate (channel_type, platform_id) rows when bot_id
      -- is NULL. This partial index preserves the old single-bot uniqueness.
      CREATE UNIQUE INDEX uq_messaging_groups_no_bot
        ON messaging_groups (channel_type, platform_id) WHERE bot_id IS NULL;
    `);
  },
};
