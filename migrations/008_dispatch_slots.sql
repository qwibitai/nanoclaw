-- Two-phase slot state machine for parallel dispatch.
-- Replaces the in-memory lockedWorkerSlots Set with durable SQLite rows
-- so slot state survives process restarts and enables crash recovery.
--
-- States:
--   acquiring  → slot claimed, task being set up (createTask + enqueueTask)
--   executing  → container process has started
--   releasing  → container exited, writing results back to Agency HQ
--   free       → slot available (terminal, kept as history)
--
-- The partial unique index enforces single-occupancy per slot:
-- at most one active (acquiring|executing|releasing) row per slot_index.

CREATE TABLE IF NOT EXISTS dispatch_slots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_index    INTEGER NOT NULL,
  ahq_task_id   TEXT    NOT NULL,
  branch_id     TEXT,                      -- task.assigned_to for branch isolation
  local_task_id TEXT    NOT NULL,          -- scheduled_tasks.id
  state         TEXT    NOT NULL
    CHECK(state IN ('acquiring','executing','releasing','free')),
  acquired_at   TEXT    NOT NULL,          -- ISO-8601, set on INSERT
  executing_at  TEXT,                      -- set on transition to 'executing'
  releasing_at  TEXT,                      -- set on transition to 'releasing'
  freed_at      TEXT                       -- set on transition to 'free'
);

-- Enforces single occupancy: only one active row per slot_index.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_dispatch_slots_active
  ON dispatch_slots (slot_index)
  WHERE state IN ('acquiring', 'executing', 'releasing');

-- Fast lookup by AHQ task ID (for stall detector and recovery).
CREATE INDEX IF NOT EXISTS idx_dispatch_slots_ahq_task
  ON dispatch_slots (ahq_task_id);
