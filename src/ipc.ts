import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { hasPrivilege, VALID_GROUP_TYPES } from './group-type.js';
import { logger } from './logger.js';
import {
  GroupType,
  RegisteredGroup,
  ThreadDefaultGroupType,
  ThreadDefaults,
} from './types.js';

function parseIpcGroupType(value: unknown): GroupType | null {
  if (typeof value === 'string' && VALID_GROUP_TYPES.has(value)) {
    return value as GroupType;
  }
  return null;
}

const VALID_THREAD_DEFAULT_TYPES: ReadonlySet<string> = new Set([
  'chat',
  'thread',
]);

function parseIpcThreadDefaultType(
  value: unknown,
): ThreadDefaultGroupType | null {
  if (typeof value === 'string' && VALID_THREAD_DEFAULT_TYPES.has(value)) {
    return value as ThreadDefaultGroupType;
  }
  return null;
}

/**
 * thread_defaults を IPC 入力から検証して返す。
 * type が不正または特権値の場合は null を返す。
 */
function validateThreadDefaults(
  raw: unknown,
  sourceGroup: string,
): ThreadDefaults | null | false {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn({ sourceGroup }, 'Invalid thread_defaults: not an object');
    return false;
  }
  const td = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(td, 'type')) {
    const parsedType = parseIpcThreadDefaultType(td.type);
    if (!parsedType) {
      logger.warn(
        { sourceGroup, type: td.type },
        'Invalid or privileged thread_defaults.type in register_group request',
      );
      return false;
    }
  }
  return raw as ThreadDefaults;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isPrivileged: boolean,
    availableGroups: AvailableGroup[],
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
    // すべてのグループの IPC ディレクトリをスキャン（ディレクトリ名で識別）
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

    // 登録済みグループから folder→hasPrivilege のルックアップを構築
    const folderPrivilege = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (hasPrivilege(group)) folderPrivilege.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isPrivileged = folderPrivilege.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // このグループの IPC ディレクトリからメッセージを処理
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
                // 認可: このグループが対象の chatJid に送信可能か確認
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isPrivileged ||
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

      // このグループの IPC ディレクトリからタスクを処理
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // 認可のため送信元グループの識別情報を processTaskIpc に渡す
              await processTaskIpc(data, sourceGroup, isPrivileged, deps);
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
    // register_group / update_group 用
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    group_type?: string;
    thread_defaults?: ThreadDefaults;
  },
  sourceGroup: string, // IPC ディレクトリから検証された識別情報
  isPrivileged: boolean, // main または override の特権を持つか
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
        // JID からターゲットグループを解決
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

        // 認可: 特権以外（chat/thread）のグループは自分自身に対してのみスケジュール可能
        if (!isPrivileged && targetFolder !== sourceGroup) {
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
        if (task && (isPrivileged || task.group_folder === sourceGroup)) {
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
        if (task && (isPrivileged || task.group_folder === sourceGroup)) {
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
        if (task && (isPrivileged || task.group_folder === sourceGroup)) {
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
        if (!isPrivileged && task.group_folder !== sourceGroup) {
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

        // スケジュールが変更された場合は next_run を再計算
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
      }
      break;

    case 'refresh_groups':
      // 特権グループ（main/override）のみがリフレッシュを要求可能
      if (isPrivileged) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // 更新されたスナップショットを即座に書き出し
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(sourceGroup, isPrivileged, availableGroups);
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // main または override グループのみが新しいグループを登録可能
      if (!isPrivileged) {
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
        // 多層防御: エージェントは IPC 経由で override を設定できない
        if (data.group_type === 'override') {
          logger.warn({ sourceGroup }, 'override type cannot be set via IPC');
          break;
        }
        const hasGroupType = Object.prototype.hasOwnProperty.call(
          data,
          'group_type',
        );
        const parsedGroupType = hasGroupType
          ? parseIpcGroupType(data.group_type)
          : null;
        if (hasGroupType && !parsedGroupType) {
          logger.warn(
            { sourceGroup, group_type: data.group_type },
            'Invalid group_type in register_group request',
          );
          break;
        }
        const groupType = parsedGroupType ?? 'chat';
        const validatedThreadDefaults = validateThreadDefaults(
          data.thread_defaults,
          sourceGroup,
        );
        if (validatedThreadDefaults === false) {
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          type: groupType,
          thread_defaults: validatedThreadDefaults ?? undefined,
        });
        logger.info(
          { jid: data.jid, folder: data.folder, groupType, sourceGroup },
          'Group registered via IPC',
        );
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'update_group':
      // メイン/override グループのみが既存グループの設定を変更可能
      if (!isPrivileged) {
        logger.warn(
          { sourceGroup },
          'Unauthorized update_group attempt blocked',
        );
        break;
      }
      // override への変更は IPC 経由で不可
      if (data.group_type === 'override') {
        logger.warn({ sourceGroup }, 'override type cannot be set via IPC');
        break;
      }
      if (data.jid && data.group_type) {
        const newType = parseIpcGroupType(data.group_type);
        if (!newType) {
          logger.warn(
            { sourceGroup, group_type: data.group_type },
            'Invalid group_type in update_group request',
          );
          break;
        }
        const targetGroup = registeredGroups[data.jid];
        if (!targetGroup) {
          logger.warn(
            { sourceGroup, jid: data.jid },
            'update_group: target group not found',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          ...targetGroup,
          type: newType,
        });
        logger.info(
          { jid: data.jid, newType, sourceGroup },
          'Group type updated via IPC',
        );
      } else {
        logger.warn(
          { data },
          'Invalid update_group request - missing jid or group_type',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
