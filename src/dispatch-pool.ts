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

import { AGENCY_HQ_URL } from './config.js';
import {
  ACQUIRING_STALE_MS,
  getActiveSlots,
  insertAcquiringSlot,
  pruneFreedSlots,
  recoverStaleSlotRecords,
  transitionToExecuting,
  transitionToFree,
  transitionToReleasing,
  type SlotRecord,
} from './db/dispatch-slots.js';
import { createCorrelationLogger, logger } from './logger.js';
import { cleanupOrphanedWorktrees } from './worktree-manager.js';

// --- Constants ---

/** Number of concurrent dev-inbox worker slots. */
export const PARALLEL_DISPATCH_WORKERS = 4;

/** Returns the synthetic JID for dev-inbox worker slot i. */
export function workerSlotJid(i: number): string {
  return `internal:dev-inbox:${i}`;
}

// --- Feature flag ---

/**
 * Returns true when the PostgreSQL-backed slot management is enabled.
 *
 * Activation: set DISPATCH_SLOTS_PG=true after applying migration
 * 1710600026000_add-dispatch-slots-table.ts to Agency HQ's PostgreSQL.
 *
 * Defaults to false (local SQLite backend).
 */
export function isDispatchSlotsPgEnabled(): boolean {
  return process.env.DISPATCH_SLOTS_PG === 'true';
}

// --- SlotClaim ---

export interface SlotClaim {
  slotId: number;
  slotIndex: number;
  slotJid: string;
  worktreePath: string | null;
}

// --- PG-backed slot operations (calls Agency HQ HTTP API) ---

async function claimSlotPg(
  ahqTaskId: string,
  branchId: string | null,
  worktreePath: string | null,
): Promise<SlotClaim | null> {
  const res = await fetch(`${AGENCY_HQ_URL}/api/v1/dispatch-slots/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ahq_task_id: ahqTaskId, branch_id: branchId }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 409) {
    return null; // All slots busy or branch collision
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[dispatch-slots] claim failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as { success: boolean; data: { slot_index: number } };
  const slotIndex = json.data.slot_index;
  return { slotId: slotIndex, slotIndex, slotJid: workerSlotJid(slotIndex), worktreePath };
}

async function markSlotExecutingPg(slotIndex: number): Promise<void> {
  const res = await fetch(`${AGENCY_HQ_URL}/api/v1/dispatch-slots/${slotIndex}/executing`, {
    method: 'PUT',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ slotIndex, status: res.status, body }, '[dispatch-slots] markExecuting failed');
  }
}

async function markSlotReleasingPg(slotIndex: number): Promise<void> {
  const res = await fetch(`${AGENCY_HQ_URL}/api/v1/dispatch-slots/${slotIndex}/releasing`, {
    method: 'PUT',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ slotIndex, status: res.status, body }, '[dispatch-slots] markReleasing failed');
  }
}

async function freeSlotPg(slotIndex: number): Promise<void> {
  const res = await fetch(`${AGENCY_HQ_URL}/api/v1/dispatch-slots/${slotIndex}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ slotIndex, status: res.status, body }, '[dispatch-slots] free failed');
  }
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
  if (isDispatchSlotsPgEnabled()) {
    const claim = await claimSlotPg(ahqTaskId, branchId, worktreePath);
    if (claim) {
      logger.info(
        {
          slotId: claim.slotId,
          slotIndex: claim.slotIndex,
          ahqTaskId,
          branchId,
          worktreePath,
          state: 'acquiring',
          backend: 'pg',
          timestamp: new Date().toISOString(),
        },
        '[slot] acquiring',
      );
    }
    return claim;
  }

  // --- SQLite backend ---
  for (let i = 0; i < PARALLEL_DISPATCH_WORKERS; i++) {
    const slotId = insertAcquiringSlot(i, ahqTaskId, branchId, localTaskId, worktreePath);
    if (slotId !== null) {
      logger.info(
        {
          slotId,
          slotIndex: i,
          ahqTaskId,
          branchId,
          worktreePath,
          state: 'acquiring',
          backend: 'sqlite',
          timestamp: new Date().toISOString(),
        },
        '[slot] acquiring',
      );
      return { slotId, slotIndex: i, slotJid: workerSlotJid(i), worktreePath };
    }
  }
  return null;
}

/**
 * Transition slot from acquiring → executing.
 * Call when the container process has started (onProcess callback).
 */
