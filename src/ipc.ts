import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { sendPoolMessage } from './channels/telegram.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import type { ButtonRows } from './types.js';
import { handleXIpc } from './x-ipc.js';
import { handleOpIpc } from './op-ipc.js';
import type { QueueStatusEntry, QueueMetrics } from './container-runner.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    replyToMessageId?: string,
  ) => Promise<void>;
  sendMessageWithButtons: (
    jid: string,
    text: string,
    buttons: ButtonRows,
    replyToMessageId?: string,
  ) => Promise<void>;
  setTyping: (jid: string, isTyping: boolean) => Promise<void>;
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
  restart: () => Promise<void>;
  triggerSchedulerDrain?: () => void;
  getQueueStatus?: () => QueueStatusEntry[];
  writeQueueStatusSnapshot?: (
    groupFolder: string,
    isMain: boolean,
    entries: QueueStatusEntry[],
    registeredGroups: Record<string, { name: string; folder: string }>,
    metrics?: QueueMetrics,
  ) => void;
  onTasksChanged: () => void;
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
      groupFolders = fs
        .readdirSync(ipcBaseDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'errors')
        .map((entry) => entry.name);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
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
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Stop typing indicator before sending the message
                  await deps.setTyping(data.chatJid, false);

                  // When buttons are present, always use the main bot
                  // (pool bots are send-only Api instances that can't
                  // receive callback_query events).
                  if (data.buttons && Array.isArray(data.buttons)) {
                    await deps.sendMessageWithButtons(
                      data.chatJid,
                      data.text,
                      data.buttons as ButtonRows,
                      data.replyToMessageId,
                    );
                  } else if (data.sender && data.chatJid.startsWith('tg:')) {
                    // Route through pool bot if sender is specified and target is Telegram
                    const sent = await sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                      data.replyToMessageId,
                    );
                    // Fall back to main bot if no pool bots available
                    if (!sent) {
                      await deps.sendMessage(
                        data.chatJid,
                        data.text,
                        data.replyToMessageId,
                      );
                    }
                  } else {
                    await deps.sendMessage(
                      data.chatJid,
                      data.text,
                      data.replyToMessageId,
                    );
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
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
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              const type = data.type as string;

              // X integration requests are fire-and-forget: delete the IPC
              // file immediately and run the (potentially slow) script in the
              // background.  Results are written to x_results/ for the
              // container to poll — blocking the IPC loop would stall message
              // delivery and Telegram bot commands.
              if (type?.startsWith('x_')) {
                fs.unlinkSync(filePath);
                handleXIpc(data, sourceGroup, isMain, DATA_DIR).catch((err) => {
                  logger.error(
                    { file, sourceGroup, err },
                    'Background X IPC handler error',
                  );
                });
                continue;
              }

              // 1Password credential requests: same fire-and-forget pattern.
              // Results are written to op_results/ for the container to poll.
              if (type?.startsWith('op_')) {
                fs.unlinkSync(filePath);
                handleOpIpc(data, sourceGroup, isMain, DATA_DIR).catch((err) => {
                  logger.error(
                    { file, sourceGroup, err },
                    'Background 1Password IPC handler error',
                  );
                });
                continue;
              }

              // Pass source group identity to processTaskIpc for authorization
              const result = await processTaskIpc(
                data,
                sourceGroup,
                isMain,
                deps,
              );
              fs.unlinkSync(filePath);
              // Execute restart AFTER the file is deleted to prevent restart loops
              if (result === 'restart') {
                await deps.restart();
                return; // Process is exiting
              }
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

    // Write queue status snapshot to all active group IPC dirs so containers
    // can read real-time execution state via the get_queue_status MCP tool.
    if (deps.getQueueStatus && deps.writeQueueStatusSnapshot) {
      const queueEntries = deps.getQueueStatus();
      const groups = deps.registeredGroups();
      for (const sourceGroup of groupFolders) {
        const isMain = folderIsMain.get(sourceGroup) === true;
        try {
          deps.writeQueueStatusSnapshot(
            sourceGroup,
            isMain,
            queueEntries,
            groups,
          );
        } catch (err) {
          logger.debug(
            { sourceGroup, err },
            'Failed to write queue status snapshot',
          );
        }
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

/**
 * Process a single IPC task.
 * Returns 'restart' when a restart was requested so the caller can clean up
 * the IPC file before shutting down (otherwise the file persists across
 * restarts and creates an infinite restart loop).
 */
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
    replace_task_id?: string;
    isBackground?: boolean;
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
): Promise<'restart' | void> {
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
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        // Handle replace_task_id: atomically delete old task before creating new one
        if (data.replace_task_id) {
          const oldTask = getTaskById(data.replace_task_id);
          if (oldTask) {
            if (isMain || oldTask.group_folder === sourceGroup) {
              deleteTask(data.replace_task_id);
              logger.info(
                { oldTaskId: data.replace_task_id, sourceGroup },
                'Old task deleted for replacement',
              );
            } else {
              logger.warn(
                { oldTaskId: data.replace_task_id, sourceGroup },
                'Unauthorized replace_task_id: old task belongs to different group',
              );
            }
          } else {
            logger.warn(
              { oldTaskId: data.replace_task_id },
              'replace_task_id not found, proceeding with new task creation',
            );
          }
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        try {
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
        } catch (err) {
          logger.error(
            { taskId, sourceGroup, targetFolder, err },
            'Failed to create task in database (task will be lost)',
          );
          break;
        }
        logger.info(
          {
            taskId,
            sourceGroup,
            targetFolder,
            contextMode,
            scheduleType,
            nextRun,
            isBackground: !!data.isBackground,
          },
          'Task created via IPC',
        );

        // Background tasks should be picked up immediately, not after 60s
        if (data.isBackground) {
          if (deps.triggerSchedulerDrain) {
            logger.info(
              { taskId, sourceGroup },
              'Background task: triggering immediate scheduler drain',
            );
            deps.triggerSchedulerDrain();
          } else {
            logger.warn(
              { taskId, sourceGroup },
              'Background task created but triggerSchedulerDrain not available (will wait up to 60s)',
            );
          }
        }
        deps.onTasksChanged();
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
          deps.onTasksChanged();
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
          deps.onTasksChanged();
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
          deps.onTasksChanged();
        } else {
          logger.warn(
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
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
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
              logger.warn(
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
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
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
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
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
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
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
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'restart':
      // Only main group can trigger a restart.
      // Return 'restart' so the caller can delete the IPC file first,
      // preventing an infinite restart loop.
      if (isMain) {
        logger.info({ sourceGroup }, 'Restart requested via IPC');
        return 'restart';
      } else {
        logger.warn({ sourceGroup }, 'Unauthorized restart attempt blocked');
      }
      break;

    default: {
      const handled = await handleXIpc(data, sourceGroup, isMain, DATA_DIR);
      if (!handled) {
        const handledOp = await handleOpIpc(data, sourceGroup, isMain, DATA_DIR);
        if (!handledOp) {
          logger.warn({ type: data.type }, 'Unknown IPC task type');
        }
      }
    }
  }
}
