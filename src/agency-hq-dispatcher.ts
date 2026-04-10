import {
  DISPATCH_DRAIN_TIMEOUT_MS,
  DISPATCH_LOOP_INTERVAL,
  DISPATCH_ORPHAN_PENALTY_MS,
  DISPATCH_ORPHAN_THRESHOLD_MS,
  STALL_DETECTOR_INTERVAL,
} from './config.js';
import {
  dispatchReadyTasks,
  dispatchRetryCount,
  dispatchSkipTicks,
  enableParallelDispatch,
  isParallelDispatchKillSwitchActive,
  findDispatchTarget,
  findCeoJid,
  buildPrompt,
  lockedWorkerSlots,
  resetDispatchLoopState,
} from './dispatch-loop.js';
import {
  drainSlots,
  recoverStaleSlots,
  flushOnShutdown,
} from './dispatch-pool.js';
import { agencyFetch, type AgencyHqTask } from './agency-hq-client.js';
import { detectStalledTasks, dispatchTime } from './stall-detector.js';
import {
  startSprintRetroWatcher,
  stopSprintRetroWatcher,
} from './sprint-retro-watcher.js';
import { createCorrelationLogger, logger } from './logger.js';
import type { SchedulerDependencies } from './task-scheduler.js';

// --- Module-level state ---

let stopping = false;
let dispatchIntervalHandle: ReturnType<typeof setInterval> | null = null;
let stallIntervalHandle: ReturnType<typeof setInterval> | null = null;

const isStopping = () => stopping;

// --- Startup reconciliation ---

/**
 * Reconcile orphaned Agency HQ dispatches on startup.
 *
 * Finds tasks stuck in 'in-progress' whose dispatched_at is older than
 * DISPATCH_ORPHAN_THRESHOLD_MS (default: 5 min). These are orphans from a
 * previous crash — the container never completed, so status was never updated.
 *
 * Each orphan is reverted to 'ready' with a dispatch_blocked_until penalty so
 * it won't immediately loop back into dispatch. Logs task_id and age for each.
 *
 * Must complete before DispatchPool begins accepting new work.
 */
