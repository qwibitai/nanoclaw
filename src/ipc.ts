import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

// Per-group rate limiting for IPC messages (counts actual files processed, not poll cycles)
const IPC_RATE_LIMIT = 50; // max files per minute per group
const IPC_RATE_WINDOW_MS = 60_000;
const ipcRateMap = new Map<string, { count: number; windowStart: number }>();

function recordIpcFile(group: string): boolean {
  const now = Date.now();
  const entry = ipcRateMap.get(group);
  if (!entry || now - entry.windowStart > IPC_RATE_WINDOW_MS) {
    ipcRateMap.set(group, { count: 1, windowStart: now });
    return true; // under limit
  }
  entry.count++;
  if (entry.count > IPC_RATE_LIMIT) {
    return false; // over limit
  }
  return true; // under limit
}

/**
 * Format an escalation IPC payload as a WhatsApp-friendly message for Blayke.
 * Uses WhatsApp formatting (single asterisks, underscores) — never markdown.
 */
function formatEscalationMessage(
  data: {
    summary: string;
    context: string;
    recommendation: string;
    options?: string[];
    severity?: 'routine' | 'urgent' | 'critical';
    customer_channel?: string | null;
    customer_id?: string | null;
  },
  sourceGroup: string,
): string {
  const severity = data.severity || 'urgent';
  const badge = severity === 'critical' ? '🚨' : severity === 'urgent' ? '⚠' : '🔔';
  const header = `*${badge} ESCALATION* (${severity})`;

  const subjectParts: string[] = [];
  if (data.customer_channel) subjectParts.push(data.customer_channel);
  if (data.customer_id) subjectParts.push(data.customer_id);
  const subject = subjectParts.length ? `_${subjectParts.join(' · ')}_` : `_from ${sourceGroup}_`;

  const lines = [
    header,
    subject,
    '',
    data.summary,
    '',
    `*Andy's take:* ${data.recommendation}`,
  ];

  if (data.options && data.options.length > 0) {
    lines.push('');
    lines.push('Options:');
    for (const opt of data.options) {
      lines.push(`• ${opt}`);
    }
  }

  if (data.context && data.context.trim()) {
    lines.push('');
    lines.push(`_Context:_ ${data.context}`);
  }

  lines.push('');
  lines.push('Reply YES / NO / [counter]');

  return lines.join('\n');
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const rawGroup of groupFolders) {
      // Normalize to prevent path traversal (e.g. "main/../main" bypassing auth)
      const sourceGroup = path.basename(rawGroup);
      if (
        sourceGroup !== rawGroup ||
        sourceGroup === '.' ||
        sourceGroup === '..'
      ) {
        logger.warn({ rawGroup }, 'IPC: skipping invalid group folder name');
        continue;
      }
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            if (!recordIpcFile(sourceGroup)) {
              logger.warn({ sourceGroup }, 'IPC rate limit exceeded (50 files/min), deferring remaining');
              break;
            }
            const filePath = path.join(messagesDir, file);
            try {
              const fileSize = fs.statSync(filePath).size;
              if (fileSize > 1_048_576) {
                logger.warn(
                  { file, sourceGroup, fileSize },
                  'IPC message file too large (>1MB), skipping',
                );
                fs.unlinkSync(filePath);
                continue;
              }
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'escalation' && data.summary && data.recommendation) {
                // Route escalation to the main group's chat regardless of source group.
                // Any registered group can escalate; only the main JID receives the ping.
                const mainEntry = Object.entries(registeredGroups).find(
                  ([, g]) => g.folder === MAIN_GROUP_FOLDER,
                );
                if (!mainEntry) {
                  logger.warn(
                    { sourceGroup },
                    'Escalation dropped: main group not registered',
                  );
                } else {
                  const [mainJid] = mainEntry;
                  const text = formatEscalationMessage(data, sourceGroup);
                  await deps.sendMessage(mainJid, text);
                  logger.info(
                    {
                      audit: 'escalate',
                      sourceGroup,
                      severity: data.severity,
                      summary: data.summary,
                      customer_channel: data.customer_channel,
                      customer_id: data.customer_id,
                      sourceChatJid: data.sourceChatJid,
                      recommendation: data.recommendation,
                      options: data.options,
                    },
                    'Escalation routed to main',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            if (!recordIpcFile(sourceGroup)) {
              logger.warn({ sourceGroup }, 'IPC rate limit exceeded (50 files/min), deferring remaining tasks');
              break;
            }
            const filePath = path.join(tasksDir, file);
            try {
              const fileSize = fs.statSync(filePath).size;
              if (fileSize > 1_048_576) {
                logger.warn(
                  { file, sourceGroup, fileSize },
                  'IPC task file too large (>1MB), skipping',
                );
                fs.unlinkSync(filePath);
                continue;
              }
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'deploy_update':
      // Only main group can trigger deploys
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized deploy_update attempt blocked',
        );
        break;
      }
      logger.info('Deploy triggered via IPC');
      try {
        const deployScript = path.resolve(
          DATA_DIR,
          '..',
          'deploy',
          'deploy.sh',
        );
        const output = execSync(`bash "${deployScript}"`, {
          encoding: 'utf-8',
          timeout: 300000, // 5 minute timeout
          cwd: path.resolve(DATA_DIR, '..'),
        });
        logger.info({ output: output.slice(-500) }, 'Deploy completed');
        // Write result to IPC for the agent to read
        const resultPath = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'deploy_result.json',
        );
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            status: 'success',
            output: output.slice(-2000),
            timestamp: new Date().toISOString(),
          }),
        );
      } catch (err: unknown) {
        const execErr = err as {
          stderr?: Buffer;
          stdout?: Buffer;
          message?: string;
        };
        const stderr =
          execErr.stderr?.toString().slice(-1000) ||
          execErr.message ||
          String(err);
        const stdout = execErr.stdout?.toString().slice(-1000) || '';
        logger.error({ stderr }, 'Deploy failed');
        const resultPath = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'deploy_result.json',
        );
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            status: 'error',
            output: stdout,
            error: stderr,
            timestamp: new Date().toISOString(),
          }),
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
