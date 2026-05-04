/**
 * Trigger that auto-flips a bot pool row back to `'available'` when
 * its assigned agent_group is hard-deleted.
 *
 * Migration 016 declared the FK as `ON DELETE SET NULL`, so a hard
 * DELETE on `agent_groups` (operator cleanup) clears
 * `assigned_agent_group_id` on the matching pool row. Without this
 * trigger, the row was left in a permanently-orphaned state:
 * `status='assigned'`, no owner, invisible to `assignNextAvailableBot`
 * (which filters on `status='available'`). The pool would silently
 * shrink in capacity each time an operator hard-deleted an
 * agent_group. Codex P2 catch.
 *
 * Why a trigger and not a follow-up UPDATE in `releaseBot`:
 *   `releaseBot` is the SOFT-delete path — it's called explicitly by
 *   the disconnect handler with the agent_group_id in hand. The
 *   missing case is HARD delete: someone DELETEs from `agent_groups`
 *   directly (operator cleanup script, future migration, etc.) and
 *   `releaseBot` is never invoked. The trigger fires inside SQLite
 *   itself so the orphan state can never persist regardless of who
 *   issued the DELETE.
 *
 * Trigger scope: AFTER UPDATE OF `assigned_agent_group_id` WHEN the
 * column transitions from NOT NULL to NULL. We don't need to fire
 * on writes that go from one non-NULL value to another (no such
 * writes exist today, but the WHEN guard makes the trigger
 * forward-safe). The trigger also fires when `releaseBot` does its
 * own UPDATE — that's harmless because the trigger sets status to
 * 'available' and clears assigned_at, which is exactly what
 * releaseBot was already doing (the trigger re-asserts the same
 * values, idempotent).
 *
 * `assigned_at` is also nulled by the trigger to keep the row's
 * audit columns coherent: an `'available'` row with a stale
 * assigned_at would mislead pool inspections.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'baget-bot-pool-orphan-trigger',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_bot_pool_release_on_orphan
        AFTER UPDATE OF assigned_agent_group_id ON baget_bot_pool
        WHEN NEW.assigned_agent_group_id IS NULL
         AND OLD.assigned_agent_group_id IS NOT NULL
      BEGIN
        UPDATE baget_bot_pool
           SET status      = 'available',
               assigned_at = NULL
         WHERE bot_username = NEW.bot_username
           AND status = 'assigned';
      END;
    `);
  },
};
