import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { ContainerOutput, runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { runHostWorker } from './host-worker.js';
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
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Model assignments for scheduled agent tasks.
 * - Intelligence gathering agents: haiku (simple, cost-effective)
 * - Analysis/decision agents: sonnet (reasoning required)
 * Default: haiku for unrecognized agents.
 */
const TASK_MODEL_MAP: Record<string, { model: string; effort: string }> = {
  'neo-intelligence-ch':  { model: 'haiku',  effort: 'low' },
  'neo-x-intel-ch':      { model: 'haiku',  effort: 'low' },
  'neo-housekeeping-ch': { model: 'haiku',  effort: 'low' },
  'neo-portfolio-ch':    { model: 'haiku',  effort: 'medium' },
  'neo-strategies-ch':   { model: 'sonnet', effort: 'high' },
  'neo-risk-ch':         { model: 'sonnet', effort: 'high' },
  'neo-learner-ch':      { model: 'sonnet', effort: 'high' },
  'main':                { model: 'sonnet', effort: 'high' },
};

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  setSessions: (groupFolder: string, sessionId: string) => void;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
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

  const taskModel = TASK_MODEL_MAP[task.group_folder] || { model: 'haiku', effort: 'medium' };
  logger.info(
    { taskId: task.id, model: taskModel.model, effort: taskModel.effort },
    'Model assignment for scheduled task',
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
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT for the
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
    const useHost = group.containerConfig?.useHostWorker === true;
    let output: ContainerOutput;

    // Shared streaming output handler
    const onStreamOutput = async (streamedOutput: ContainerOutput) => {
      if (task.context_mode === 'group' && streamedOutput.newSessionId) {
        deps.setSessions(task.group_folder, streamedOutput.newSessionId);
      }
      if (streamedOutput.result) {
        result = streamedOutput.result;
        await deps.sendMessage(task.chat_jid, streamedOutput.result);
        if (!useHost) scheduleClose();
      }
      if (streamedOutput.status === 'success') {
        deps.queue.notifyIdle(task.chat_jid);
      }
      if (streamedOutput.status === 'error') {
        error = streamedOutput.error || 'Unknown error';
      }
    };

    if (useHost) {
      logger.info(
        { taskId: task.id, model: taskModel.model, cwd: group.containerConfig?.hostWorkerCwd },
        'Running task via host worker',
      );
      output = await runHostWorker(
        group,
        {
          prompt: task.prompt,
          sessionId,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          model: taskModel.model,
          effort: taskModel.effort,
          cwd: group.containerConfig?.hostWorkerCwd || '/root',
        },
        (proc, name) => deps.onProcess(task.chat_jid, proc, name, task.group_folder),
        onStreamOutput,
      );
    } else {
      output = await runContainerAgent(
        group,
        {
          prompt: task.prompt,
          sessionId,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
          model: taskModel.model,
          effort: taskModel.effort,
        },
        (proc, containerName) => deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
        onStreamOutput,
      );
    }

    if (closeTimer) clearTimeout(closeTimer);

    // Persist session ID for group context mode
    if (task.context_mode === 'group' && output.newSessionId) {
      deps.setSessions(task.group_folder, output.newSessionId);
    }
    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }

    logger.info(
      { taskId: task.id, useHost, model: taskModel.model, durationMs: Date.now() - startTime },
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

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info(
'Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info(
{ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          () => runTask(currentTask, deps),
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
