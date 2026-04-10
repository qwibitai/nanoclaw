import { AGENCY_HQ_URL } from './config.js';
import { completeStaleTasksByPrefix, createTask } from './db/index.js';
import {
  agencyFetch,
  fetchPersona,
  type AgencyHqTask,
  type AgencyHqSprint,
} from './agency-hq-client.js';
import { dispatchTime } from './stall-detector.js';
import { createCorrelationLogger } from './logger.js';
import { SchedulerDependencies, runScheduledTask } from './task-scheduler.js';
import {
  claimSlot,
  freeSlot,
  flushOnShutdown,
  markSlotExecuting,
  markSlotReleasing,
  PARALLEL_DISPATCH_WORKERS,
  workerSlotJid,
} from './dispatch-pool.js';
import { createWorktree, removeWorktree } from './worktree-manager.js';

/** Prevents concurrent dispatch loop runs (two ticks racing for the same ready tasks). */
let dispatchRunning = false;

/** Tracks retry counts per Agency HQ task ID (resets on process restart). */
export const dispatchRetryCount = new Map<string, number>();

/**
 * Exponential backoff: ticks remaining to skip before retrying a failed task.
 *
 * Backoff schedule (applied after each dispatch failure):
 *   Failure 1 → skip 1 tick before retry
 *   Failure 2 → skip 3 ticks before retry
 *   Failure 3 → set dispatch_blocked_until (no more retries until reset)
 */
export const dispatchSkipTicks = new Map<string, number>();

// --- Parallel dispatch ---

/**
 * Whether parallel dispatch is enabled (set after notification metrics
 * prerequisite gate passes at startup).
 */
let parallelDispatchEnabled = false;

/**
 * Returns true when the DISPATCH_PARALLEL=false env var kill switch is active.
 *
 * When active, parallel dispatch is forcibly disabled regardless of the
 * notification metrics gate result. Set DISPATCH_PARALLEL=false to trigger
 * an emergency rollback to sequential single-worker dispatch without a deploy.
 */
export function isParallelDispatchKillSwitchActive(): boolean {
  return process.env.DISPATCH_PARALLEL === 'false';
}

/**
 * Enable parallel dispatch (called when notification metrics gate passes).
 *
 * No-ops silently if the DISPATCH_PARALLEL=false kill switch is active —
 * the caller logs the kill switch state separately at startup.
 */
export function enableParallelDispatch(): void {
  if (isParallelDispatchKillSwitchActive()) {
    // Kill switch overrides the metrics gate — stay in sequential mode.
    return;
  }
  parallelDispatchEnabled = true;
}

/** Reset all parallel dispatch state (used in tests and on shutdown). */
export function resetDispatchLoopState(): void {
  parallelDispatchEnabled = false;
  flushOnShutdown();
}

// Keep lockedWorkerSlots exported for backward-compat with tests and
// agency-hq-dispatcher.ts _testInternals, but it is no longer the
// source of truth — dispatch-pool.ts owns slot state.
export const lockedWorkerSlots = new Set<string>();

const DEFAULT_PLANNING_PERSONA = 'agency/leadership/engineering-manager';

// --- Helpers ---

/**
 * Find the dispatch target for Agency HQ tasks.
 * Prefers a registered main group; falls back to CEO group's JID
 * with folder='main' so tasks execute in the main container
 * but results get sent to the CEO's Telegram chat.
 */
export function findDispatchTarget(
  deps: SchedulerDependencies,
): { jid: string; folder: string } | null {
  const groups = deps.registeredGroups();
  // Prefer an explicit main group
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) return { jid, folder: group.folder };
  }
  // Fall back: use CEO's JID but execute in main folder
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === 'ceo') return { jid, folder: 'main' };
  }
  return null;
}

export function findCeoJid(
  deps: SchedulerDependencies,
): { jid: string; folder: string } | null {
  const groups = deps.registeredGroups();
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === 'ceo') return { jid, folder: group.folder };
  }
  return null;
}