export async function markSlotExecuting(slotId: number, ahqTaskId: string): Promise<void> {
  if (isDispatchSlotsPgEnabled()) {
    await markSlotExecutingPg(slotId); // slotId === slotIndex in PG backend
  } else {
    transitionToExecuting(slotId);
  }
  logger.info(
    {
      slotId,
      ahqTaskId,
      state: 'executing',
      backend: isDispatchSlotsPgEnabled() ? 'pg' : 'sqlite',
      timestamp: new Date().toISOString(),
    },
    '[slot] executing',
  );
}

/**
 * Transition slot from executing → releasing.
 * Call when the container has exited (before writing results to Agency HQ).
 */
export async function markSlotReleasing(slotId: number, ahqTaskId: string): Promise<void> {
  if (isDispatchSlotsPgEnabled()) {
    await markSlotReleasingPg(slotId);
  } else {
    transitionToReleasing(slotId);
  }
  logger.info(
    {
      slotId,
      ahqTaskId,
      state: 'releasing',
      backend: isDispatchSlotsPgEnabled() ? 'pg' : 'sqlite',
      timestamp: new Date().toISOString(),
    },
    '[slot] releasing',
  );
}

/**
 * Transition slot to free from any active state.
 * Call in finally blocks after results are written (or on any error path).
 */
