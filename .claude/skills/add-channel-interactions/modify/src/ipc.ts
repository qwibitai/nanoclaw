import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string, attachments?: string[]) => Promise<void>;
  sendReaction?: (jid: string, emoji: string, targetAuthor: string, targetTimestamp: number) => Promise<void>;
  sendReply?: (jid: string, text: string, targetAuthor: string, targetTimestamp: number, attachments?: string[]) => Promise<void>;
  sendPoll?: (jid: string, question: string, options: string[]) => Promise<void>;
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

/**
 * Resolve container file paths to host paths using known mount mappings.
 * Only paths under known mounts are allowed (prevents path traversal).
 * Missing files are logged and skipped.
 */
function resolveAttachmentPaths(
  containerPaths: string[] | undefined,
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string[] | undefined {
  if (!containerPaths || containerPaths.length === 0) return undefined;

  const prefixMap: Array<[string, string]> = [];

  // /workspace/group/ → groups/{folder}/
  const groupEntry = Object.values(registeredGroups).find(
    (g) => g.folder === sourceGroup,
  );
  if (groupEntry) {
    prefixMap.push([
      '/workspace/group/',
      path.join(GROUPS_DIR, groupEntry.folder) + '/',
    ]);
  }

  // /workspace/ipc/ → data/ipc/{sourceGroup}/
  prefixMap.push([
    '/workspace/ipc/',
    path.join(DATA_DIR, 'ipc', sourceGroup) + '/',
  ]);

  // /workspace/extra/{name}/ → resolved from additionalMounts
  if (groupEntry?.containerConfig?.additionalMounts) {
    for (const mount of groupEntry.containerConfig.additionalMounts) {
      const containerSuffix = mount.containerPath || path.basename(mount.hostPath);
      prefixMap.push([
        `/workspace/extra/${containerSuffix}/`,
        mount.hostPath.replace(/^~/, process.env.HOME || '') + '/',
      ]);
    }
  }

  const resolved: string[] = [];
  for (const containerPath of containerPaths) {
    let hostPath: string | undefined;
    for (const [containerPrefix, hostPrefix] of prefixMap) {
      if (containerPath.startsWith(containerPrefix)) {
        const relative = containerPath.slice(containerPrefix.length);
        const candidate = path.resolve(path.join(hostPrefix, relative));
        if (!candidate.startsWith(path.resolve(hostPrefix) + path.sep)) {
          logger.warn({ containerPath, sourceGroup }, 'Path traversal rejected in attachment');
          continue;
        }
        hostPath = candidate;
        break;
      }
    }

    if (!hostPath) {
      logger.warn({ containerPath, sourceGroup }, 'Attachment path does not match any known mount');
      continue;
    }

    if (!fs.existsSync(hostPath)) {
      logger.warn({ containerPath, hostPath, sourceGroup }, 'Attachment file not found on host');
      continue;
    }

    resolved.push(hostPath);
  }

  return resolved.length > 0 ? resolved : undefined;
}

const MAX_IPC_FILE_SIZE = 1_048_576; // 1MB

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

    for (const sourceGroup of groupFolders) {
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
            const filePath = path.join(messagesDir, file);
            try {
              const stat = fs.statSync(filePath);
              if (stat.size > MAX_IPC_FILE_SIZE) {
                logger.warn({ file, size: stat.size, sourceGroup }, 'IPC file exceeds size limit, skipping');
                fs.renameSync(filePath, filePath + '.oversized');
                continue;
              }
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.chatJid) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                const authorized = isMain || (targetGroup && targetGroup.folder === sourceGroup);

                if (!authorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup, type: data.type },
                    'Unauthorized IPC message attempt blocked',
                  );
                } else if (data.type === 'reaction' && data.emoji && data.targetAuthor && data.targetTimestamp) {
                  if (!deps.sendReaction) {
                    logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Reaction requested but sendReaction not wired');
                  } else {
                    await deps.sendReaction(data.chatJid, data.emoji, data.targetAuthor, data.targetTimestamp);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup, emoji: data.emoji },
                      'IPC reaction sent',
                    );
                  }
                } else if (data.type === 'poll' && data.question && Array.isArray(data.options)) {
                  if (!deps.sendPoll) {
                    logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Poll requested but sendPoll not wired');
                  } else {
                    await deps.sendPoll(data.chatJid, data.question, data.options);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup, question: data.question },
                      'IPC poll sent',
                    );
                  }
                } else if (data.type === 'message' && data.text) {
                  const hostAttachments = resolveAttachmentPaths(
                    data.attachments,
                    sourceGroup,
                    registeredGroups,
                  );
                  if (data.replyToTimestamp && data.replyToAuthor && deps.sendReply) {
                    await deps.sendReply(data.chatJid, data.text, data.replyToAuthor, data.replyToTimestamp, hostAttachments);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup, replyTo: data.replyToTimestamp },
                      'IPC reply sent',
                    );
                  } else {
                    await deps.sendMessage(data.chatJid, data.text, hostAttachments);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC message sent',
                    );
                  }
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
              const stat = fs.statSync(filePath);
              if (stat.size > MAX_IPC_FILE_SIZE) {
                logger.warn({ file, size: stat.size, sourceGroup }, 'IPC file exceeds size limit, skipping');
                fs.renameSync(filePath, filePath + '.oversized');
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