export async function buildPrompt(
  task: AgencyHqTask,
  sprintGoal?: string,
): Promise<string> {
  const parts = [`/orchestrate ${task.title}`, '', task.description];

  if (task.acceptance_criteria) {
    parts.push('', `Acceptance Criteria: ${task.acceptance_criteria}`);
  }
  if (task.repository) {
    parts.push('', `Repository: ${task.repository}`);
  }
  if (sprintGoal) {
    parts.push('', `Sprint Goal: ${sprintGoal}`);
  }

  // Inject planning persona — use assigned_to as catalog key, fall back to default
  const personaKey =
    task.assigned_to && task.assigned_to !== 'hold'
      ? task.assigned_to
      : DEFAULT_PLANNING_PERSONA;
  const persona = await fetchPersona(personaKey);
  if (persona) {
    parts.push(
      '',
      `## Planning Persona (${personaKey})`,
      '',
      'Use the following persona to guide your planning and task decomposition:',
      '',
      persona,
    );
  }

  parts.push(
    '',
    `Agency HQ task ID: ${task.id}`,
    '',
    'IMPORTANT: When this task is complete, you MUST:',
    `1. PUT ${AGENCY_HQ_URL}/api/v1/tasks/${task.id} with {"status": "done", "context": {"result": {"summary": "<what you accomplished>"}}}`,
    `2. POST ${AGENCY_HQ_URL}/api/v1/notifications with a summary notification`,
    '',
    'The result write-back in step 1 is critical — without it the task shows as done but with no result.',
  );

  return parts.join('\n');
}

// --- Dispatch Loop ---

export async function dispatchReadyTasks(
  deps: SchedulerDependencies,
  isStopping: () => boolean,
): Promise<void> {
  if (isStopping()) return;

  // Prevent concurrent dispatch runs — two ticks racing would call
  // completeStaleTasksByPrefix on each other's newly-created local tasks,
  // silently dropping tasks that haven't run yet.
  if (dispatchRunning) {
    const log = createCorrelationLogger(undefined, { op: 'dispatch-loop' });
    log.debug('Dispatch loop already running, skipping tick');
    return;
  }
  dispatchRunning = true;

  const log = createCorrelationLogger(undefined, { op: 'dispatch-loop' });

  try {
    const target = findDispatchTarget(deps);
    if (!target) {
      log.warn('No dispatch target found (no main or CEO group), skipping');
      return;
    }

    let tasks: AgencyHqTask[];
    try {
      const res = await agencyFetch('/tasks?status=ready');
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.error({ status: res.status, body }, 'Failed to fetch ready tasks');
        return;
      }
      const json = (await res.json()) as {
        success: boolean;
        data: AgencyHqTask[];
      };
      tasks = json.data ?? [];
    } catch (err) {
      log.error({ err }, 'Failed to fetch ready tasks from Agency HQ');
      return;
    }

    if (tasks.length === 0) return;

    log.info({ count: tasks.length }, 'Fetched ready tasks');

    for (const task of tasks) {
      if (isStopping()) return;

      // Skip parked tasks
      if (task.assigned_to === 'hold') {
        log.debug({ taskId: task.id }, 'Skipping held task');
        continue;
      }
      if (task.scheduled_dispatch_at) {
        const scheduledAt = new Date(task.scheduled_dispatch_at).getTime();
        if (scheduledAt > Date.now()) {
          log.debug(
            { taskId: task.id, scheduledAt: task.scheduled_dispatch_at },
            'Skipping future-scheduled task',
          );
          continue;
        }
      }

      // dispatch_blocked_until: skip if this task has been blocked until a
      // future timestamp (set after 3 consecutive dispatch failures).
      if (task.dispatch_blocked_until) {
        const blockedUntil = new Date(task.dispatch_blocked_until).getTime();
        if (blockedUntil > Date.now()) {
          log.debug(
            { taskId: task.id, blockedUntil: task.dispatch_blocked_until },
            'Skipping task blocked until future time',
          );
          continue;
        }
      }

      // Exponential backoff: skip ticks if the task is cooling down from a prior failure
      const remainingSkips = dispatchSkipTicks.get(task.id) ?? 0;
      if (remainingSkips > 0) {
        dispatchSkipTicks.set(task.id, remainingSkips - 1);
        log.debug(
          { taskId: task.id, remainingSkips: remainingSkips - 1 },
          'Skipping task (backoff cooldown)',
        );
        continue;
      }

      // Check retry count — set dispatch_blocked_until after 3 consecutive failures
      const retries = dispatchRetryCount.get(task.id) ?? 0;
      if (retries >= 3) {
        log.warn(
          { taskId: task.id, retries },
          'Task exceeded max dispatch retries, setting dispatch_blocked_until',
        );
        await markBlocked(task, log);
        continue;
      }

      // Pick dispatch JID: parallel worker slot (via DispatchPool) or sequential target
      let dispatchJid: string;
      let slotId: number | null = null;

      if (parallelDispatchEnabled) {
        // Slot is NOT claimed here — claimSlot happens inside dispatchTask
        // after we know the localTaskId. We just check availability first.
        // Use workerSlotJid(0) as a sentinel check; actual claim is in dispatchTask.
        // Check if any slot is available (optimistic — the real claim is atomic in SQLite).
        let hasAvailableSlot = false;
        for (let i = 0; i < PARALLEL_DISPATCH_WORKERS; i++) {
          if (!lockedWorkerSlots.has(workerSlotJid(i))) {
            hasAvailableSlot = true;
            break;
          }
        }
        if (!hasAvailableSlot) {
          log.debug(
            { taskId: task.id },
            'All worker slots busy (in-memory check), skipping task (will retry next tick)',
          );
          continue;
        }
        // Use a placeholder JID; actual slot JID resolved in dispatchTask
        dispatchJid = 'internal:dev-inbox:pending';
      } else {
        dispatchJid = target.jid;
        slotId = null;
      }

      const dispatched = await dispatchTask(
        task,
        dispatchJid,
        target.folder,
        deps,
        isStopping,
        log,
      );

      // On failure, apply exponential backoff before the next retry:
      //   Failure 1 (retries now 1) → skip 1 tick
      //   Failure 2 (retries now 2) → skip 3 ticks
      //   Failure 3+ will be caught by the retries >= 3 check on the next tick
      if (!dispatched) {
        const currentRetries = dispatchRetryCount.get(task.id) ?? 0;
        const skipTicks =
          currentRetries === 1 ? 1 : currentRetries === 2 ? 3 : 0;
        if (skipTicks > 0) {
          dispatchSkipTicks.set(task.id, skipTicks);
          log.info(
            { taskId: task.id, retries: currentRetries, skipTicks },
            'Dispatch failed, applying exponential backoff',
          );
        }
      }
    }
  } finally {
    dispatchRunning = false;
  }
}

