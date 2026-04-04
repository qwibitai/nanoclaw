import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  SCHEDULER_POLL_INTERVAL,
  TASK_IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { MessageLogger } from './message-logger.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  storeMessage,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

// ── Progress monitor for interactive tasks ───────────────────────────
// When an interactive Google Chat message (gchat-msg-*) is processing,
// the host sends periodic "still working" messages if the agent hasn't
// produced output for a while. This prevents Craig from staring at
// silence while Holly is deep in tool calls.

const PROGRESS_INTERVALS = [
  { delayMs: 30_000, message: 'Still working on this...' },
  {
    delayMs: 90_000,
    message: 'Taking a bit longer than usual — still processing.',
  },
  { delayMs: 180_000, message: 'Still here, working through it.' },
  { delayMs: 300_000, message: 'Complex request — still going.' },
];

/**
 * Start escalating progress timers for an interactive task.
 * Returns a cleanup function that cancels all pending timers.
 */
function startProgressMonitor(
  sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>,
  chatJid: string,
  threadId?: string,
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let cancelled = false;

  for (const { delayMs, message } of PROGRESS_INTERVALS) {
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        await sendMessage(chatJid, message, threadId);
        logger.debug({ chatJid, delayMs, message }, 'Sent progress update');
      } catch (err) {
        logger.warn({ chatJid, err }, 'Failed to send progress update');
      }
    }, delayMs);
    timers.push(timer);
  }

  return () => {
    cancelled = true;
    for (const timer of timers) {
      clearTimeout(timer);
    }
  };
}

// ── Warm-reuse task tracking ─────────────────────────────────────────
// When a warm container is reused for a new task, the streaming callback
// from the original runTask still runs. This queue lets the callback look
// up which task is CURRENTLY producing output — not which task was most
// recently piped in.
//
// Tasks are pushed onto the queue when piped (setContainerCurrentTask)
// and shifted off when their output is fully consumed (status: 'success'
// in the streaming callback). This prevents a newly piped task from
// stealing the thread_id of a still-in-progress task.
const containerTaskQueue = new Map<string, ScheduledTask[]>();

/**
 * Push a new task onto the container's task queue. Called by the warm-reuse
 * callback in index.ts when a new task is piped into an idle container.
 */
export function setContainerCurrentTask(
  containerId: string,
  task: ScheduledTask,
): void {
  const queue = containerTaskQueue.get(containerId);
  if (queue) {
    queue.push(task);
  } else {
    containerTaskQueue.set(containerId, [task]);
  }
}

/**
 * Get the task currently producing output for a container (head of queue).
 */
function getContainerCurrentTask(
  containerId: string,
): ScheduledTask | undefined {
  const queue = containerTaskQueue.get(containerId);
  return queue?.[0];
}

/**
 * Advance the task queue: remove the completed head task so the next
 * queued task becomes current.
 */