export async function reconcileOrphanedDispatches(): Promise<void> {
  const log = createCorrelationLogger(undefined, { op: 'dispatch-reconcile' });

  let tasks: AgencyHqTask[];
  try {
    const res = await agencyFetch('/tasks?status=in-progress');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error(
        { status: res.status, body },
        'Orphan reconciliation: failed to fetch in-progress tasks',
      );
      return;
    }
    const json = (await res.json()) as {
      success: boolean;
      data: AgencyHqTask[];
    };
    tasks = json.data ?? [];
  } catch (err) {
    log.error(
      { err },
      'Orphan reconciliation: failed to fetch tasks from Agency HQ',
    );
    return;
  }

  if (tasks.length === 0) return;

  const now = Date.now();
  const penaltyUntil = new Date(now + DISPATCH_ORPHAN_PENALTY_MS).toISOString();
  let reconciled = 0;

  for (const task of tasks) {
    const dispatchedAt = task.dispatched_at
      ? new Date(task.dispatched_at).getTime()
      : null;

    // Skip tasks with no dispatched_at — can't determine age
    if (dispatchedAt === null) continue;

    const ageMs = now - dispatchedAt;
    if (ageMs < DISPATCH_ORPHAN_THRESHOLD_MS) continue;

    // Orphaned: revert to ready with dispatch_blocked_until penalty
    try {
      const res = await agencyFetch(`/tasks/${task.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: 'ready',
          dispatch_blocked_until: penaltyUntil,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.error(
          { status: res.status, body, taskId: task.id },
          'Orphan reconciliation: failed to revert task to ready',
        );
        continue;
      }
    } catch (err) {
      log.error({ err, taskId: task.id }, 'Orphan reconciliation: PUT failed');
      continue;
    }

    reconciled++;
    log.warn(
      {
        taskId: task.id,
        ageMs,
        ageMinutes: Math.round(ageMs / 60_000),
        dispatchedAt: task.dispatched_at,
        dispatch_blocked_until: penaltyUntil,
      },
      'Reconciled orphaned dispatch: reverted to ready with penalty',
    );
  }

  if (reconciled > 0) {
    log.info(
      { reconciled, penaltyMs: DISPATCH_ORPHAN_PENALTY_MS },
      'Orphan dispatch reconciliation complete',
    );
  }
}

// --- Lifecycle ---

export async function startDispatchLoop(
  deps: SchedulerDependencies,
): Promise<void> {
  stopping = false;
  logger.info(
    { intervalMs: DISPATCH_LOOP_INTERVAL },
    'Starting Agency HQ dispatch loop',
  );

  // Recover any stale dispatch slots left by a previous crash or SIGKILL.
  // Must run before the dispatch loop starts to free slots before first tick.
  await recoverStaleSlots();

  // Reconcile orphaned Agency HQ dispatches (tasks stuck in-progress from a crash).
  // Runs after local slot recovery so local state is clean before touching AHQ.
  // Must complete before the pool begins accepting new work.
  await reconcileOrphanedDispatches();

  // ── DISPATCH_PARALLEL env var (kill switch + force-enable) ─────────────────
  //
  //   DISPATCH_PARALLEL=false  → kill switch: force sequential regardless of gate
  //   DISPATCH_PARALLEL=true   → force-enable: bypass metrics gate, always parallel
  //   (unset)                  → automatic: notification metrics gate decides
  //
  // In-flight tasks from the previous run are already handled by
  // recoverStaleSlots() and reconcileOrphanedDispatches() above — they are
  // re-queued to 'ready' and will be dispatched on the next tick.
  if (isParallelDispatchKillSwitchActive()) {
    logger.warn(
      { DISPATCH_PARALLEL: process.env.DISPATCH_PARALLEL },
      'Dispatch kill switch ACTIVE (DISPATCH_PARALLEL=false): parallel dispatch forcibly disabled; running in sequential single-worker mode',
    );
  } else if (process.env.DISPATCH_PARALLEL === 'true') {
    // ── Force-enable: bypass the notification metrics gate ──────────────────
    // Use when organic gate requirements cannot be met (e.g. fresh deployment
    // with limited notification history, or explicit operator override).
    // This enables 4 concurrent worker slots (internal:dev-inbox:0..3).
    enableParallelDispatch();
    logger.info(
      { DISPATCH_PARALLEL: 'true', workers: 4 },
      'Parallel dispatch ENABLED: DISPATCH_PARALLEL=true force-enable (metrics gate bypassed); 4 worker slots active',
    );
  } else {
    logger.info(
      { DISPATCH_PARALLEL: process.env.DISPATCH_PARALLEL ?? 'unset' },
      'Dispatch kill switch inactive: parallel dispatch eligible (metrics gate will decide)',
    );

    // ── Notification metrics organic gate ────────────────────────────────────
    // Parallel dispatch is only enabled when the notification system has proven
    // organic production history.  The gate checks three hard requirements:
    //   1. agent_count  >= 3  — at least 3 distinct non-test target agents
    //   2. date_range   >= 7  — notifications span at least 7 calendar days
    //   3. no test rows       — no test-seeded agent names present in the DB
    //
    // A plain HTTP-200 check (the old behaviour) was a false-green: an empty DB
    // or a freshly-seeded test fixture also returns 200 with data: [].
    // The /metrics/gate endpoint returns an explicit {pass, fail_reason, stats}
    // object so every failure path has a human-readable reason in the log.
    try {
      const res = await agencyFetch('/notifications/metrics/gate');
      if (!res.ok) {
        logger.info(
          { status: res.status },
          'Parallel dispatch DISABLED: metrics gate endpoint returned non-200',
        );
      } else {
        const body = (await res.json()) as {
          success: boolean;
          data: {
            pass: boolean;
            fail_reason: string | null;
            stats: {
              agent_count: number;
              date_range_days: number;
              has_test_rows: boolean;
              test_agents: string[];
            };
          };
        };

        if (body.success && body.data.pass) {
          enableParallelDispatch();
          logger.info(
            { stats: body.data.stats },
            'Parallel dispatch ENABLED: organic metrics gate PASS',
          );
        } else {
          logger.info(
            { fail_reason: body.data?.fail_reason, stats: body.data?.stats },
            'Parallel dispatch DISABLED: organic metrics gate FAIL',
          );
        }
      }
    } catch (err) {
      logger.info(
        { err },
        'Parallel dispatch DISABLED: metrics gate check threw an error',
      );
    }
  }

  // Run once immediately, then on interval
  dispatchReadyTasks(deps, isStopping).catch((err) =>
    logger.error({ err }, 'Dispatch loop tick failed'),
  );

  dispatchIntervalHandle = setInterval(() => {
    dispatchReadyTasks(deps, isStopping).catch((err) =>
      logger.error({ err }, 'Dispatch loop tick failed'),
    );
  }, DISPATCH_LOOP_INTERVAL);
}

export async function startStallDetector(
  deps: SchedulerDependencies,
): Promise<void> {
  stopping = false;
  logger.info(
    { intervalMs: STALL_DETECTOR_INTERVAL },
    'Starting Agency HQ stall detector',
  );

  stallIntervalHandle = setInterval(() => {
    detectStalledTasks(deps, isStopping).catch((err) =>
      logger.error({ err }, 'Stall detector tick failed'),
    );
  }, STALL_DETECTOR_INTERVAL);
}

export async function startSprintRetroWatcherSubsystem(
  deps: SchedulerDependencies,
): Promise<void> {
  startSprintRetroWatcher(deps);
}

export async function stopAgencyHqSubsystems(): Promise<void> {
  // Stop new slot acquisition immediately.
  stopping = true;
  if (dispatchIntervalHandle) {
    clearInterval(dispatchIntervalHandle);
    dispatchIntervalHandle = null;
  }
  if (stallIntervalHandle) {
    clearInterval(stallIntervalHandle);
    stallIntervalHandle = null;
  }
  stopSprintRetroWatcher();
  dispatchRetryCount.clear();
  dispatchSkipTicks.clear();
  dispatchTime.clear();

  // Graceful drain: wait for in-flight workers to complete.
  // On timeout, remaining AHQ tasks are reverted to 'ready' and slots freed.
  await drainSlots(DISPATCH_DRAIN_TIMEOUT_MS);

  // Safety-net log for any slots still active (should be none after drain).
  flushOnShutdown();
  resetDispatchLoopState();
  logger.info('Agency HQ subsystems stopped');
}

// Exported for testing
export const _testInternals = {
  dispatchRetryCount,
  dispatchSkipTicks,
  dispatchTime,
  lockedWorkerSlots,
  dispatchReadyTasks: (deps: SchedulerDependencies) =>
    dispatchReadyTasks(deps, isStopping),
  detectStalledTasks: (deps: SchedulerDependencies) =>
    detectStalledTasks(deps, isStopping),
  buildPrompt,
  findDispatchTarget,
  findCeoJid,
  enableParallelDispatch,
  isParallelDispatchKillSwitchActive,
  resetStopping: () => {
    stopping = false;
    resetDispatchLoopState();
  },
};
