import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { resolveBackend } from './backends/index.js';
import type { ContainerOutput } from './backends/types.js';
import { writeTasksSnapshot } from './container-runner.js';
import {
  advanceTaskNextRun,
  createTask,
  deleteTask,
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { ContainerProcess, RegisteredGroup, ScheduledTask } from './types.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ContainerProcess, containerName: string, groupFolder: string, lane: 'task') => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

const HEARTBEAT_SENTINEL = '[HEARTBEAT]';

/**
 * Extract the ## Heartbeat section from a CLAUDE.md file.
 * Returns content between `## Heartbeat` and the next `##` heading (or EOF).
 */
function extractHeartbeatSection(content: string): string | null {
  const match = content.match(/^## Heartbeat\n([\s\S]*?)(?=\n## |\n$|$)/m);
  return match ? match[1].trim() : null;
}

/**
 * Build the heartbeat prompt for a group by reading ## Heartbeat from CLAUDE.md.
 * Falls back: group CLAUDE.md → global CLAUDE.md → sensible default.
 */
export function buildHeartbeatPrompt(groupFolder: string): string {
  const groupClaudeMd = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  const globalClaudeMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');

  // Try group-specific CLAUDE.md first
  try {
    const content = fs.readFileSync(groupClaudeMd, 'utf-8');
    const section = extractHeartbeatSection(content);
    if (section) return section;
  } catch {
    // File doesn't exist, fall through
  }

  // Fall back to global CLAUDE.md
  try {
    const content = fs.readFileSync(globalClaudeMd, 'utf-8');
    const section = extractHeartbeatSection(content);
    if (section) return section;
  } catch {
    // File doesn't exist, fall through
  }

  // Sensible default
  return 'Review your ## Goals section for current priorities. Pick the highest-priority actionable item and work on it. Only message the group if there is meaningful progress to report.';
}

/**
 * Reconcile heartbeat tasks with group config.
 * Creates/removes heartbeat scheduled tasks to match each group's heartbeat config.
 */
export function reconcileHeartbeats(
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  const existingTasks = getAllTasks();
  const heartbeatTasks = new Map(
    existingTasks
      .filter((t) => t.id.startsWith('heartbeat-'))
      .map((t) => [t.id, t]),
  );

  for (const [jid, group] of Object.entries(registeredGroups)) {
    const taskId = `heartbeat-${group.folder}`;
    const existing = heartbeatTasks.get(taskId);

    if (group.heartbeat?.enabled) {
      if (!existing) {
        // Create heartbeat task
        let nextRun: string | null = null;
        if (group.heartbeat.scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(group.heartbeat.interval, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ groupFolder: group.folder, interval: group.heartbeat.interval }, 'Invalid heartbeat cron expression');
            continue;
          }
        } else {
          const ms = parseInt(group.heartbeat.interval, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ groupFolder: group.folder, interval: group.heartbeat.interval }, 'Invalid heartbeat interval');
            continue;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        }

        createTask({
          id: taskId,
          group_folder: group.folder,
          chat_jid: jid,
          prompt: HEARTBEAT_SENTINEL,
          schedule_type: group.heartbeat.scheduleType,
          schedule_value: group.heartbeat.interval,
          context_mode: 'group',
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info({ taskId, groupFolder: group.folder }, 'Heartbeat task created');
      } else {
        // Update schedule if it changed
        if (
          existing.schedule_value !== group.heartbeat.interval ||
          existing.schedule_type !== group.heartbeat.scheduleType
        ) {
          // Delete and recreate with new schedule
          deleteTask(taskId);
          let nextRun: string | null = null;
          if (group.heartbeat.scheduleType === 'cron') {
            try {
              const interval = CronExpressionParser.parse(group.heartbeat.interval, { tz: TIMEZONE });
              nextRun = interval.next().toISOString();
            } catch {
              logger.warn({ groupFolder: group.folder }, 'Invalid heartbeat cron on update');
              continue;
            }
          } else {
            const ms = parseInt(group.heartbeat.interval, 10);
            nextRun = new Date(Date.now() + ms).toISOString();
          }
          createTask({
            id: taskId,
            group_folder: group.folder,
            chat_jid: jid,
            prompt: HEARTBEAT_SENTINEL,
            schedule_type: group.heartbeat.scheduleType,
            schedule_value: group.heartbeat.interval,
            context_mode: 'group',
            next_run: nextRun,
            status: 'active',
            created_at: new Date().toISOString(),
          });
          logger.info({ taskId, groupFolder: group.folder }, 'Heartbeat task updated');
        }
      }
      heartbeatTasks.delete(taskId);
    } else if (existing) {
      // Heartbeat disabled or removed — delete the task
      deleteTask(taskId);
      logger.info({ taskId, groupFolder: group.folder }, 'Heartbeat task removed');
      heartbeatTasks.delete(taskId);
    }
  }

  // Clean up orphaned heartbeat tasks (groups that were removed)
  for (const [taskId] of heartbeatTasks) {
    deleteTask(taskId);
    logger.info({ taskId }, 'Orphaned heartbeat task removed');
  }
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

  // For heartbeat tasks, replace sentinel with real prompt from CLAUDE.md
  const prompt = task.id.startsWith('heartbeat-')
    ? buildHeartbeatPrompt(task.group_folder)
    : task.prompt;

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

  // Always use isolated sessions for tasks to prevent session ID conflicts
  // between message and task containers running concurrently
  const sessionId = undefined;

  // Idle timer: writes _close sentinel after IDLE_TIMEOUT of no output,
  // so the container exits instead of hanging at waitForIpcMessage forever.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Scheduled task idle timeout, closing container stdin');
      deps.queue.closeStdin(task.chat_jid, 'task');
    }, IDLE_TIMEOUT);
  };

  try {
    const backend = resolveBackend(group);
    const output = await backend.runAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        discordGuildId: group.discordGuildId,
        serverFolder: group.serverFolder,
      },
      (proc, containerName) => deps.onProcess(task.chat_jid, proc, containerName, task.group_folder, 'task'),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          // Only reset idle timer on actual results, not session-update markers
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
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
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

        // Advance next_run BEFORE enqueuing so this task isn't
        // re-discovered on subsequent ticks while it's running/queued.
        // 'once' tasks (no recurrence) get next_run set to null which
        // also removes them from getDueTasks results.
        let nextRun: string | null = null;
        if (currentTask.schedule_type === 'cron') {
          try {
            const interval = CronExpressionParser.parse(currentTask.schedule_value, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            // Invalid cron — leave null so it completes as a one-shot
          }
        } else if (currentTask.schedule_type === 'interval') {
          const ms = parseInt(currentTask.schedule_value, 10);
          if (!isNaN(ms) && ms > 0) {
            nextRun = new Date(Date.now() + ms).toISOString();
          }
        }
        advanceTaskNextRun(currentTask.id, nextRun);

        const promptPreview = currentTask.id.startsWith('heartbeat-')
          ? 'Heartbeat'
          : currentTask.prompt.slice(0, 100);
        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          () => runTask(currentTask, deps),
          promptPreview,
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
