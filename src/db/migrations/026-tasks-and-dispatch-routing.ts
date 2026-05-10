import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration026: Migration = {
  version: 26,
  name: 'tasks-and-dispatch-routing',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id                    TEXT PRIMARY KEY,
        idempotency_key            TEXT NOT NULL,
        parent_session_id          TEXT NOT NULL REFERENCES sessions(id),
        parent_agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id),
        parent_messaging_group_id  TEXT REFERENCES messaging_groups(id),
        target_agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id),
        child_session_id           TEXT REFERENCES sessions(id),
        status                     TEXT NOT NULL DEFAULT 'pending',
        task_content               TEXT NOT NULL,
        request_hash               TEXT NOT NULL,
        deadline                   TEXT,
        parent_platform_message_id TEXT,
        child_platform_thread_id   TEXT,
        child_messaging_group_id   TEXT REFERENCES messaging_groups(id),
        admitted_at                TEXT NOT NULL,
        started_at                 TEXT,
        completed_at               TEXT,
        failed_at                  TEXT,
        cancelled_at               TEXT,
        last_progress_at           TEXT,
        last_progress_message      TEXT,
        fail_reason                TEXT,
        result_summary             TEXT,
        dispatch_completion_attempts INTEGER NOT NULL DEFAULT 0,
        completion_lease_at        TEXT,
        surface_mode               TEXT NOT NULL DEFAULT 'pending'
                                   CHECK (surface_mode IN ('pending', 'native_thread', 'headless')),
        created_at                 TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_parent_session
        ON tasks(parent_session_id);

      CREATE INDEX IF NOT EXISTS idx_tasks_status
        ON tasks(status);

      CREATE INDEX IF NOT EXISTS idx_tasks_target_group
        ON tasks(target_agent_group_id);

      CREATE INDEX IF NOT EXISTS idx_tasks_pending_admitted
        ON tasks(status, admitted_at)
        WHERE status IN ('pending', 'running');

      CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_caller_idempotency
        ON tasks(parent_session_id, idempotency_key);
    `);
  },
};
