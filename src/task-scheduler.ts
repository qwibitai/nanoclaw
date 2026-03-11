import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  BUDGET_SCHEDULED,
  CLI_ENABLED,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MODEL_SCHEDULED,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { runCliAgent } from './cli-runner.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeMessagesSnapshot,
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
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

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
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
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

  // Write messages snapshot so container can query cross-channel activity
  writeMessagesSnapshot(task.group_folder);

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

  // Determine execution mode: CLI (Max subscription) or container (API credits)
  const useCliMode =
    CLI_ENABLED && task.execution_mode !== 'container';
  const fallbackEnabled = task.fallback_to_container !== 0;

  if (useCliMode) {
    // --- CLI path: run via host Claude Code (Max subscription, no API cost) ---
    logger.info(
      { taskId: task.id, group: task.group_folder },
      'Running task via CLI agent (Max subscription)',
    );

    try {
      const cliOutput = await runCliAgent(
        {
          prompt: task.prompt,
          groupFolder: task.group_folder,
          isMain,
          model: task.model || undefined,
          extraSecretScopes: group.containerConfig?.extraSecretScopes,
        },
        (proc) =>
          deps.onProcess(task.chat_jid, proc, `cli-${task.id}`, task.group_folder),
      );

      if (cliOutput.status === 'error') {
        error = cliOutput.error || 'Unknown CLI error';
        logger.warn(
          { taskId: task.id, error },
          'CLI agent failed',
        );

        // Fallback to container if enabled
        if (fallbackEnabled) {
          logger.info(
            { taskId: task.id },
            'Falling back to container (API credits)',
          );
          error = null; // Reset error for fallback attempt
          await runTaskViaContainer(task, group, isMain, deps, startTime, (r, e) => {
            result = r;
            error = e;
          });
        }
      } else if (cliOutput.result) {
        result = cliOutput.result;
        // Forward CLI result to user
        await deps.sendMessage(task.chat_jid, cliOutput.result);
      }

      if (!error) {
        logger.info(
          { taskId: task.id, durationMs: Date.now() - startTime, mode: 'cli' },
          'Task completed',
        );
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: task.id, error, mode: 'cli' }, 'CLI task failed');

      // Fallback to container on exception
      if (fallbackEnabled) {
        logger.info(
          { taskId: task.id },
          'Falling back to container after CLI exception',
        );
        error = null;
        try {
          await runTaskViaContainer(task, group, isMain, deps, startTime, (r, e) => {
            result = r;
            error = e;
          });
        } catch (fallbackErr) {
          error = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          logger.error({ taskId: task.id, error }, 'Container fallback also failed');
        }
      }
    }
  } else {
    // --- Container path: run via Docker/Apple Container (API credits) ---
    await runTaskViaContainer(task, group, isMain, deps, startTime, (r, e) => {
      result = r;
      error = e;
    });
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

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

/**
 * Runs a task via the container path (Docker/Apple Container, API credits).
 * Extracted so it can be used as a fallback from CLI mode.
 */
async function runTaskViaContainer(
  task: ScheduledTask,
  group: RegisteredGroup,
  isMain: boolean,
  deps: SchedulerDependencies,
  startTime: number,
  onResult: (result: string | null, error: string | null) => void,
): Promise<void> {
  let result: string | null = null;
  let error: string | null = null;

  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { taskId: task.id },
        'Scheduled task idle timeout, closing container stdin',
      );
      deps.queue.closeStdin(task.chat_jid);
    }, IDLE_TIMEOUT);
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
        model: task.model || MODEL_SCHEDULED,
        maxBudgetUsd: task.budget_usd ?? BUDGET_SCHEDULED,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          resetIdleTimer();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime, mode: 'container' },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error, mode: 'container' }, 'Task failed');
  }

  onResult(result, error);
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
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // If a cron task's next_run is >10 min in the past, skip to next future
        // run instead of executing. Prevents stale tasks from endlessly re-queueing
        // (e.g. after downtime or missed runs).
        if (currentTask.schedule_type === 'cron' && currentTask.next_run) {
          const staleness =
            Date.now() - new Date(currentTask.next_run).getTime();
          if (staleness > 10 * 60 * 1000) {
            try {
              const nextRun = CronExpressionParser.parse(
                currentTask.schedule_value,
                {
                  tz: TIMEZONE,
                },
              )
                .next()
                .toISOString();
              logger.warn(
                {
                  taskId: currentTask.id,
                  staleMinutes: Math.round(staleness / 60000),
                  nextRun,
                },
                'Skipping stale cron task, advancing to next run',
              );
              updateTask(currentTask.id, { next_run: nextRun });
              continue;
            } catch {
              logger.error(
                { taskId: currentTask.id },
                'Failed to parse cron for stale task',
              );
            }
          }
        }

        // Advance next_run BEFORE enqueueing to prevent the 60s scheduler poll
        // from re-finding this task as "due" before it finishes executing.
        if (currentTask.schedule_type === 'cron') {
          try {
            const preAdvanceNextRun = CronExpressionParser.parse(
              currentTask.schedule_value,
              { tz: TIMEZONE },
            ).next().toISOString();
            updateTask(currentTask.id, { next_run: preAdvanceNextRun });
          } catch { /* runTask will handle the error */ }
        } else if (currentTask.schedule_type === 'once') {
          // Mark once-tasks as paused immediately to prevent double-fire
          updateTask(currentTask.id, { status: 'paused' });
        }

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
