import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendMessageWithId?: (
    jid: string,
    text: string,
  ) => Promise<string | undefined>;
  editMessage?: (jid: string, messageId: string, text: string) => Promise<void>;
  deleteMessage?: (jid: string, messageId: string) => Promise<void>;
  pinMessage?: (jid: string, messageId: string) => Promise<void>;
  unpinMessage?: (jid: string, messageId: string) => Promise<void>;
  addReaction?: (
    jid: string,
    messageId: string,
    emoji: string,
  ) => Promise<void>;
  removeReaction?: (
    jid: string,
    messageId: string,
    emoji: string,
  ) => Promise<void>;
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
  onPoisonedMessage?: (sourceGroup: string, text: string) => void;
}

// Same patterns as index.ts hallucinated-outage guard — kept in sync manually.
// If the agent sends a message via IPC that matches these, the session is
// poisoned and should be purged so the next turn starts fresh.
const POISONED_MESSAGE_PATTERNS = [
  /no such tool available/i,
  /tools? (are|is) offline/i,
  /mcp.*(dropped|disconnected|reconnected)/i,
  /sheets.*(offline|disconnected|flaky|dropped|down)/i,
  /hard[- ]?refresh/i,
  /restart the (bot|session)/i,
  /api just disconnected/i,
  /hasn.?t reconnected/i,
];

let ipcWatcherRunning = false;

/**
 * Decide whether a `message` IPC payload should upsert-edit an existing
 * labeled message instead of posting a new one. Pure function for testing.
 *
 * Returns:
 *   { action: 'edit', id }  — label exists and upsert requested
 *   { action: 'create' }    — post a new message (label mapping updates after)
 */
export function decideMessageAction(
  data: { upsert?: boolean; label?: string },
  labels: Record<string, string>,
): { action: 'edit'; id: string } | { action: 'create' } {
  if (data.upsert && data.label) {
    const id = labels[data.label];
    if (id) return { action: 'edit', id };
  }
  return { action: 'create' };
}

function labelFilePath(sourceGroup: string): string {
  return path.join(DATA_DIR, 'sessions', sourceGroup, 'message_labels.json');
}

function readLabels(sourceGroup: string): Record<string, string> {
  try {
    const p = labelFilePath(sourceGroup);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function writeLabels(
  sourceGroup: string,
  labels: Record<string, string>,
): void {
  const p = labelFilePath(sourceGroup);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(labels, null, 2));
}

function isAuthorized(
  chatJid: string,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  if (isMain) return true;
  const g = registeredGroups[chatJid];
  return !!(g && g.folder === sourceGroup);
}

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
              const jid: string | undefined = data.chatJid;
              if (
                jid &&
                !isAuthorized(jid, sourceGroup, isMain, registeredGroups)
              ) {
                logger.warn(
                  { chatJid: jid, sourceGroup, type: data.type },
                  'Unauthorized IPC message attempt blocked',
                );
              } else if (data.type === 'message' && jid && data.text) {
                // Upsert: if caller passed `upsert: true` with a label that
                // already exists, edit the existing message instead of
                // posting a new one. Lets the agent use a single call for
                // the pin-once-then-edit pattern.
                const decision = decideMessageAction(
                  data,
                  readLabels(sourceGroup),
                );
                if (decision.action === 'edit' && deps.editMessage) {
                  await deps.editMessage(jid, decision.id, data.text);
                  logger.info(
                    { chatJid: jid, sourceGroup, label: data.label },
                    'IPC message upserted (edit)',
                  );
                  try {
                    fs.unlinkSync(filePath);
                  } catch {
                    /* ignore */
                  }
                  continue;
                }
                if (data.label && deps.sendMessageWithId) {
                  const id = await deps.sendMessageWithId(jid, data.text);
                  if (id) {
                    const labels = readLabels(sourceGroup);
                    labels[data.label] = id;
                    writeLabels(sourceGroup, labels);
                    if (data.pin && deps.pinMessage) {
                      await deps.pinMessage(jid, id);
                    }
                  }
                } else {
                  await deps.sendMessage(jid, data.text);
                }
                logger.info(
                  { chatJid: jid, sourceGroup, label: data.label },
                  'IPC message sent',
                );
                // Check for hallucinated-outage content sent via IPC
                if (deps.onPoisonedMessage) {
                  const hit = POISONED_MESSAGE_PATTERNS.find((re) =>
                    re.test(data.text),
                  );
                  if (hit) {
                    logger.warn(
                      {
                        sourceGroup,
                        pattern: hit.source,
                        snippet: data.text.slice(0, 160),
                      },
                      'Detected hallucinated-outage in IPC message — purging session',
                    );
                    deps.onPoisonedMessage(sourceGroup, data.text);
                  }
                }
              } else if (
                data.type === 'edit_message' &&
                jid &&
                data.label &&
                data.text &&
                deps.editMessage
              ) {
                const labels = readLabels(sourceGroup);
                const id = labels[data.label];
                if (id) {
                  await deps.editMessage(jid, id, data.text);
                  logger.info(
                    { chatJid: jid, label: data.label },
                    'IPC message edited',
                  );
                } else {
                  logger.warn(
                    { label: data.label, sourceGroup },
                    'Edit: label not found',
                  );
                }
              } else if (
                data.type === 'delete_message' &&
                jid &&
                data.label &&
                deps.deleteMessage
              ) {
                const labels = readLabels(sourceGroup);
                const id = labels[data.label];
                if (id) {
                  await deps.deleteMessage(jid, id);
                  delete labels[data.label];
                  writeLabels(sourceGroup, labels);
                }
              } else if (
                data.type === 'pin_message' &&
                jid &&
                data.label &&
                deps.pinMessage
              ) {
                const labels = readLabels(sourceGroup);
                const id = labels[data.label];
                if (id) await deps.pinMessage(jid, id);
              } else if (
                data.type === 'unpin_message' &&
                jid &&
                data.label &&
                deps.unpinMessage
              ) {
                const labels = readLabels(sourceGroup);
                const id = labels[data.label];
                if (id) await deps.unpinMessage(jid, id);
              } else if (
                data.type === 'add_reaction' &&
                jid &&
                data.emoji &&
                deps.addReaction
              ) {
                let id: string | undefined = data.messageId;
                if (!id && data.label) {
                  const labels = readLabels(sourceGroup);
                  id = labels[data.label];
                }
                if (id) await deps.addReaction(jid, id, data.emoji);
              } else if (
                data.type === 'remove_reaction' &&
                jid &&
                data.emoji &&
                deps.removeReaction
              ) {
                let id: string | undefined = data.messageId;
                if (!id && data.label) {
                  const labels = readLabels(sourceGroup);
                  id = labels[data.label];
                }
                if (id) await deps.removeReaction(jid, id, data.emoji);
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

        // Enforce gate scripts on sub-daily recurring tasks to prevent
        // unnecessary container spawns. Once-a-day or slower is fine ungated.
        const hasScript = !!(data.script && data.script.trim());
        let isSubDaily = scheduleType === 'interval';
        if (scheduleType === 'cron' && nextRun) {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            const first = interval.next().getTime();
            const second = interval.next().getTime();
            isSubDaily = second - first < 24 * 60 * 60 * 1000;
          } catch {
            // Already validated above — shouldn't happen
          }
        }
        if (isSubDaily && !hasScript) {
          logger.warn(
            { sourceGroup, scheduleValue: data.schedule_value },
            'Rejected sub-daily task without gate script',
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
          next_run: nextRun,
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