export async function freeSlot(slotId: number, ahqTaskId: string): Promise<void> {
  if (isDispatchSlotsPgEnabled()) {
    await freeSlotPg(slotId);
  } else {
    transitionToFree(slotId);
  }
  logger.info(
    {
      slotId,
      ahqTaskId,
      state: 'free',
      backend: isDispatchSlotsPgEnabled() ? 'pg' : 'sqlite',
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

  if (isDispatchSlotsPgEnabled()) {
    await recoverStaleSlotsFromPg(log);
    return;
  }

  // --- SQLite path ---
  let staleRecords;
  try {
    staleRecords = recoverStaleSlotRecords();
  } catch (err) {
    log.error({ err }, 'Failed to query stale dispatch slots');
    return;
  }

  if (staleRecords.length === 0) return;

  log.info(
    { count: staleRecords.length },
    'Recovering stale dispatch slots',
  );

  // Clean up any orphaned worktrees from crashed dispatches before re-queuing.
  const orphanedWorktrees = staleRecords.map((r) => r.worktreePath);
  if (orphanedWorktrees.some((wt) => wt !== null)) {
    try {
      cleanupOrphanedWorktrees(process.cwd(), orphanedWorktrees);
    } catch (err) {
      log.warn({ err }, 'Failed to clean up orphaned worktrees during recovery');
    }
  }

  for (const record of staleRecords) {
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

    // PUT the AHQ task back to ready so it will be dispatched again.
    try {
      const res = await fetch(`${AGENCY_HQ_URL}/api/v1/tasks/${record.ahqTaskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ready' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.error(
          { status: res.status, body, ahqTaskId: record.ahqTaskId },
          'Failed to re-queue AHQ task after slot recovery',
        );
      } else {
        log.info(
          { ahqTaskId: record.ahqTaskId },
          'AHQ task re-queued after slot recovery',
        );
      }
    } catch (err) {
      log.error(
        { err, ahqTaskId: record.ahqTaskId },
        'Error re-queuing AHQ task after slot recovery',
      );
    }
  }

  // Prune old history rows while we're at it.
  try {
    const pruned = pruneFreedSlots();
    if (pruned > 0) {
      log.info({ pruned }, 'Pruned old free slot history rows');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to prune freed slot rows');
  }
}

/**
 * PG-backend startup reconciliation.
 * Calls /api/v1/dispatch-slots/reconcile and re-queues each freed task.
 */
async function recoverStaleSlotsFromPg(
  log: ReturnType<typeof createCorrelationLogger>,
): Promise<void> {
  let freedTaskIds: string[] = [];
  try {
    const res = await fetch(`${AGENCY_HQ_URL}/api/v1/dispatch-slots/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error({ status: res.status, body }, 'Dispatch slot reconcile failed');
      return;
    }
    const json = (await res.json()) as {
      success: boolean;
      data: { freed_task_ids: string[] };
    };
    freedTaskIds = json.data?.freed_task_ids ?? [];
  } catch (err) {
    log.error({ err }, 'Error calling dispatch-slots reconcile endpoint');
    return;
  }

  if (freedTaskIds.length === 0) return;

  log.info({ count: freedTaskIds.length }, 'Recovering stale PG dispatch slots');

  for (const ahqTaskId of freedTaskIds) {
    log.warn({ ahqTaskId }, 'Freed stale PG slot, re-queuing AHQ task');
    try {
      const res = await fetch(`${AGENCY_HQ_URL}/api/v1/tasks/${ahqTaskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ready' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.error(
          { status: res.status, body, ahqTaskId },
          'Failed to re-queue AHQ task after PG slot recovery',
        );
      } else {
        log.info({ ahqTaskId }, 'AHQ task re-queued after PG slot recovery');
      }
    } catch (err) {
      log.error({ err, ahqTaskId }, 'Error re-queuing AHQ task after PG slot recovery');
    }
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

  if (isDispatchSlotsPgEnabled()) {
    await drainSlotsPg(log, deadline, timeoutMs);
    return;
  }

  // --- SQLite path ---
  let active: SlotRecord[];
  try {
    active = getActiveSlots();
  } catch {
    return;
  }
  if (active.length === 0) return;

  log.info(
    { count: active.length, timeoutMs },
    'Drain: waiting for in-flight workers to complete',
  );

  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 500));
    try {
      active = getActiveSlots();
    } catch {
      return;
    }
    if (active.length === 0) {
      log.info('Drain: all slots free, clean shutdown');
      return;
    }
    log.debug({ count: active.length }, 'Drain: still waiting');
  }

  // Drain timeout exceeded — revert remaining tasks to 'ready' and free slots.
  try {
    active = getActiveSlots();
  } catch {
    return;
  }
  if (active.length === 0) return;

  log.warn(
    { count: active.length, timeoutMs },
    'Drain timeout exceeded: reverting remaining in-flight tasks to ready',
  );

  for (const slot of active) {
    log.warn(
      { slotId: slot.id, ahqTaskId: slot.ahq_task_id, state: slot.state },
      'Drain timeout: reverting task to ready before exit',
    );

    try {
      const res = await fetch(
        `${AGENCY_HQ_URL}/api/v1/tasks/${slot.ahq_task_id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'ready' }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.error(
          { status: res.status, body, ahqTaskId: slot.ahq_task_id },
          'Drain timeout: failed to revert task to ready',
        );
      } else {
        log.info(
          { ahqTaskId: slot.ahq_task_id },
          'Drain timeout: task reverted to ready',
        );
      }
    } catch (err) {
      log.error(
        { err, ahqTaskId: slot.ahq_task_id },
        'Drain timeout: error reverting task to ready',
      );
    }

    transitionToFree(slot.id);
  }

  log.warn(
    { count: active.length },
    'Drain timeout: partial completion — remaining tasks reverted and slots freed',
  );
}

/** PG drain: polls active-slots endpoint until empty or timeout. */
async function drainSlotsPg(
  log: ReturnType<typeof createCorrelationLogger>,
  deadline: number,
  timeoutMs: number,
): Promise<void> {
  interface ActiveSlot { slot_index: number; ahq_task_id: string; status: string }

  const fetchActive = async (): Promise<ActiveSlot[]> => {
    const res = await fetch(`${AGENCY_HQ_URL}/api/v1/dispatch-slots/active`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { success: boolean; data: ActiveSlot[] };
    return json.data ?? [];
  };

  let active = await fetchActive();
  if (active.length === 0) return;

  log.info({ count: active.length, timeoutMs }, 'Drain (PG): waiting for in-flight workers');

  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 500));
    active = await fetchActive();
    if (active.length === 0) {
      log.info('Drain (PG): all slots free, clean shutdown');
      return;
    }
    log.debug({ count: active.length }, 'Drain (PG): still waiting');
  }

  active = await fetchActive();
  if (active.length === 0) return;

  log.warn({ count: active.length, timeoutMs }, 'Drain (PG) timeout: reverting tasks to ready');

  for (const slot of active) {
    try {
      await fetch(`${AGENCY_HQ_URL}/api/v1/tasks/${slot.ahq_task_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ready' }),
        signal: AbortSignal.timeout(5_000),
      });
      await freeSlotPg(slot.slot_index);
      log.warn({ ahqTaskId: slot.ahq_task_id, slotIndex: slot.slot_index }, 'Drain (PG): task reverted, slot freed');
    } catch (err) {
      log.error({ err, ahqTaskId: slot.ahq_task_id }, 'Drain (PG): error reverting task');
    }
  }
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
    logger.info('[slot] Shutdown (PG): slots remain in PostgreSQL, will reconcile on next startup');
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
