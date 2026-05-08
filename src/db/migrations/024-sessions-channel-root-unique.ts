import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Enforce one active channel-root session per (agent_group_id, messaging_group_id).
 *
 * Scheduled tasks live in the channel-root session — `thread_id IS NULL` is the
 * load-bearing filter (`src/db/sessions.ts:findSessionByAgentGroupAndMessagingGroup`).
 * `resolveActiveSession` does lookup-then-insert with no concurrency guard, so
 * two simultaneous schedule_task calls from different thread containers can
 * race and create duplicate channel-root sessions, after which `list_tasks`
 * silently sees only one of the two task piles.
 *
 * Step 1: dedupe existing duplicates. Keep the most recently active row,
 * archive the others. The keeper is the row most likely to hold the live
 * task pile.
 *
 * Step 2: add a partial unique index. SQLite treats NULLs as distinct in
 * UNIQUE indexes, so agent-shared sessions (messaging_group_id IS NULL) are
 * not constrained — only true channel-root rows with a non-null MG are.
 */
export const migration024: Migration = {
  version: 24,
  name: 'sessions-channel-root-unique',
  up: (db: Database.Database) => {
    const dups = db
      .prepare(
        `SELECT agent_group_id, messaging_group_id
           FROM sessions
          WHERE thread_id IS NULL AND status = 'active' AND messaging_group_id IS NOT NULL
          GROUP BY agent_group_id, messaging_group_id
          HAVING COUNT(*) > 1`,
      )
      .all() as Array<{ agent_group_id: string; messaging_group_id: string }>;

    for (const { agent_group_id, messaging_group_id } of dups) {
      const rows = db
        .prepare(
          `SELECT id
             FROM sessions
            WHERE agent_group_id = ? AND messaging_group_id = ?
              AND thread_id IS NULL AND status = 'active'
            ORDER BY COALESCE(last_active, created_at) DESC, created_at DESC, id ASC`,
        )
        .all(agent_group_id, messaging_group_id) as Array<{ id: string }>;
      const [, ...archive] = rows;
      for (const a of archive) {
        db.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(a.id);
      }
    }

    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS sessions_channel_root_unique
         ON sessions(agent_group_id, messaging_group_id)
         WHERE thread_id IS NULL AND status = 'active' AND messaging_group_id IS NOT NULL`,
    );
  },
};