function advanceContainerTaskQueue(containerId: string): void {
  const queue = containerTaskQueue.get(containerId);
  if (queue) {
    queue.shift();
    if (queue.length === 0) {
      containerTaskQueue.delete(containerId);
    }
  }
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
    containerId: string,
  ) => void;
  sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
  messageLogger?: MessageLogger;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  containerId: string,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // Start progress monitor for interactive Google Chat messages.
  // Sends "still working" messages at escalating intervals if the agent
  // hasn't produced output. Cancelled as soon as the first result arrives.
  let cancelProgress: (() => void) | null = null;
  if (task.id.startsWith('gchat-msg-')) {
    cancelProgress = startProgressMonitor(
      deps.sendMessage,
      task.chat_jid,
      task.thread_id ?? undefined,
    );
  }

  // Register this task as the current one for this container.
  // When warm-reuse pipes a new task, setContainerCurrentTask pushes
  // onto the queue. The streaming callback reads the HEAD of the queue
  // so outbound messages get the correct thread_id for the task that
  // is actually producing output right now.
  containerTaskQueue.set(containerId, [task]);

  // CONC-02: Fresh session per container. Even 'group' context mode tasks
  // get a fresh session — sharing a sessionId between concurrent containers
  // causes the second to block on the Claude API session lock, defeating
  // the purpose of concurrency. The container still has full group context
  // (CLAUDE.md, mounted repos, etc.) without needing the same session.
  const sessionId = undefined;

  // After the task produces a result, keep the container warm for reuse.
  // TASK_IDLE_TIMEOUT (default 10 min) gives time for another task to be
  // piped into the same container, avoiding a cold start. The GroupQueue
  // manages the warm slot lifecycle — when the timer fires, closeStdin
  // writes _close, the container exits, and runTask's finally block cleans up.
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    // Don't schedule if GroupQueue's notifyIdle already manages the warm timeout.
    // The close sentinel will be written by GroupQueue when the warm timeout fires
    // or when MAX_WARM_PER_GROUP is exceeded. This function is a fallback for
    // containers that don't go through the warm reuse path.
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug(
        { taskId: task.id, containerId },
        'Warm timeout expired in task-scheduler, closing container',
      );
      deps.queue.closeStdin(task.chat_jid, containerId);
    }, TASK_IDLE_TIMEOUT);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        containerId,
        script: task.script || undefined,
        model: task.model || undefined,
      },
      (proc, containerName) =>
        deps.onProcess(
          task.chat_jid,
          proc,
          containerName,
          task.group_folder,
          containerId,
        ),
      async (streamedOutput: ContainerOutput) => {
        // Read the task at the HEAD of the queue — this is the task whose
        // output is currently being streamed. New tasks piped via warm-reuse
        // are appended to the queue and won't become "current" until this
        // one completes (status: 'success').
        const activeTask = getContainerCurrentTask(containerId) || task;

        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Cancel progress monitor — real output has arrived.
          if (cancelProgress) {
            cancelProgress();
            cancelProgress = null;
          }
          // Forward result to user (sendMessage handles formatting).
          // Pass thread_id so Google Chat replies go to the correct thread.
          await deps.sendMessage(
            activeTask.chat_jid,
            streamedOutput.result,
            activeTask.thread_id ?? undefined,
          );

          // Store Holly's response in messages DB for conversation history.
          // This ensures Google Chat (and other channels) have a record of
          // what Holly said, so subsequent messages include full context.
          // Thread ID is read from activeTask so warm-reused containers get
          // the CURRENT task's thread_id, not the original spawning task's.
          if (activeTask.id.startsWith('gchat-msg-')) {
            try {
              storeMessage({
                id: `gchat-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                chat_jid: activeTask.chat_jid,
                sender: ASSISTANT_NAME,
                sender_name: ASSISTANT_NAME,
                content: streamedOutput.result,
                timestamp: new Date().toISOString(),
                is_from_me: true,
                is_bot_message: true,
                thread_id: activeTask.thread_id ?? undefined,
              });
            } catch (err) {
              logger.warn(
                { taskId: activeTask.id, err },
                'Failed to store outbound message for conversation history',
              );
            }
            // Also log to persistent memory.db for cross-session search (Phase 19).
            // streamedOutput.result at this point has already passed through
            // formatOutbound() in the sendMessage lambda, so [SILENT] content
            // is already stripped before reaching here.
            deps.messageLogger?.logMessage({
              id: `gchat-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              chat_jid: activeTask.chat_jid,
              thread_id: activeTask.thread_id ?? null,
              sender: ASSISTANT_NAME,
              sender_name: ASSISTANT_NAME,
              channel: 'google-chat',
              direction: 'outbound',
              content: streamedOutput.result,
              timestamp: new Date().toISOString(),
            });
          }

          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          // This task is done — advance the queue so the next piped task
          // becomes the current one for subsequent output.
          advanceContainerTaskQueue(containerId);
          deps.queue.notifyIdle(activeTask.chat_jid, containerId);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);
    if (cancelProgress) {
      cancelProgress();
      cancelProgress = null;
    }

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    if (cancelProgress) {
      cancelProgress();
      cancelProgress = null;
    }
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  // Clean up container→task tracking (no longer needed after exit)
  containerTaskQueue.delete(containerId);

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;
let schedulerDeps: SchedulerDependencies | null = null;

/**
 * Core scheduler check: find due tasks and enqueue them.
 * Called both by the periodic poll loop and by triggerSchedulerCheck().
 */
function checkDueTasks(deps: SchedulerDependencies): void {
  const dueTasks = getDueTasks();
  if (dueTasks.length > 0) {
    logger.info({ count: dueTasks.length }, 'Found due tasks');
  }

  for (const task of dueTasks) {
    // Re-check task status in case it was paused/cancelled
    const currentTask = getTaskById(task.id);
    if (!currentTask || currentTask.status !== 'active') {
      continue;
    }

    // For one-shot tasks (gchat messages, etc.), null out next_run immediately
    // so the task won't be picked up again by a subsequent scheduler check
    // while the container is still running. Without this, rapid scheduler
    // checks (e.g. triggerSchedulerCheck from a second inbound message) can
    // re-dispatch the same once task after the first container finishes and
    // goes warm, because the dedup check in enqueueTask no longer sees it
    // as "running".
    if (currentTask.schedule_type === 'once') {
      updateTask(currentTask.id, { next_run: null });
    }

    deps.queue.enqueueTask(
      currentTask.chat_jid,
      currentTask.id,
      (containerId) => runTask(currentTask, deps, containerId),
    );
  }
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  schedulerDeps = deps;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      checkDueTasks(deps);
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/**
 * Immediately check for due tasks outside the normal poll cycle.
 * Called by the IPC watcher after creating a new task so interactive
 * messages don't wait up to SCHEDULER_POLL_INTERVAL (60s) to be picked up.
 *
 * Also schedules a follow-up check after 2 seconds to catch tasks whose
 * next_run was set slightly in the future (e.g. IPC tasks arriving in
 * quick succession where the second task isn't due yet at the instant
 * the first trigger fires).
 */
export function triggerSchedulerCheck(): void {
  if (!schedulerDeps) return;
  try {
    checkDueTasks(schedulerDeps);
  } catch (err) {
    logger.error({ err }, 'Error in triggered scheduler check');
  }

  // Follow-up check to catch near-future tasks
  const deps = schedulerDeps;
  setTimeout(() => {
    try {
      checkDueTasks(deps);
    } catch (err) {
      logger.error({ err }, 'Error in delayed scheduler check');
    }
  }, 2000);
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
