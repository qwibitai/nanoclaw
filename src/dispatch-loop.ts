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

/** Prevents concurrent dispatch loop runs (two ticks racing for the same ready tasks). */
let dispatchRunning = false;

/** Tracks retry counts per Agency HQ task ID (resets on process restart). */
export const dispatchRetryCount = new Map<string, number>();

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

      // Check retry count
      const retries = dispatchRetryCount.get(task.id) ?? 0;
      if (retries >= 3) {
        log.warn(
          { taskId: task.id, retries },
          'Task exceeded max dispatch retries, marking blocked',
        );
        await markBlocked(task, log);
        continue;
      }

      await dispatchTask(task, target.jid, target.folder, deps, isStopping, log);
    }
  } finally {
    dispatchRunning = false;
  }
}

async function dispatchTask(
  task: AgencyHqTask,
  targetJid: string,
  targetFolder: string,
  deps: SchedulerDependencies,
  isStopping: () => boolean,
  parentLog: ReturnType<typeof createCorrelationLogger>,
): Promise<void> {
  const log = createCorrelationLogger(undefined, {
    op: 'dispatch-loop',
    taskId: task.id,
  });

  // Increment retry count
  const count = (dispatchRetryCount.get(task.id) ?? 0) + 1;
  dispatchRetryCount.set(task.id, count);

  log.info({ taskId: task.id, attempt: count, targetFolder }, 'Dispatching ready task');

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
  const prompt = await buildPrompt(task, sprintGoal);
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
    return;
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

  deps.queue.enqueueTask(targetJid, localTaskId, async () => {
    const result = await runScheduledTask(localTask, deps);

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
      log.error({ err, taskId: task.id }, 'Failed to PUT result to Agency HQ');
    }

    // Clean up dispatch tracking
    dispatchRetryCount.delete(task.id);
    dispatchTime.delete(task.id);
  });

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
