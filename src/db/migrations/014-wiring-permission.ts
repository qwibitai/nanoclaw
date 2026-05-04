/**
 * Per-wiring channel permission.
 *
 * `read`        — agent receives inbound from this channel; outbound is skipped.
 * `write`       — agent may send to this channel; inbound is filtered out.
 * `read+write`  — both directions (current behavior, default for existing rows).
 *
 * Enforced in `src/router.ts` (skip inbound on write-only) and
 * `src/delivery.ts` (skip outbound on read-only). The default keeps every
 * pre-existing wiring behaving exactly as before.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'wiring-permission',
  up(db: Database.Database) {
    db.exec(
      `ALTER TABLE messaging_group_agents
         ADD COLUMN permission TEXT NOT NULL DEFAULT 'read+write'
         CHECK (permission IN ('read', 'write', 'read+write'))`,
    );
  },
};
