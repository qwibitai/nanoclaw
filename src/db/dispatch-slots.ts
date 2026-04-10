import Database from 'better-sqlite3';

import { logger } from '../logger.js';

// --- Types ---

export type SlotState = 'acquiring' | 'executing' | 'releasing' | 'free';

export interface SlotRecord {
  id: number;
  slot_index: number;
  ahq_task_id: string;
  branch_id: string | null;
  local_task_id: string;
  worktree_path: string | null;
  state: SlotState;
  acquired_at: string;
  executing_at: string | null;
  releasing_at: string | null;
  freed_at: string | null;
}

// --- Module-level database reference ---

let db: Database.Database;

export function _setDispatchSlotsDb(database: Database.Database): void {
  db = database;
}

// --- Writes ---

/**
 * Attempt to INSERT an acquiring row for the given slot_index.
 * Returns the new row id on success, or null if the slot is occupied
 * (UNIQUE constraint violation) or a branch collision is detected.
 */
export function insertAcquiringSlot(
  slotIndex: number,
  ahqTaskId: string,
  branchId: string | null,
  localTaskId: string,
  worktreePath: string | null,
): number | null {
  // Branch-level isolation: defer if another active row has the same branch_id.
  if (branchId) {
    const conflict = db
      .prepare(
        `SELECT 1 FROM dispatch_slots
         WHERE branch_id = ? AND state IN ('acquiring','executing','releasing')
         LIMIT 1`,
      )
      .get(branchId);
    if (conflict) return null;
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO dispatch_slots
         (slot_index, ahq_task_id, branch_id, local_task_id, worktree_path, state, acquired_at)
         VALUES (?, ?, ?, ?, ?, 'acquiring', ?)`,
      )
      .run(
        slotIndex,
        ahqTaskId,
        branchId,
        localTaskId,
        worktreePath,
        new Date().toISOString(),
      );
    return result.lastInsertRowid as number;
  } catch {
    // Unique constraint: slot occupied
    return null;
  }
}

/**
 * Transition a slot from acquiring → executing.
 * Records the executing_at timestamp.
 */
export function transitionToExecuting(slotId: number): void {
  db.prepare(
    `UPDATE dispatch_slots
     SET state = 'executing', executing_at = ?
     WHERE id = ? AND state = 'acquiring'`,
  ).run(new Date().toISOString(), slotId);
}

/**
 * Transition a slot from executing → releasing.
 * Records the releasing_at timestamp.
 */
export function transitionToReleasing(slotId: number): void {
  db.prepare(
    `UPDATE dispatch_slots
     SET state = 'releasing', releasing_at = ?
     WHERE id = ? AND state = 'executing'`,
  ).run(new Date().toISOString(), slotId);
}

/**
 * Transition a slot to free from any active state.
 * Records the freed_at timestamp. Used in finally blocks and error paths.
 */
export function transitionToFree(slotId: number): void {
  db.prepare(
    `UPDATE dispatch_slots
     SET state = 'free', freed_at = ?
     WHERE id = ? AND state IN ('acquiring','executing','releasing')`,
  ).run(new Date().toISOString(), slotId);
}

// --- Reads ---

/** Get all slots currently in an active (non-free) state. */
export function getActiveSlots(): SlotRecord[] {
  return db
    .prepare(
      `SELECT * FROM dispatch_slots
       WHERE state IN ('acquiring','executing','releasing')
       ORDER BY acquired_at ASC`,
    )
    .all() as SlotRecord[];
}

/** Get the active slot for a given AHQ task ID, or null if none. */
export function getActiveSlotForTask(ahqTaskId: string): SlotRecord | null {
  return (
    (db
      .prepare(
        `SELECT * FROM dispatch_slots
         WHERE ahq_task_id = ? AND state IN ('acquiring','executing','releasing')
         LIMIT 1`,
      )
      .get(ahqTaskId) as SlotRecord | undefined) ?? null
  );
}

// --- Recovery ---

/**
 * Stale slot thresholds.
 * Slots stuck in 'acquiring' beyond ACQUIRING_STALE_MS are assumed to be
 * from a crash between claimSlot() and enqueueTask().
 * Slots stuck in 'executing' or 'releasing' beyond EXECUTING_STALE_MS with
 * a dead local task are assumed to be from a SIGKILL or crash mid-execution.
 */
export const ACQUIRING_STALE_MS = 2 * 60_000; // 2 minutes
export const EXECUTING_STALE_MS = 4 * 60 * 60_000; // 4 hours (very long tasks)

export interface StaleSlotResult {
  slotId: number;
  ahqTaskId: string;
  state: SlotState;
  worktreePath: string | null;
  reason: string;
}

/**
 * Find and free stale slots, returning records so callers can re-queue the
 * associated Agency HQ tasks.
 *
 * Stale criteria:
 *  - 'acquiring' slots older than ACQUIRING_STALE_MS (crash before enqueue)
 *  - 'executing'/'releasing' slots whose local_task_id is no longer active
 *    in scheduled_tasks (container exited, process crashed before cleanup)
 */
export function recoverStaleSlotRecords(): StaleSlotResult[] {
  const now = new Date().toISOString();
  const results: StaleSlotResult[] = [];

  // --- Stale acquiring slots ---
  const staleAcquiringCutoff = new Date(
    Date.now() - ACQUIRING_STALE_MS,
  ).toISOString();

  const staleAcquiring = db
    .prepare(
      `SELECT * FROM dispatch_slots
       WHERE state = 'acquiring' AND acquired_at < ?`,
    )
    .all(staleAcquiringCutoff) as SlotRecord[];

  for (const slot of staleAcquiring) {
    db.prepare(
      `UPDATE dispatch_slots SET state = 'free', freed_at = ? WHERE id = ?`,
    ).run(now, slot.id);

    results.push({
      slotId: slot.id,
      ahqTaskId: slot.ahq_task_id,
      state: slot.state,
      worktreePath: slot.worktree_path ?? null,
      reason: `stuck in acquiring for >${ACQUIRING_STALE_MS / 1000}s`,
    });

    logger.warn(
      {
        slotId: slot.id,
        slotIndex: slot.slot_index,
        ahqTaskId: slot.ahq_task_id,
        acquiredAt: slot.acquired_at,
      },
      'Recovered stale acquiring slot',
    );
  }

  // --- Stale executing/releasing slots with dead local tasks ---
  const staleExecReleasing = db
    .prepare(
      `SELECT ds.* FROM dispatch_slots ds
       LEFT JOIN scheduled_tasks st ON st.id = ds.local_task_id
       WHERE ds.state IN ('executing','releasing')
         AND (st.id IS NULL OR st.status != 'active')`,
    )
    .all() as SlotRecord[];

  for (const slot of staleExecReleasing) {
    db.prepare(
      `UPDATE dispatch_slots SET state = 'free', freed_at = ? WHERE id = ?`,
    ).run(now, slot.id);

    results.push({
      slotId: slot.id,
      ahqTaskId: slot.ahq_task_id,
      state: slot.state,
      worktreePath: slot.worktree_path ?? null,
      reason: `local task ${slot.local_task_id} no longer active (state: ${slot.state})`,
    });

    logger.warn(
      {
        slotId: slot.id,
        slotIndex: slot.slot_index,
        ahqTaskId: slot.ahq_task_id,
        localTaskId: slot.local_task_id,
        prevState: slot.state,
      },
      'Recovered stale executing/releasing slot (local task dead)',
    );
  }

  return results;
}

/** Delete old free rows (history pruning). Keeps the last 7 days. */
export function pruneFreedSlots(): number {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const result = db
    .prepare(`DELETE FROM dispatch_slots WHERE state = 'free' AND freed_at < ?`)
    .run(cutoff);
  return result.changes;
}
