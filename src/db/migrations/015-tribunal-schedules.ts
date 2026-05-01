import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'tribunal-schedules',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE agent_groups ADD COLUMN tribunal_schedules TEXT DEFAULT NULL;
    `);
  },
};
