import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeQueueStatusSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

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
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
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
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
      last_run: t.last_run,
      last_result: t.last_result,
      created_at: t.created_at,
      context_mode: t.context_mode,
    })),
  );

  // Update queue status snapshot for container to read
  writeQueueStatusSnapshot(
    task.group_folder,
    isMain,
    deps.queue.getStatus(),
    groups,
    deps.queue.getQueueMetrics(),
  );

  // Advance next_run BEFORE running, so a restart won't re-trigger this execution.
  // If the task fails, next_run is already advanced — this is acceptable because
  // retrying a failed once-task would need manual intervention anyway, and
  // cron/interval tasks will run again at the next scheduled time.
  let advancedNextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    advancedNextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    advancedNextRun = new Date(Date.now() + ms).toISOString();
  } else if (task.schedule_type === 'once') {
    advancedNextRun = '9999-01-01T00:00:00.000Z';
  }
  try {
    updateTask(task.id, { next_run: advancedNextRun });
    logger.debug(
      { taskId: task.id, previousNextRun: task.next_run, advancedNextRun },
      'Advanced next_run before execution',
    );
  } catch (err) {
    logger.error(
      { taskId: task.id, err },
      'Failed to advance next_run, aborting task (will retry next cycle)',
    );
    return;
  }

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // Clear reply context so scheduled tasks don't reply to stale messages
  const groupIpcDir = resolveGroupIpcPath(task.group_folder);
  const replyContextFile = path.join(groupIpcDir, 'reply_context.json');
  try {
    fs.unlinkSync(replyContextFile);
  } catch {
    // Ignore if file does not exist
  }

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeTaskStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
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
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        // Warnings (e.g. large session size) should be forwarded to the user
        // but must NOT set the task result or arm scheduleClose() — the real
        // task hasn't even started yet and closing prematurely would kill it.
        if (streamedOutput.isWarning) {
          if (streamedOutput.result) {
            try {
              await deps.sendMessage(task.chat_jid, streamedOutput.result);
            } catch (err) {
              logger.debug(
                { taskId: task.id, err },
                'Failed to send task warning to chat',
              );
            }
          }
          return;
        }

        if (streamedOutput.result) {
          result = streamedOutput.result;
          logger.info(
            {
              taskId: task.id,
              chatJid: task.chat_jid,
              resultLength: streamedOutput.result.length,
            },
            'Task produced result, sending to primary chat',
          );
          // Forward result to primary chat
          try {
            await deps.sendMessage(task.chat_jid, streamedOutput.result);
          } catch (err) {
            logger.error(
              {
                taskId: task.id,
                chatJid: task.chat_jid,
                resultLength: streamedOutput.result.length,
                err,
              },
              'Failed to send task result to primary chat (message lost)',
            );
          }
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          logger.debug(
            { taskId: task.id },
            'Task container reported success, scheduling close',
          );
          deps.queue.notifyTaskIdle(task.chat_jid);
          scheduleClose();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
          logger.warn(
            { taskId: task.id, error },
            'Task container reported error via streaming output',
          );
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      {
        taskId: task.id,
        durationMs: Date.now() - startTime,
        status: error ? 'error' : 'success',
        hasResult: !!result,
        resultLength: result?.length || 0,
      },
      error ? 'Task completed with error' : 'Task completed successfully',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error(
      { taskId: task.id, durationMs: Date.now() - startTime, error },
      'Task failed with exception',
    );
  }

  const durationMs = Date.now() - startTime;

  try {
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result,
      error,
    });
  } catch (err) {
    logger.error(
      { taskId: task.id, err },
      'Failed to write task run log to database',
    );
  }

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  try {
    updateTaskAfterRun(task.id, nextRun, resultSummary);
  } catch (err) {
    logger.error(
      { taskId: task.id, nextRun, err },
      'Failed to save task result to database (next_run may be stale)',
    );
  }
}

let schedulerRunning = false;
let drainRequested = false;

/**
 * Request the scheduler to run its next iteration immediately instead of
 * waiting for SCHEDULER_POLL_INTERVAL. Used by background tasks to avoid
 * the 60s delay before a newly created `once` task is picked up.
 */
export function triggerSchedulerDrain(): void {
  drainRequested = true;
}

/**
 * Recover tasks that were interrupted by a process restart.
 *
 * A `once` task with next_run='9999-...' and last_run=null was picked up
 * by the scheduler (which advances next_run before execution) but never
 * finished — the process died before updateTaskAfterRun() was called.
 * Reset next_run to now so the scheduler re-executes it.
 */
function recoverStuckTasks(): void {
  const tasks = getAllTasks();
  for (const task of tasks) {
    if (
      task.status === 'active' &&
      task.last_run === null &&
      task.next_run !== null &&
      task.next_run > '9990'
    ) {
      const now = new Date().toISOString();
      updateTask(task.id, { next_run: now });
      logger.info(
        { taskId: task.id, scheduleType: task.schedule_type },
        'Recovered stuck task — reset next_run for re-execution',
      );
    }
  }
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;

  // Recover stuck tasks: a `once` task with next_run=9999 and no last_run
  // was interrupted mid-execution (e.g. by /restart). Reset it so the
  // scheduler picks it up again.
  recoverStuckTasks();

  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask) {
          logger.warn(
            { taskId: task.id },
            'Due task disappeared from database, skipping',
          );
          continue;
        }
        if (currentTask.status !== 'active') {
          logger.debug(
            { taskId: task.id, status: currentTask.status },
            'Due task is no longer active, skipping',
          );
          continue;
        }

        logger.info(
          {
            taskId: currentTask.id,
            chatJid: currentTask.chat_jid,
            scheduleType: currentTask.schedule_type,
          },
          'Enqueuing due task',
        );
        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    const delay = drainRequested ? 0 : SCHEDULER_POLL_INTERVAL;
    if (drainRequested) {
      logger.debug('Scheduler drain requested, checking for tasks immediately');
    }
    drainRequested = false;
    setTimeout(loop, delay);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
