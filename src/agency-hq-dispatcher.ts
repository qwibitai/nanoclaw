import {
  AGENCY_HQ_URL,
  DISPATCH_LOOP_INTERVAL,
  STALL_DETECTOR_INTERVAL,
  STALL_THRESHOLD_MS,
} from './config.js';
import { createTask } from './db.js';
import { createCorrelationLogger, logger } from './logger.js';
import { SchedulerDependencies, runScheduledTask } from './task-scheduler.js';

// --- Module-level state ---

let stopping = false;
let dispatchIntervalHandle: ReturnType<typeof setInterval> | null = null;
let stallIntervalHandle: ReturnType<typeof setInterval> | null = null;

/** Tracks retry counts per Agency HQ task ID (resets on process restart). */
const dispatchRetryCount = new Map<string, number>();

/** Tracks when each task was dispatched (for stall detection). */
const dispatchTime = new Map<string, number>();

// --- Types ---

interface AgencyHqTask {
  id: string;
  title: string;
  description: string;
  acceptance_criteria?: string;
  repository?: string;
  sprint_id?: string;
  assigned_to?: string;
  scheduled_dispatch_at?: string;
  status: string;
  dispatch_attempts?: number;
  dispatched_at?: string;
  updated_at?: string;
}

interface AgencyHqSprint {
  id: string;
  goal?: string;
}

// --- Helpers ---

function findCeoJid(
  deps: SchedulerDependencies,
): { jid: string; folder: string } | null {
  const groups = deps.registeredGroups();
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === 'ceo') return { jid, folder: group.folder };
  }
  return null;
}

async function agencyFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${AGENCY_HQ_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

function buildPrompt(
  task: AgencyHqTask,
  sprintGoal?: string,
): string {
  const parts = [
    `/orchestrate ${task.title}`,
    '',
    task.description,
  ];

  if (task.acceptance_criteria) {
    parts.push('', `Acceptance Criteria: ${task.acceptance_criteria}`);
  }
  if (task.repository) {
    parts.push('', `Repository: ${task.repository}`);
  }
  if (sprintGoal) {
    parts.push('', `Sprint Goal: ${sprintGoal}`);
  }

  parts.push(
    '',
    `Agency HQ task ID: ${task.id}`,
    '',
    'IMPORTANT: When this task is complete, you MUST:',
    `1. PUT ${AGENCY_HQ_URL}/api/v1/tasks/${task.id} with {"status": "done"}`,
    `2. POST ${AGENCY_HQ_URL}/api/v1/notifications with a summary notification`,
  );

  return parts.join('\n');
}

// --- Dispatch Loop ---

async function dispatchReadyTasks(deps: SchedulerDependencies): Promise<void> {
  if (stopping) return;

  const log = createCorrelationLogger(undefined, { op: 'dispatch-loop' });

  const ceo = findCeoJid(deps);
  if (!ceo) {
    log.warn('CEO group not registered, skipping dispatch loop');
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
    const json = (await res.json()) as { success: boolean; data: AgencyHqTask[] };
    tasks = json.data ?? [];
  } catch (err) {
    log.error({ err }, 'Failed to fetch ready tasks from Agency HQ');
    return;
  }

  if (tasks.length === 0) return;

  log.info({ count: tasks.length }, 'Fetched ready tasks');

  for (const task of tasks) {
    if (stopping) return;

    // Skip parked tasks
    if (task.assigned_to === 'hold') {
      log.debug({ taskId: task.id }, 'Skipping held task');
      continue;
    }
    if (task.scheduled_dispatch_at) {
      const scheduledAt = new Date(task.scheduled_dispatch_at).getTime();
      if (scheduledAt > Date.now()) {
        log.debug({ taskId: task.id, scheduledAt: task.scheduled_dispatch_at }, 'Skipping future-scheduled task');
        continue;
      }
    }

    // Check retry count
    const retries = dispatchRetryCount.get(task.id) ?? 0;
    if (retries >= 3) {
      log.warn({ taskId: task.id, retries }, 'Task exceeded max dispatch retries, marking blocked');
      await markBlocked(task, log);
      continue;
    }

    await dispatchTask(task, ceo.jid, deps, log);
  }
}

async function dispatchTask(
  task: AgencyHqTask,
  ceoJid: string,
  deps: SchedulerDependencies,
  parentLog: ReturnType<typeof createCorrelationLogger>,
): Promise<void> {
  const log = createCorrelationLogger(undefined, { op: 'dispatch-loop', taskId: task.id });

  // Increment retry count
  const count = (dispatchRetryCount.get(task.id) ?? 0) + 1;
  dispatchRetryCount.set(task.id, count);

  log.info({ taskId: task.id, attempt: count }, 'Dispatching ready task');

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
      log.error({ status: res.status, body }, 'Failed to mark task in-progress');
      return;
    }
  } catch (err) {
    log.error({ err }, 'Failed to PUT task in-progress');
    return;
  }

  // Fetch sprint goal if sprint_id is set
  let sprintGoal: string | undefined;
  if (task.sprint_id) {
    try {
      const res = await agencyFetch(`/sprints/${task.sprint_id}`);
      if (res.ok) {
        const sprintJson = (await res.json()) as { success: boolean; data: AgencyHqSprint };
        sprintGoal = sprintJson.data?.goal;
      }
    } catch (err) {
      log.warn({ err, sprintId: task.sprint_id }, 'Failed to fetch sprint');
    }
  }

  // Build prompt and create local task
  const prompt = buildPrompt(task, sprintGoal);
  const now = new Date().toISOString();
  const localTaskId = `ahq-${task.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    createTask({
      id: localTaskId,
      group_folder: 'ceo',
      chat_jid: ceoJid,
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
    return;
  }

  // Track dispatch time for stall detection
  dispatchTime.set(task.id, Date.now());

  // Enqueue for execution
  const localTask = {
    id: localTaskId,
    group_folder: 'ceo',
    chat_jid: ceoJid,
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

  deps.queue.enqueueTask(ceoJid, localTaskId, () =>
    runScheduledTask(localTask, deps),
  );

  log.info({ taskId: task.id, localTaskId }, 'Task dispatched successfully');
}

async function markBlocked(
  task: AgencyHqTask,
  log: ReturnType<typeof createCorrelationLogger>,
): Promise<void> {
  try {
    await agencyFetch(`/tasks/${task.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'blocked' }),
    });
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

  // Clear retry count since task is now blocked
  dispatchRetryCount.delete(task.id);
}

