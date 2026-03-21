import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
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
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  AUTH_ERROR_PATTERN,
  ensureTokenFresh,
  refreshOAuthToken,
} from './oauth.js';
import { isShabbatOrYomTov } from './shabbat.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/** Compute the next run time for a recurring task. Returns null for one-shot tasks. */
function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    return new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run
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

async function notifyMain(
  deps: SchedulerDependencies,
  text: string,
): Promise<void> {
  const groups = deps.registeredGroups();
  const mainJid = Object.entries(groups).find(
    ([_, g]) => g.folder === MAIN_GROUP_FOLDER,
  )?.[0];
  if (mainJid) {
    await deps.sendMessage(mainJid, text);
  }
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
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
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
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    // Pre-flight: refresh token if expired or expiring soon
    await ensureTokenFresh();

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
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      const outputError = output.error || 'Unknown error';

      if (AUTH_ERROR_PATTERN.test(outputError)) {
        logger.warn(
          { taskId: task.id },
          'Auth error in scheduled task, refreshing token and retrying',
        );
        await notifyMain(
          deps,
          '[system] Auth token expired — refreshing and retrying.',
        );
        const refreshed = await refreshOAuthToken();
        if (refreshed) {
          const retry = await runContainerAgent(
            group,
            {
              prompt: task.prompt,
              sessionId,
              groupFolder: task.group_folder,
              chatJid: task.chat_jid,
              isMain,
              isScheduledTask: true,
            },
            (proc, containerName) =>
              deps.onProcess(
                task.chat_jid,
                proc,
                containerName,
                task.group_folder,
              ),
            async (streamedOutput: ContainerOutput) => {
              if (streamedOutput.result) {
                result = streamedOutput.result;
                // Forward result to user (sendMessage handles formatting)
                await deps.sendMessage(task.chat_jid, streamedOutput.result);
              }
              if (streamedOutput.status === 'error') {
                error = streamedOutput.error || 'Unknown error';
              }
            },
          );
          if (retry.status === 'error') {
            error = retry.error || 'Unknown error after retry';
            logger.error(
              { taskId: task.id, error },
              'Scheduled task failed after token refresh',
            );
            await notifyMain(
              deps,
              '[system] Token refresh failed. You may need to run "claude login".',
            );
          } else {
            if (retry.result) result = retry.result;
            await notifyMain(
              deps,
              '[system] Token refreshed. Services restored.',
            );
          }
        } else {
          error = outputError;
          await notifyMain(
            deps,
            '[system] Token refresh failed. You may need to run "claude login".',
          );
        }
      } else {
        error = outputError;
      }
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  // next_run was already advanced before enqueuing (see startSchedulerLoop).
  // Recompute to pass through for the status logic ('once' tasks -> completed).
  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();

      if (isShabbatOrYomTov()) {
        if (dueTasks.length > 0) {
          logger.debug({ count: dueTasks.length }, 'Shabbat/Yom Tov active, skipping due tasks');
        }
        setTimeout(loop, SCHEDULER_POLL_INTERVAL);
        return;
      }

      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Advance next_run BEFORE enqueuing to prevent the next poll from
        // re-discovering this task while it's still running. Without this,
        // a long-running task gets enqueued again on the next 60s poll cycle
        // and executes a second time once the first run finishes.
        const nextRun = computeNextRun(currentTask);
        updateTask(currentTask.id, { next_run: nextRun });

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