/** Returns true if dispatch succeeded, false if it failed (for backoff tracking). */
async function dispatchTask(
  task: AgencyHqTask,
  targetJid: string,
  targetFolder: string,
  deps: SchedulerDependencies,
  isStopping: () => boolean,
  parentLog: ReturnType<typeof createCorrelationLogger>,
): Promise<boolean> {
  const isWorkerSlot = parallelDispatchEnabled;

  const log = createCorrelationLogger(undefined, {
    op: 'dispatch-loop',
    taskId: task.id,
  });

  // Increment retry count
  const count = (dispatchRetryCount.get(task.id) ?? 0) + 1;
  dispatchRetryCount.set(task.id, count);

  log.info(
    { taskId: task.id, attempt: count, targetFolder },
    'Dispatching ready task',
  );

  // Mark in-progress in Agency HQ before enqueuing
  try {
    const res = await agencyFetch(`/tasks/${task.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        status: 'in-progress',
        dispatched_at: new Date().toISOString(),
        dispatch_attempts: (task.dispatch_attempts ?? 0) + 1,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error(
        { status: res.status, body },
        'Failed to mark task in-progress',
      );
      return false;
    }
  } catch (err) {
    log.error({ err }, 'Failed to PUT task in-progress');
    return false;
  }

  // Fetch sprint goal if sprint_id is set
  let sprintGoal: string | undefined;
  if (task.sprint_id) {
    try {
      const res = await agencyFetch(`/sprints/${task.sprint_id}`);
      if (res.ok) {
        const sprintJson = (await res.json()) as {
          success: boolean;
          data: AgencyHqSprint;
        };
        sprintGoal = sprintJson.data?.goal;
      }
    } catch (err) {
      log.warn({ err, sprintId: task.sprint_id }, 'Failed to fetch sprint');
    }
  }

  // Build prompt and create local task
  const basePrompt = await buildPrompt(task, sprintGoal);
  const now = new Date().toISOString();
  const localTaskId = `ahq-${task.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Clean up any stale active tasks from previous dispatch attempts
  // (e.g., from a crash/restart that left orphaned entries)
  const staleCount = completeStaleTasksByPrefix(`ahq-${task.id}-`);
  if (staleCount > 0) {
    log.info(
      { taskId: task.id, staleCount },
      'Cleaned up stale dispatch entries',
    );
  }

  // --- Phase 1: Create worktree (when task targets a repository) ---
  let worktreePath: string | null = null;
  if (task.repository) {
    worktreePath = createWorktree(process.cwd(), task.id);
    if (worktreePath) {
      log.info(
        { taskId: task.id, worktreePath },
        'Worktree created for dispatch',
      );
    }
  }

  // Inject worktree context into the prompt so the agent knows where to work.
  const prompt = worktreePath
    ? basePrompt +
      [
        '',
        '## Isolated Git Worktree',
        '',
        `This dispatch has an isolated git worktree at: \`${worktreePath}\``,
        'Start all code changes from this directory. Your work is branch-isolated from other concurrent dispatches.',
        `Run \`cd ${worktreePath}\` before making any edits.`,
      ].join('\n')
    : basePrompt;

  // --- Phase 1b: Acquire slot (acquiring state) ---
  let claim: {
    slotId: number;
    slotIndex: number;
    slotJid: string;
    worktreePath: string | null;
  } | null = null;

  if (isWorkerSlot) {
    const branchId =
      task.assigned_to && task.assigned_to !== 'hold' ? task.assigned_to : null;

    claim = await claimSlot(task.id, branchId, localTaskId, worktreePath);
    if (claim === null) {
      log.debug(
        { taskId: task.id },
        'No slot available (all busy or branch collision), skipping',
      );
      // Clean up the worktree we created since we're not dispatching.
      if (worktreePath) {
        removeWorktree(process.cwd(), worktreePath);
      }
      // Roll back in-progress status since we couldn't claim a slot
      agencyFetch(`/tasks/${task.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'ready' }),
      }).catch((err) =>
        log.warn({ err, taskId: task.id }, 'Failed to revert task to ready'),
      );
      // Don't count this as a retry failure
      dispatchRetryCount.set(task.id, count - 1);
      return false;
    }
    // Update targetJid to the claimed slot's JID
    targetJid = claim.slotJid;

    // Keep in-memory set in sync for the optimistic pre-check
    lockedWorkerSlots.add(claim.slotJid);

    log.debug(
      { taskId: task.id, workerSlot: claim.slotJid, slotId: claim.slotId },
      'Worker slot acquired',
    );
  }

  try {
    createTask({
      id: localTaskId,
      group_folder: targetFolder,
      chat_jid: targetJid,
      prompt,
      schedule_type: 'once',
      schedule_value: now,
      context_mode: 'isolated',
      next_run: now,
      status: 'active',
      created_at: now,
    });
  } catch (err) {
    log.error({ err }, 'Failed to create local task');
    if (worktreePath) {
      removeWorktree(process.cwd(), worktreePath);
    }
    if (claim) {
      await freeSlot(claim.slotId, task.id);
      lockedWorkerSlots.delete(claim.slotJid);
    }
    return false;
  }

  // Track dispatch time for stall detection
  dispatchTime.set(task.id, Date.now());

  // Enqueue for execution
  const localTask = {
    id: localTaskId,
    group_folder: targetFolder,
    chat_jid: targetJid,
    prompt,
    schedule_type: 'once' as const,
    schedule_value: now,
    context_mode: 'isolated' as const,
    next_run: now,
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: now,
  };

  const capturedClaim = claim;

  deps.queue.enqueueTask(targetJid, localTaskId, async () => {
    // --- Phase 2: executing → releasing → free ---
    try {
      // Mark executing when container starts (via onProcess callback)
      // We hook into runScheduledTask's onProcess by pre-transitioning here
      // since the container is about to start.
      if (capturedClaim) {
        await markSlotExecuting(capturedClaim.slotId, task.id);
      }

      const result = await runScheduledTask(localTask, deps);

      // --- Phase 3: Releasing (writing results back to Agency HQ) ---
      if (capturedClaim) {
        await markSlotReleasing(capturedClaim.slotId, task.id);
      }

      // Write result back to Agency HQ (programmatic — doesn't rely on agent)
      const resultPayload = result
        ? { summary: result.slice(0, 2000) }
        : { summary: 'Task completed (no output captured)' };

      // Fetch existing context so we merge rather than replace
      let existingContext: Record<string, unknown> = {};
      try {
        const getRes = await agencyFetch(`/tasks/${task.id}`);
        if (getRes.ok) {
          const getJson = (await getRes.json()) as {
            success: boolean;
            data: { context?: Record<string, unknown> };
          };
          existingContext = getJson.data?.context ?? {};
        } else {
          log.warn(
            { status: getRes.status, taskId: task.id },
            'Failed to fetch existing context, will replace',
          );
        }
      } catch (err) {
        log.warn(
          { err, taskId: task.id },
          'Failed to GET task for context merge, will replace',
        );
      }

      const mergedContext = { ...existingContext, result: resultPayload };

      try {
        const res = await agencyFetch(`/tasks/${task.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            status: 'done',
            context: mergedContext,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          log.error(
            { status: res.status, body, taskId: task.id },
            'Failed to write result back to Agency HQ',
          );
        } else {
          log.info({ taskId: task.id }, 'Result written back to Agency HQ');
        }
      } catch (err) {
        log.error(
          { err, taskId: task.id },
          'Failed to PUT result to Agency HQ',
        );
      }

      // Clean up dispatch tracking (task succeeded — clear all backoff state)
      dispatchRetryCount.delete(task.id);
      dispatchSkipTicks.delete(task.id);
      dispatchTime.delete(task.id);
    } finally {
      // --- Phase 4: Free slot (from any state) ---
      if (capturedClaim) {
        // Clean up the worktree before freeing the slot.
        if (capturedClaim.worktreePath) {
          removeWorktree(process.cwd(), capturedClaim.worktreePath);
        }
        await freeSlot(capturedClaim.slotId, task.id);
        lockedWorkerSlots.delete(capturedClaim.slotJid);
        log.debug(
          {
            workerSlot: capturedClaim.slotJid,
            slotId: capturedClaim.slotId,
            worktreePath: capturedClaim.worktreePath,
          },
          'Worker slot freed',
        );
      }
    }
  });

  log.info({ taskId: task.id, localTaskId }, 'Task dispatched successfully');
  return true;
}

async function markBlocked(
  task: AgencyHqTask,
  log: ReturnType<typeof createCorrelationLogger>,
): Promise<void> {
  // Set dispatch_blocked_until to 24 hours from now.
  // This is a softer block than status=blocked — the task stays in its current
  // state but won't be retried until the timestamp passes.
  const blockedUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  try {
    await agencyFetch(`/tasks/${task.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        status: 'blocked',
        dispatch_blocked_until: blockedUntil,
      }),
    });
    log.warn(
      { taskId: task.id, blockedUntil },
      'Task marked blocked with dispatch_blocked_until',
    );
  } catch (err) {
    log.error({ err, taskId: task.id }, 'Failed to mark task blocked');
  }

  try {
    await agencyFetch('/notifications', {
      method: 'POST',
      body: JSON.stringify({
        type: 'task-blocked',
        title: `Task blocked after 3 dispatch failures: ${task.title}`,
        target: 'ceo',
        channel: 'telegram',
        reference_type: 'task',
        reference_id: task.id,
      }),
    });
  } catch (err) {
    log.error({ err, taskId: task.id }, 'Failed to POST blocked notification');
  }

  // Clear retry and backoff state since task is now blocked
  dispatchRetryCount.delete(task.id);
  dispatchSkipTicks.delete(task.id);
}
