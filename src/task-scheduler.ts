import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import { MAINTENANCE_SESSION_NAME } from './group-queue.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  setSession,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
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
  /**
   * Nested session cache: `folder → sessionName → sessionId`.
   * Scheduled tasks look up the MAINTENANCE slot's sessionId here so
   * consecutive heartbeat/nightly runs resume their own prior session
   * chain, not the user-facing default container's.
   */
  getSessions: () => Record<string, Record<string, string>>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    sessionName: string,
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
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
    !!group.containerConfig?.trusted,
  );

  let result: string | null = null;
  let error: string | null = null;

  // Scheduled tasks resume THEIR OWN session chain from the `maintenance`
  // slot. The sessions map is keyed by `(groupFolder, sessionName)` —
  // maintenance has its own per-session `.claude/` mount, so its
  // sessionIds are stored and resumed separately from the user-facing
  // default container. `context_mode: 'isolated'` starts fresh each run.
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group'
      ? sessions[task.group_folder]?.[MAINTENANCE_SESSION_NAME]
      : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  // The kill grace after close sentinel is handled by GroupQueue.closeStdin().
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid, MAINTENANCE_SESSION_NAME);
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
        script: task.script || undefined,
        // Route every scheduled task into the parallel `maintenance` slot so
        // it runs concurrently with user-facing work. Sole writer of this
        // value — inbound paths route to `'default'` instead.
        sessionName: MAINTENANCE_SESSION_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(
          task.chat_jid,
          MAINTENANCE_SESSION_NAME,
          proc,
          containerName,
          task.group_folder,
        ),
      async (streamedOutput: ContainerOutput) => {
        // Persist the maintenance session's own sessionId so the NEXT
        // scheduled task on this group can resume the same chain. Only
        // for `context_mode: 'group'` tasks — an isolated task wants a
        // fresh SDK session and its newSessionId would otherwise overwrite
        // the slot and contaminate the next 'group' task's resume.
        if (streamedOutput.newSessionId && task.context_mode === 'group') {
          const groupSessions =
            sessions[task.group_folder] ?? (sessions[task.group_folder] = {});
          groupSessions[MAINTENANCE_SESSION_NAME] = streamedOutput.newSessionId;
          setSession(
            task.group_folder,
            MAINTENANCE_SESSION_NAME,
            streamedOutput.newSessionId,
          );
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Strip <internal> tags — suppress entirely if nothing remains
          const cleanResult = streamedOutput.result
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (cleanResult) {
            await deps.sendMessage(task.chat_jid, cleanResult);
          }
          // Don't close here — agent may still be polling for host script results.
          // Close only on final 'success' status below.
        }
        if (streamedOutput.status === 'success') {
          // No `notifyIdle` here — `notifyIdle` targets the `default` slot
          // only, so calling it from a maintenance-routed task would flip
          // the wrong container's state and could preempt active user work.
          // `scheduleClose` already winds this container down; when runTask
          // finishes, `drainGroup` chains any pending maintenance task.
          scheduleClose();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    // Same write-back path for the terminal `output` (non-streaming case).
    // Same `'group'`-only gate as the streaming path above — don't let an
    // isolated task overwrite the maintenance slot's session chain.
    if (output.newSessionId && task.context_mode === 'group') {
      const groupSessions =
        sessions[task.group_folder] ?? (sessions[task.group_folder] = {});
      groupSessions[MAINTENANCE_SESSION_NAME] = output.newSessionId;
      setSession(
        task.group_folder,
        MAINTENANCE_SESSION_NAME,
        output.newSessionId,
      );
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
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Pre-advance next_run before dispatch to prevent double-fire on crash.
        const claimedNextRun = computeNextRun(currentTask);
        if (claimedNextRun !== null) {
          updateTask(currentTask.id, { next_run: claimedNextRun });
        } else {
          // once-task: mark completed before dispatch
          updateTask(currentTask.id, { status: 'completed' });
        }

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          MAINTENANCE_SESSION_NAME,
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
