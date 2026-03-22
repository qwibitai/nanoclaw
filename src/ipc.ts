import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import type pino from 'pino';

import {
  DATA_DIR,
  IPC_FALLBACK_POLL_INTERVAL,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { AvailableGroup, writeTasksSnapshot } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  updateTask,
} from './db/index.js';
import { isValidGroupFolder } from './group-folder.js';
import { createCorrelationLogger, logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
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

  let processing = false;

  const processIpcFiles = async () => {
    // Prevent concurrent processing from overlapping watch + poll triggers
    if (processing) return;
    processing = true;

    try {
      // Scan all group IPC directories (identity determined by directory)
      let groupFolders: string[];
      try {
        groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
          const stat = fs.statSync(path.join(ipcBaseDir, f));
          return stat.isDirectory() && f !== 'errors';
        });
      } catch (err) {
        logger.error({ err }, 'Error reading IPC base directory');
        return;
      }

      const registeredGroups = deps.registeredGroups();

      // Build folder→isMain lookup from registered groups
      const folderIsMain = new Map<string, boolean>();
      for (const group of Object.values(registeredGroups)) {
        if (group.isMain) folderIsMain.set(group.folder, true);
      }

      for (const sourceGroup of groupFolders) {
        const isMain = folderIsMain.get(sourceGroup) === true;
        const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
        const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

        // Process messages from this group's IPC directory
        try {
          if (fs.existsSync(messagesDir)) {
            const messageFiles = fs
              .readdirSync(messagesDir)
              .filter((f) => f.endsWith('.json'));
            for (const file of messageFiles) {
              const filePath = path.join(messagesDir, file);
              const log = createCorrelationLogger(undefined, {
                op: 'ipc-message',
                sourceGroup,
                file,
              });
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if (data.type === 'message' && data.chatJid && data.text) {
                  // Authorization: verify this group can send to this chatJid
                  const targetGroup = registeredGroups[data.chatJid];
                  if (
                    isMain ||
                    (targetGroup && targetGroup.folder === sourceGroup)
                  ) {
                    await deps.sendMessage(data.chatJid, data.text);
                    log.info({ chatJid: data.chatJid }, 'IPC message sent');
                  } else {
                    log.warn(
                      { chatJid: data.chatJid },
                      'Unauthorized IPC message attempt blocked',
                    );
                  }
                }
                fs.unlinkSync(filePath);
              } catch (err) {
                log.error({ err }, 'Error processing IPC message');
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
              const filePath = path.join(tasksDir, file);
              const log = createCorrelationLogger(undefined, {
                op: 'ipc-task',
                sourceGroup,
                file,
              });
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                // Pass source group identity to processTaskIpc for authorization
                await processTaskIpc(data, sourceGroup, isMain, deps, log);
                fs.unlinkSync(filePath);
              } catch (err) {
                log.error({ err }, 'Error processing IPC task');
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
            'Error reading IPC tasks directory',
          );
        }
      }
    } finally {
      processing = false;
    }
  };

  // Debounced trigger: coalesces rapid fs.watch events into a single processing run
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const triggerProcessing = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      processIpcFiles();
    }, 50);
  };

  // Primary: fs.watch for sub-second responsiveness
  try {
    const watcher = fs.watch(
      ipcBaseDir,
      { recursive: true },
      (_eventType, _filename) => {
        triggerProcessing();
      },
    );
    watcher.on('error', (err) => {
      logger.warn(
        { err },
        'fs.watch error on IPC directory — fallback polling will continue',
      );
    });
    logger.info('IPC watcher started with fs.watch (per-group namespaces)');
  } catch (err) {
    logger.warn(
      { err },
      'fs.watch failed to initialize — using polling only for IPC',
    );
  }

  // Fallback: periodic polling to catch any events fs.watch may miss
  setInterval(processIpcFiles, IPC_FALLBACK_POLL_INTERVAL);

  // Initial scan for any files already present
  processIpcFiles();
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
    // For feedback
    feedbackType?: string;
    title?: string;
    description?: string;
    email?: string;
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
  log?: pino.Logger,
): Promise<void> {
  const _log = log ?? logger;
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
          _log.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          _log.warn(
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
            _log.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            _log.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            _log.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        const inserted = createTask({
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

        if (!inserted) {
          _log.warn(
            { taskId, sourceGroup },
            'Duplicate task IPC ignored — task with this ID already exists',
          );
          break;
        }

        // Update the tasks snapshot immediately so list_tasks reflects the new
        // task without waiting for the next scheduled run to update it.
        try {
          const isMainTarget = targetGroupEntry.isMain === true;
          const allTasks = getAllTasks();
          writeTasksSnapshot(
            targetFolder,
            isMainTarget,
            allTasks.map((t) => ({
              id: t.id,
              groupFolder: t.group_folder,
              prompt: t.prompt,
              schedule_type: t.schedule_type,
              schedule_value: t.schedule_value,
              status: t.status,
              next_run: t.next_run,
            })),
          );
        } catch (snapshotErr) {
          _log.warn(
            { snapshotErr },
            'Failed to update tasks snapshot after IPC task creation',
          );
        }

        _log.info(
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
          _log.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          _log.warn(
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
          _log.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          _log.warn(
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
          _log.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          _log.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          _log.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          _log.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              _log.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        _log.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        _log.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        _log.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'feedback': {
      const FEEDBACK_API_URL =
        'https://api.feedback.jeffreykeyser.net/api/v1/feedback';
      const validTypes = ['bug', 'feature'];

      if (!data.feedbackType || !validTypes.includes(data.feedbackType)) {
        _log.warn(
          { feedbackType: data.feedbackType },
          'Invalid feedback type — must be "bug" or "feature"',
        );
        break;
      }
      if (!data.title || typeof data.title !== 'string') {
        _log.warn('Feedback missing required field: title');
        break;
      }
      if (!data.description || typeof data.description !== 'string') {
        _log.warn('Feedback missing required field: description');
        break;
      }

      const feedbackPayload = {
        type: data.feedbackType,
        title: data.title,
        description: data.description,
        source: 'nanoclaw',
        ...(data.email && typeof data.email === 'string'
          ? { email: data.email }
          : {}),
      };

      try {
        const res = await fetch(FEEDBACK_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(feedbackPayload),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          _log.error(
            { status: res.status, body },
            'Feedback API returned non-OK status',
          );
        } else {
          _log.info(
            { feedbackType: data.feedbackType, title: data.title, sourceGroup },
            'Feedback submitted via IPC',
          );
        }
      } catch (err) {
        _log.error({ err }, 'Failed to POST feedback to Feedback Registry');
      }
      break;
    }

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        _log.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          _log.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        _log.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      _log.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