// --- Stall Detector ---

async function detectStalledTasks(deps: SchedulerDependencies): Promise<void> {
  if (stopping) return;

  const log = createCorrelationLogger(undefined, { op: 'stall-detector' });

  let tasks: AgencyHqTask[];
  try {
    const res = await agencyFetch('/tasks?status=in-progress');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error({ status: res.status, body }, 'Failed to fetch in-progress tasks');
      return;
    }
    const json = (await res.json()) as { success: boolean; data: AgencyHqTask[] };
    tasks = json.data ?? [];
  } catch (err) {
    log.error({ err }, 'Failed to fetch in-progress tasks from Agency HQ');
    return;
  }

  const now = Date.now();
  let stalledCount = 0;

  for (const task of tasks) {
    if (stopping) return;

    // Check dispatched_at from local tracking or API response
    const dispatched = dispatchTime.get(task.id)
      ?? (task.dispatched_at ? new Date(task.dispatched_at).getTime() : null);

    if (!dispatched) continue;

    // Check if task has been updated since dispatch
    if (task.updated_at) {
      const updatedAt = new Date(task.updated_at).getTime();
      if (updatedAt > dispatched) continue;
    }

    if (now - dispatched > STALL_THRESHOLD_MS) {
      stalledCount++;
      log.warn({ taskId: task.id, dispatchedAt: new Date(dispatched).toISOString() }, 'Task stalled');

      try {
        await agencyFetch('/notifications', {
          method: 'POST',
          body: JSON.stringify({
            type: 'task-stalled',
            title: `Task stalled: ${task.title}`,
            target: 'ceo',
            channel: 'telegram',
            reference_type: 'task',
            reference_id: task.id,
          }),
        });
      } catch (err) {
        log.error({ err, taskId: task.id }, 'Failed to POST stall notification');
      }

      // Also notify via message if CEO group exists
      const ceo = findCeoJid(deps);
      if (ceo) {
        try {
          await deps.sendMessage(
            ceo.jid,
            `⚠️ Task stalled (in-progress > ${Math.round(STALL_THRESHOLD_MS / 60_000)}min): ${task.title} (${task.id})`,
          );
        } catch (err) {
          log.error({ err }, 'Failed to send stall message to CEO group');
        }
      }
    }
  }

  if (stalledCount > 0) {
    log.info({ stalledCount }, 'Stall detection complete');
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

  // Run once immediately, then on interval
  dispatchReadyTasks(deps).catch((err) =>
    logger.error({ err }, 'Dispatch loop tick failed'),
  );

  dispatchIntervalHandle = setInterval(() => {
    dispatchReadyTasks(deps).catch((err) =>
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
    detectStalledTasks(deps).catch((err) =>
      logger.error({ err }, 'Stall detector tick failed'),
    );
  }, STALL_DETECTOR_INTERVAL);
}

export async function stopAgencyHqSubsystems(): Promise<void> {
  stopping = true;
  if (dispatchIntervalHandle) {
    clearInterval(dispatchIntervalHandle);
    dispatchIntervalHandle = null;
  }
  if (stallIntervalHandle) {
    clearInterval(stallIntervalHandle);
    stallIntervalHandle = null;
  }
  dispatchRetryCount.clear();
  dispatchTime.clear();
  logger.info('Agency HQ subsystems stopped');
}

// Exported for testing
export const _testInternals = {
  dispatchRetryCount,
  dispatchTime,
  dispatchReadyTasks,
  detectStalledTasks,
  buildPrompt,
  findCeoJid,
  resetStopping: () => { stopping = false; },
};
