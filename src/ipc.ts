import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createChatRoom, getChatRoom, storeFileMessage } from './chat-db.js';
import { MIME } from './chat-server/files.js';
import { broadcast, broadcastRooms } from './chat-server/state.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const SEND_FILE_MAX_SIZE = 1024 * 1024 * 1024; // 1 GB — match the chat upload cap
const sendFileSeenClientIds = new Map<string, number>();
const SEND_FILE_DEDUP_TTL_MS = 60_000;

function handleSendFile(
  data: {
    chatJid?: string;
    path?: string;
    caption?: string;
    sender?: string;
    client_id?: string;
  },
  sourceGroup: string,
): void {
  const { chatJid, path: relPath, caption, sender, client_id } = data;
  if (!chatJid || !relPath) return;
  if (client_id) {
    const now = Date.now();
    for (const [k, t] of sendFileSeenClientIds) {
      if (now - t > SEND_FILE_DEDUP_TTL_MS) sendFileSeenClientIds.delete(k);
    }
    if (sendFileSeenClientIds.has(client_id)) {
      logger.info({ client_id }, 'send_file deduped (replay)');
      return;
    }
    sendFileSeenClientIds.set(client_id, now);
  }

  // Resolve and confine to the source group's uploads/ dir.
  const groupDir = resolveGroupFolderPath(sourceGroup);
  const uploadsDir = path.join(groupDir, 'uploads');
  // Strip the agent's "uploads/" prefix if it included it (since cwd is the
  // group dir, "uploads/foo.pdf" and "foo.pdf" both make sense).
  const stripped = relPath.replace(/^\/?(workspace\/group\/)?uploads\//, '');
  const candidate = path.resolve(uploadsDir, stripped);
  const rel = path.relative(uploadsDir, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    logger.warn(
      { sourceGroup, relPath },
      'send_file: path outside uploads/ rejected',
    );
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    logger.warn({ sourceGroup, candidate }, 'send_file: file not found');
    return;
  }
  if (stat.isSymbolicLink()) {
    logger.warn({ sourceGroup, candidate }, 'send_file: symlinks rejected');
    return;
  }
  if (!stat.isFile()) {
    logger.warn({ sourceGroup, candidate }, 'send_file: not a regular file');
    return;
  }
  if (stat.size > SEND_FILE_MAX_SIZE) {
    logger.warn(
      { sourceGroup, candidate, size: stat.size },
      'send_file: file exceeds size cap',
    );
    return;
  }

  const filename = path.basename(candidate);
  const ext = path.extname(filename).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const roomId = chatJid.slice('chat:'.length);
  const fileMeta = {
    url: `/api/files/${encodeURIComponent(sourceGroup)}/${encodeURIComponent(filename)}`,
    filename,
    mime,
    size: stat.size,
  };
  const stored = storeFileMessage(
    roomId,
    sender || ASSISTANT_NAME,
    'agent',
    fileMeta,
    caption,
  );
  broadcast(roomId, { type: 'message', ...stored });
  logger.info(
    { roomId, filename, size: stat.size, sourceGroup },
    'IPC send_file delivered',
  );
}

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
              } else if (
                data.type === 'send_file' &&
                data.chatJid &&
                data.path
              ) {
                // Authorization: same rule as 'message'.
                const targetGroup = registeredGroups[data.chatJid];
                const authorized =
                  isMain || (targetGroup && targetGroup.folder === sourceGroup);
                if (!authorized) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC send_file attempt blocked',
                  );
                } else if (!data.chatJid.startsWith('chat:')) {
                  logger.warn(
                    { chatJid: data.chatJid },
                    'send_file is webchat-only; non-chat: JID rejected',
                  );
                } else {
                  await handleSendFile(data, sourceGroup);
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
    instructions?: string;
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
        // If the agent passed bot instructions, seed the new group's CLAUDE.md.
        // The new group's folder is created lazily on first message; create it
        // now so the file persists.
        if (typeof data.instructions === 'string' && data.instructions.trim()) {
          try {
            const groupDir = resolveGroupFolderPath(data.folder);
            fs.mkdirSync(groupDir, { recursive: true });
            const mdPath = path.join(groupDir, 'CLAUDE.md');
            if (!fs.existsSync(mdPath)) {
              fs.writeFileSync(mdPath, data.instructions);
            }
          } catch (err) {
            logger.warn(
              { folder: data.folder, err: String(err) },
              'Failed to write initial CLAUDE.md for new group',
            );
          }
        }
        // Webchat rooms (JID `chat:<id>`) need a corresponding chat_rooms row
        // so the PWA renders them. Idempotent: createChatRoom is INSERT OR IGNORE.
        if (data.jid.startsWith('chat:')) {
          const roomId = data.jid.slice('chat:'.length);
          if (roomId && !getChatRoom(roomId)) {
            try {
              createChatRoom(roomId, data.name);
              // Push the updated room list to all connected PWA clients so
              // the sidebar updates without requiring a manual refresh.
              broadcastRooms();
            } catch (err) {
              logger.warn(
                { roomId, err: String(err) },
                'Failed to create chat room for webchat JID',
              );
            }
          }
        }
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
