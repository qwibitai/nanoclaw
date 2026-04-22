/**
 * DispatchPool — durable two-phase slot state machine for parallel dispatch.
 *
 * ## Backends
 *
 * Two backends are supported, selected by the DISPATCH_SLOTS_PG environment
 * variable:
 *
 *   DISPATCH_SLOTS_PG=false (default)
 *     SQLite-backed slots using a partial unique index.  Requires NanoClaw's
 *     local dispatch_slots table (migration 008_dispatch_slots.sql).
 *
 *   DISPATCH_SLOTS_PG=true
 *     PostgreSQL-backed slots via Agency HQ's /api/v1/dispatch-slots HTTP API.
 *     Uses SELECT ... FOR UPDATE SKIP LOCKED for atomic slot acquisition:
 *       - Two concurrent processes cannot claim the same slot.
 *       - Crash recovery: orphaned locks are released on next startup via
 *         reconcileStaleSlots().
 *       - No deadlock: SKIP LOCKED never waits, just skips occupied rows.
 *       - pgBouncer transaction mode safe: each acquisition is a short,
 *         self-contained transaction.
 *     Requires migration 1710600026000_add-dispatch-slots-table.ts to be
 *     applied to Agency HQ's PostgreSQL database before enabling.
 *
 * States:  acquiring → executing → releasing → free
 *
 * Failure modes handled:
 *  - Crash in acquiring: slot recovered on next startup via recoverStaleSlots()
 *  - SIGKILL in executing: local task goes non-active; recovery frees slot
 *  - Crash in releasing: local task goes non-active; recovery frees slot
 *
 * All transitions are logged with task_id and timestamp.
 */

import { agencyFetch } from './agency-hq-client.js';
import {
  getDispatchSlotBackend,
  isDispatchSlotsPgEnabled,
  PARALLEL_DISPATCH_WORKERS,
  workerSlotJid,
  type ActiveSlotInfo,
  type RecoveredSlotInfo,
  type SlotClaim,
} from './dispatch-slot-backends.js';
import { getActiveSlots, type SlotRecord } from './db/dispatch-slots.js';
import { createCorrelationLogger, logger } from './logger.js';
import { cleanupOrphanedWorktrees } from './worktree-manager.js';

/**
 * Task statuses that indicate the work is finished — the slot should be freed
 * without requeuing the task back to 'ready'.
 */
const TERMINAL_TASK_STATUSES = new Set(['in-review', 'done', 'cancelled']);

export { isDispatchSlotsPgEnabled, PARALLEL_DISPATCH_WORKERS, workerSlotJid };
export type { SlotClaim };

function currentBackendName(): 'sqlite' | 'pg' {
  return getDispatchSlotBackend().name;
}

