import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { computeInitialNextRun } from './task-scheduler.js';
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

  /** Process all .json files in a directory, moving failures to errors/. */
  async function processJsonDir(
    dir: string,
    sourceGroup: string,
    handler: (data: Record<string, unknown>) => Promise<void>,
    label: string,
  ): Promise<void> {
    try {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          await handler(data);
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error(
            { file, sourceGroup, err },
            `Error processing IPC ${label}`,
          );
          const errorDir = path.join(ipcBaseDir, 'errors');
          fs.mkdirSync(errorDir, { recursive: true });
          fs.renameSync(
            filePath,
            path.join(errorDir, `${sourceGroup}-${file}`),
          );
        }
      }
    } catch (err) {
      logger.error(
        { err, sourceGroup },
        `Error reading IPC ${label} directory`,
      );
    }
  }

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

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;

      // Process messages from this group's IPC directory
      await processJsonDir(
        path.join(ipcBaseDir, sourceGroup, 'messages'),
        sourceGroup,
        async (data) => {
          if (data.type === 'message' && data.chatJid && data.text) {
            const targetGroup = registeredGroups[data.chatJid as string];
            if (
              isMain ||
              (targetGroup && targetGroup.folder === sourceGroup)
            ) {
              await deps.sendMessage(data.chatJid as string, data.text as string);
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
          }
        },
        'message',
      );

      // Process tasks from this group's IPC directory
      await processJsonDir(
        path.join(ipcBaseDir, sourceGroup, 'tasks'),
        sourceGroup,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (data) => processTaskIpc(data as any, sourceGroup, isMain, deps),
        'task',
      );
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
    script?: string;
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

        const nextRunResult = computeInitialNextRun(scheduleType, data.schedule_value);
        if ('error' in nextRunResult) {
          logger.warn(
            { scheduleValue: data.schedule_value },
            nextRunResult.error,
          );
          break;
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRunResult.nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
    case 'resume_task':
    case 'cancel_task': {
      if (!data.taskId) break;
      const task = getTaskById(data.taskId);
      if (!task || (!isMain && task.group_folder !== sourceGroup)) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          `Unauthorized task ${data.type.replace('_task', '')} attempt`,
        );
        break;
      }
      if (data.type === 'cancel_task') {
        deleteTask(data.taskId);
      } else {
        updateTask(data.taskId, {
          status: data.type === 'pause_task' ? 'paused' : 'active',
        });
      }
      logger.info(
        { taskId: data.taskId, sourceGroup },
        `Task ${data.type === 'cancel_task' ? 'cancelled' : data.type.replace('_task', '') + 'd'} via IPC`,
      );
      deps.onTasksChanged();
      break;
    }

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
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = { ...task, ...updates };
          const result = computeInitialNextRun(
            updatedTask.schedule_type,
            updatedTask.schedule_value,
          );
          if ('error' in result) {
            logger.warn(
              { taskId: data.taskId, value: updatedTask.schedule_value },
              result.error,
            );
            break;
          }
          updates.next_run = result.nextRun;
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
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
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
