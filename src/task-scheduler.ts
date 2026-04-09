import { ChildProcess, execFile } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
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
  logTokenUsage,
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

// ---------------------------------------------------------------------------
// Host-side gate script runner
// ---------------------------------------------------------------------------
// Runs the task's gate script on the host instead of inside a container.
// Container paths (/workspace/group, /workspace/global, ADC) are rewritten
// to their host equivalents. If wakeAgent is false, the container is never
// spawned — eliminating Docker overhead for the common case.

const GATE_SCRIPT_TIMEOUT_MS = 30_000;

interface GateResult {
  wakeAgent: boolean;
  data?: unknown;
}

export async function runGateScript(
  script: string,
  groupFolder: string,
): Promise<GateResult | null> {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const globalDir = path.resolve(GROUPS_DIR, 'global');
  const hostAdcPath = path.join(
    process.env.HOME || os.homedir(),
    '.config',
    'gcloud',
    'application_default_credentials.json',
  );

  // Google Calendar OAuth paths (host equivalents of container mounts)
  const gcalCredsPath = path.join(
    DATA_DIR,
    'google-calendar',
    'gcp-oauth.keys.json',
  );
  const gcalTokenPath = path.join(
    process.env.HOME || os.homedir(),
    '.config',
    'google-calendar-mcp',
    'tokens.json',
  );

  // Rewrite container paths to host paths in the inline script
  let rewritten = script
    .replaceAll('/workspace/group', groupDir)
    .replaceAll('/workspace/global', globalDir)
    .replaceAll(
      '/home/node/.config/gcloud/application_default_credentials.json',
      hostAdcPath,
    )
    .replaceAll('/home/node/.config/gcloud', path.dirname(hostAdcPath))
    .replaceAll(
      '/home/node/.config/google-calendar-mcp/gcp-oauth.keys.json',
      gcalCredsPath,
    )
    .replaceAll(
      '/home/node/.config/google-calendar-mcp/tokens.json',
      gcalTokenPath,
    );

  const scriptPath = path.join(os.tmpdir(), `nanoclaw-gate-${Date.now()}.sh`);
  fs.writeFileSync(scriptPath, rewritten, { mode: 0o755 });

  try {
    return await new Promise<GateResult | null>((resolve) => {
      execFile(
        'bash',
        [scriptPath],
        {
          timeout: GATE_SCRIPT_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            TZ: TIMEZONE,
            GOOGLE_APPLICATION_CREDENTIALS: hostAdcPath,
          },
          cwd: groupDir,
        },
        (error, stdout, stderr) => {
          if (stderr) {
            logger.debug(
              { groupFolder, stderr: stderr.slice(0, 500) },
              'Gate script stderr',
            );
          }
          if (error) {
            logger.warn(
              { groupFolder, error: error.message },
              'Gate script error',
            );
            return resolve(null);
          }

          const lines = stdout.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          if (!lastLine) {
            logger.warn({ groupFolder }, 'Gate script produced no output');
            return resolve(null);
          }

          try {
            const result = JSON.parse(lastLine);
            if (typeof result.wakeAgent !== 'boolean') {
              logger.warn({ groupFolder }, 'Gate script missing wakeAgent');
              return resolve(null);
            }
            resolve(result as GateResult);
          } catch {
            logger.warn(
              { groupFolder, output: lastLine.slice(0, 200) },
              'Gate script output not JSON',
            );
            resolve(null);
          }
        },
      );
    });
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* best effort */
    }
  }
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
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Run gate script on the host — skip the container entirely if wakeAgent is false.
  let gateData: unknown = undefined;
  if (task.script && task.script.trim()) {
    logger.info({ taskId: task.id }, 'Running gate script on host');
    const gateResult = await runGateScript(task.script, task.group_folder);

    if (!gateResult || !gateResult.wakeAgent) {
      const reason = gateResult ? 'wakeAgent=false' : 'script error/no output';
      logger.debug({ taskId: task.id, reason }, 'Gate script skipped agent');
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'success',
        result: null,
        error: null,
      });
      const nextRun = computeNextRun(task);
      updateTaskAfterRun(task.id, nextRun, `Gate: ${reason}`);
      return;
    }

    logger.info({ taskId: task.id }, 'Gate script passed, spawning agent');
    gateData = gateResult.data;
  }

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
    // If the gate script ran on the host, enrich the prompt with its data
    // and don't pass the script to the container (already resolved).
    const prompt =
      gateData !== undefined
        ? `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(gateData, null, 2)}\n\nInstructions:\n${task.prompt}`
        : task.prompt;

    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: gateData !== undefined ? undefined : task.script || undefined,
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
        if (streamedOutput.usage && streamedOutput.usage.input_tokens > 0) {
          logTokenUsage({
            group_folder: task.group_folder,
            input_tokens: streamedOutput.usage.input_tokens,
            output_tokens: streamedOutput.usage.output_tokens,
            cache_read_input_tokens:
              streamedOutput.usage.cache_read_input_tokens,
            cache_creation_input_tokens:
              streamedOutput.usage.cache_creation_input_tokens,
            cost_usd: streamedOutput.usage.cost_usd,
            timestamp: new Date().toISOString(),
          });
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
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

/**
 * Validate every active scheduled task's gate script before the loop starts.
 * Catches the class of bugs where a script is missing, doesn't reference
 * `wakeAgent`, or has obvious syntax errors. Non-fatal — logs a warning per
 * offending task so the operator can see it in the daily digest.
 */
export function lintScheduledTasks(): void {
  const tasks = getAllTasks().filter((t) => t.status === 'active');
  let issueCount = 0;
  for (const t of tasks) {
    // Recurring tasks that fire more than once per day MUST be script-gated.
    // If schedule_type is interval or cron with a sub-daily cadence, script
    // is required.
    let isSubDaily = t.schedule_type === 'interval';
    if (t.schedule_type === 'cron') {
      try {
        const interval = CronExpressionParser.parse(t.schedule_value, {
          tz: TIMEZONE,
        });
        const first = interval.next().getTime();
        const second = interval.next().getTime();
        isSubDaily = second - first < 24 * 60 * 60 * 1000;
      } catch {
        /* malformed — handled elsewhere */
      }
    }
    if (isSubDaily && !t.script) {
      logger.warn(
        { taskId: t.id, schedule: t.schedule_value },
        'Script-gate lint: sub-daily task has no gate script (may over-wake agent)',
      );
      issueCount++;
      continue;
    }
    if (!t.script) continue;
    if (!t.script.includes('wakeAgent')) {
      logger.warn(
        { taskId: t.id },
        'Script-gate lint: script does not reference wakeAgent (probably malformed)',
      );
      issueCount++;
    }
  }
  if (issueCount > 0) {
    logger.warn({ issueCount }, 'Script-gate lint found issues');
  } else {
    logger.info({ taskCount: tasks.length }, 'Script-gate lint clean');
  }
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  lintScheduledTasks();
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