async function requeueAgencyTask(
  ahqTaskId: string,
  log: ReturnType<typeof createCorrelationLogger>,
  reason: string,
): Promise<void> {
  try {
    const res = await agencyFetch(`/tasks/${ahqTaskId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'ready' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error(
        { status: res.status, body, ahqTaskId, reason },
        'Failed to re-queue AHQ task',
      );
      return;
    }

    log.info({ ahqTaskId, reason }, 'AHQ task re-queued');
  } catch (err) {
    log.error({ err, ahqTaskId, reason }, 'Error re-queuing AHQ task');
  }
}

/**
 * Query Agency HQ for the current status of a task.
 * Returns the status string on success, or null on any failure.
 */
async function queryTaskStatus(
  ahqTaskId: string,
  log: ReturnType<typeof createCorrelationLogger>,
): Promise<string | null> {
  try {
    const res = await agencyFetch(`/tasks/${ahqTaskId}`);
    if (!res.ok) {
      log.warn(
        { ahqTaskId, status: res.status },
        'Failed to query Agency HQ task status',
      );
      return null;
    }
    const json = (await res.json()) as { data?: { status?: string } };
    return json.data?.status ?? null;
  } catch (err) {
    log.warn(
      { err, ahqTaskId },
      'Error querying Agency HQ task status',
    );
    return null;
  }
}

async function listActiveSlotSnapshot(
  log: ReturnType<typeof createCorrelationLogger>,
): Promise<ActiveSlotInfo[]> {
  try {
    return await getDispatchSlotBackend().listActiveSlots();
  } catch (err) {
    log.error({ err }, 'Failed to query active dispatch slots');
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- DispatchPool ---

/**
 * Attempt to claim the next free slot for the given task.
 *
 * PG backend: calls Agency HQ's /api/v1/dispatch-slots/claim which uses
 * SELECT ... FOR UPDATE SKIP LOCKED — two concurrent callers cannot claim
 * the same slot.
 *
 * SQLite backend (default): tries slots 0..N-1 in order; the first INSERT
 * that doesn't violate the partial unique index wins.
 *
 * Branch isolation is checked in both backends: two tasks with the same
 * branch_id may not occupy slots simultaneously.
 *
 * Returns a SlotClaim on success, or null if all slots are busy / branch
 * collision detected.
 */
export async function claimSlot(
  ahqTaskId: string,
  branchId: string | null,
  localTaskId: string,
  worktreePath: string | null,
): Promise<SlotClaim | null> {
  const backend = getDispatchSlotBackend();
  const claim = await backend.claimSlot(
    ahqTaskId,
    branchId,
    localTaskId,
    worktreePath,
  );
  if (claim) {
    logger.info(
      {
        slotId: claim.slotId,
        slotIndex: claim.slotIndex,
        ahqTaskId,
        branchId,
        worktreePath,
        state: 'acquiring',
        backend: backend.name,
        timestamp: new Date().toISOString(),
      },
      '[slot] acquiring',
    );
  }

  return claim;
}

/**
 * Transition slot from acquiring → executing.
 * Call when the container process has started (onProcess callback).
 */
export async function markSlotExecuting(
  slotId: number,
  ahqTaskId: string,
): Promise<void> {
  await getDispatchSlotBackend().markExecuting(slotId);
  logger.info(
    {
      slotId,
      ahqTaskId,
      state: 'executing',
      backend: currentBackendName(),
      timestamp: new Date().toISOString(),
    },
    '[slot] executing',
  );
}

/**
 * Transition slot from executing → releasing.
 * Call when the container has exited (before writing results to Agency HQ).
 */
export async function markSlotReleasing(
  slotId: number,
  ahqTaskId: string,
): Promise<void> {
  await getDispatchSlotBackend().markReleasing(slotId);
  logger.info(
    {
      slotId,
      ahqTaskId,
      state: 'releasing',
      backend: currentBackendName(),
      timestamp: new Date().toISOString(),
    },
    '[slot] releasing',
  );
}

/**
 * Transition slot to free from any active state.
 * Call in finally blocks after results are written (or on any error path).
 */
export async function freeSlot(
  slotId: number,
  ahqTaskId: string,
): Promise<void> {
  await getDispatchSlotBackend().freeSlot(slotId);
  logger.info(
    {
      slotId,
      ahqTaskId,
      state: 'free',
      backend: currentBackendName(),
      timestamp: new Date().toISOString(),
    },
    '[slot] free',
  );
}

// --- Startup recovery ---

/**
 * Recover stale slots left behind by crashes or SIGKILL.
 * Should be called once at startup before the dispatch loop begins.
 *
 * PG backend: calls Agency HQ's /api/v1/dispatch-slots/reconcile, then
 * re-queues each freed AHQ task to 'ready'.
 *
 * SQLite backend: uses timestamp-based stale detection on the local DB.
 *
 * For each recovered slot, re-queues the Agency HQ task (PUT status→ready)
 * so it will be dispatched again on the next tick.
 */
export async function recoverStaleSlots(): Promise<void> {
  const log = createCorrelationLogger(undefined, { op: 'slot-recovery' });

  let staleRecords: RecoveredSlotInfo[];
  try {
    staleRecords = await getDispatchSlotBackend().recoverStaleSlots();
  } catch (err) {
    log.error({ err }, 'Failed to query stale dispatch slots');
    return;
  }

  if (staleRecords.length === 0) return;

  log.info(
    { count: staleRecords.length, backend: currentBackendName() },
    'Recovering stale dispatch slots',
  );

  // Clean up any orphaned worktrees from crashed dispatches before re-queuing.
  const orphanedWorktrees = staleRecords.map((r) => r.worktreePath);
  if (orphanedWorktrees.some((wt) => wt !== null)) {
    try {
      cleanupOrphanedWorktrees(process.cwd(), orphanedWorktrees);
    } catch (err) {
      log.warn(
        { err },
        'Failed to clean up orphaned worktrees during recovery',
      );
    }
  }

  for (const record of staleRecords) {
    // Check Agency HQ task status before requeuing — if the task has already
    // reached a terminal state (done, in-review, cancelled), the worker
    // finished normally and we should just free the slot without resetting
    // the task back to 'ready'.
    const taskStatus = await queryTaskStatus(record.ahqTaskId, log);
    if (taskStatus && TERMINAL_TASK_STATUSES.has(taskStatus)) {
      log.info(
        {
          slotId: record.slotId,
          ahqTaskId: record.ahqTaskId,
          taskStatus,
          prevState: record.state,
        },
        'Stale slot task is in terminal state, freeing slot without requeue',
      );
      continue;
    }

    log.warn(
      {
        slotId: record.slotId,
        ahqTaskId: record.ahqTaskId,
        prevState: record.state,
        worktreePath: record.worktreePath,
        reason: record.reason,
      },
      'Freed stale slot, re-queuing AHQ task',
    );

    await requeueAgencyTask(record.ahqTaskId, log, 'slot recovery');
  }

  // Prune old history rows while we're at it.
  try {
    const pruned = getDispatchSlotBackend().pruneHistory();
    if (pruned > 0) {
      log.info({ pruned }, 'Pruned old free slot history rows');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to prune freed slot rows');
  }
}

// --- Graceful drain ---

/**
 * Wait for all in-flight dispatch workers to complete, up to timeoutMs.
 *
 * PG backend: polls Agency HQ's /api/v1/dispatch-slots/active every 500 ms.
 * SQLite backend: polls the local active slot table every 500 ms.
 *
 * If all slots reach 'free' before the deadline, returns cleanly. If the
 * deadline is exceeded, each remaining slot is reverted to 'ready' on Agency
 * HQ and freed so that recoverStaleSlots() does not double-process them on
 * the next startup.
 */
export async function drainSlots(timeoutMs: number): Promise<void> {
  const log = createCorrelationLogger(undefined, { op: 'dispatch-drain' });
  const deadline = Date.now() + timeoutMs;

  let active = await listActiveSlotSnapshot(log);
  if (active.length === 0) return;

  log.info(
    { count: active.length, timeoutMs, backend: currentBackendName() },
    'Drain: waiting for in-flight workers to complete',
  );

  while (Date.now() < deadline) {
    await sleep(500);
    active = await listActiveSlotSnapshot(log);
    if (active.length === 0) {
      log.info('Drain: all slots free, clean shutdown');
      return;
    }
    log.debug({ count: active.length }, 'Drain: still waiting');
  }

  // Drain timeout exceeded — revert remaining tasks to 'ready' and free slots.
  active = await listActiveSlotSnapshot(log);
  if (active.length === 0) return;

  log.warn(
    { count: active.length, timeoutMs },
    'Drain timeout exceeded: reverting remaining in-flight tasks to ready',
  );

  for (const slot of active) {
    log.warn(
      { slotId: slot.slotId, ahqTaskId: slot.ahqTaskId, state: slot.state },
      'Drain timeout: reverting task to ready before exit',
    );

    await requeueAgencyTask(slot.ahqTaskId, log, 'drain timeout');
    await getDispatchSlotBackend().freeSlot(slot.slotId);
  }

  log.warn(
    { count: active.length },
    'Drain timeout: partial completion — remaining tasks reverted and slots freed',
  );
}

// --- Shutdown ---

/**
 * Log active slots on shutdown without modifying their state.
 *
 * SQLite backend: rows stay as acquiring/executing/releasing so
 * recoverStaleSlots() can find them on next startup.
 *
 * PG backend: slots remain in their current state in PostgreSQL; stale
 * detection via reconcileStaleSlots() handles them on next startup.
 */
export function flushOnShutdown(): void {
  if (isDispatchSlotsPgEnabled()) {
    // PG slots are durable in PostgreSQL; just log.
    logger.info(
      '[slot] Shutdown (PG): slots remain in PostgreSQL, will reconcile on next startup',
    );
    return;
  }

  let active: SlotRecord[];
  try {
    active = getActiveSlots();
  } catch {
    return;
  }

  if (active.length === 0) return;

  logger.info(
    {
      count: active.length,
      slots: active.map((s) => ({
        slotId: s.id,
        slotIndex: s.slot_index,
        ahqTaskId: s.ahq_task_id,
        state: s.state,
      })),
    },
    'Shutdown: dispatch slots detached (will recover on next startup)',
  );
}
