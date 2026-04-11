import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  _sanitizeContainerConfig,
  createTask,
  deleteTask,
  getTaskById,
  updateTask,
} from './db.js';
import {
  decodeIpcNamespaceKey,
  encodeIpcNamespaceKey,
  isValidGroupFolder,
} from './group-folder.js';
import { hasPrivilege, VALID_GROUP_TYPES } from './group-type.js';
import { logger } from './logger.js';
import {
  GroupType,
  RegisteredGroup,
  ThreadDefaultGroupType,
  ThreadDefaults,
} from './types.js';

const VALID_CHANNEL_MODES = new Set<
  NonNullable<RegisteredGroup['channel_mode']>
>(['chat', 'url_watch', 'admin_control']);

function parseIpcGroupType(value: unknown): GroupType | null {
  if (typeof value === 'string' && VALID_GROUP_TYPES.has(value)) {
    return value as GroupType;
  }
  return null;
}

function parseIpcChannelMode(
  value: unknown,
): RegisteredGroup['channel_mode'] | undefined {
  if (
    typeof value === 'string' &&
    VALID_CHANNEL_MODES.has(
      value as NonNullable<RegisteredGroup['channel_mode']>,
    )
  ) {
    return value as RegisteredGroup['channel_mode'];
  }
  return undefined;
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
 * - 省略（null/undefined）の場合は null を返す（正常）
 * - オブジェクトでない、または type が不正・特権値の場合は false を返す（リクエストを破棄）
 */
function validateThreadDefaults(
  raw: unknown,
  sourceChatJid: string,
): ThreadDefaults | null | false {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn({ sourceChatJid }, 'Invalid thread_defaults: not an object');
    return false;
  }
  const td = raw as Record<string, unknown>;
  const out: ThreadDefaults = {};
  if (Object.prototype.hasOwnProperty.call(td, 'type')) {
    const parsedType = parseIpcThreadDefaultType(td.type);
    if (!parsedType) {
      logger.warn(
        { sourceChatJid, type: td.type },
        'Invalid or privileged thread_defaults.type in IPC request',
      );
      return false;
    }
    out.type = parsedType;
  }
  if (Object.prototype.hasOwnProperty.call(td, 'requiresTrigger')) {
    if (typeof td.requiresTrigger !== 'boolean') {
      logger.warn(
        { sourceChatJid, requiresTrigger: td.requiresTrigger },
        'Invalid thread_defaults.requiresTrigger: must be boolean',
      );
      return false;
    }
    out.requiresTrigger = td.requiresTrigger;
  }
  if (Object.prototype.hasOwnProperty.call(td, 'containerConfig')) {
    const ccRaw = td.containerConfig as Record<string, unknown> | null;
    if (typeof ccRaw !== 'object' || ccRaw === null || Array.isArray(ccRaw)) {
      logger.warn(
        { sourceChatJid, containerConfig: td.containerConfig },
        'Invalid thread_defaults.containerConfig: must be object',
      );
      return false;
    }
    if (
      Object.prototype.hasOwnProperty.call(ccRaw, 'timeout') &&
      (typeof ccRaw.timeout !== 'number' ||
        !Number.isFinite(ccRaw.timeout) ||
        ccRaw.timeout <= 0)
    ) {
      logger.warn(
        { sourceChatJid, timeout: ccRaw.timeout },
        'Invalid thread_defaults.containerConfig.timeout: must be finite positive number',
      );
      return false;
    }
    if (
      Object.prototype.hasOwnProperty.call(ccRaw, 'additionalMounts') &&
      !Array.isArray(ccRaw.additionalMounts)
    ) {
      logger.warn(
        { sourceChatJid, additionalMounts: ccRaw.additionalMounts },
        'Invalid thread_defaults.containerConfig.additionalMounts: must be array',
      );
      return false;
    }
    const sanitized = _sanitizeContainerConfig(
      ccRaw,
      sourceChatJid,
      'thread_defaults.containerConfig',
    );
    if (!sanitized) {
      logger.warn(
        { sourceChatJid },
        'Invalid thread_defaults.containerConfig in IPC request',
      );
      return false;
    }
    out.containerConfig = sanitized;
  }
  return out;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupJid: string,
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
    // すべての IPC ネームスペースをスキャン（ディレクトリ名は chatJid のエンコード値）
    let namespaceDirs: string[];
    try {
      namespaceDirs = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const namespaceDir of namespaceDirs) {
      const sourceChatJid = decodeIpcNamespaceKey(namespaceDir);
      if (!sourceChatJid) {
        logger.warn({ namespaceDir }, 'Invalid IPC namespace directory');
        continue;
      }

      // 非正規化（未エンコード等）のディレクトリ名は受け付けない
      if (encodeIpcNamespaceKey(sourceChatJid) !== namespaceDir) {
        logger.warn(
          { namespaceDir, sourceChatJid },
          'Ignoring non-canonical IPC namespace directory',
        );
        continue;
      }

      const sourceGroup = registeredGroups[sourceChatJid];
      if (!sourceGroup) {
        logger.warn(
          { sourceChatJid },
          'Ignoring IPC namespace for unregistered group',
        );
        continue;
      }

      const isPrivileged = hasPrivilege(sourceGroup);
      const messagesDir = path.join(ipcBaseDir, namespaceDir, 'messages');
      const tasksDir = path.join(ipcBaseDir, namespaceDir, 'tasks');

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
              if (
                data.type === 'message' &&
                typeof data.chatJid === 'string' &&
                typeof data.text === 'string' &&
                data.chatJid.length > 0 &&
                data.text.length > 0
              ) {
                const targetJid = data.chatJid;
                // 認可: 非特権グループは自身の chatJid にのみ送信可能
                if (isPrivileged || targetJid === sourceChatJid) {
                  await deps.sendMessage(targetJid, data.text);
                  logger.info(
                    { chatJid: targetJid, sourceChatJid },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: targetJid, sourceChatJid },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceChatJid, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${namespaceDir}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceChatJid },
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
              await processTaskIpc(data, sourceChatJid, isPrivileged, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceChatJid, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${namespaceDir}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceChatJid },
          'Error reading IPC tasks directory',
        );
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
    thread_defaults?: unknown;
    channel_mode?: string;
  },
  sourceChatJid: string, // IPC ディレクトリから検証された識別情報（chat JID）
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

        // 認可: 特権以外（chat/thread）のグループは自分自身に対してのみスケジュール可能
        if (!isPrivileged && targetJid !== sourceChatJid) {
          logger.warn(
            { sourceChatJid, targetJid },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

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
          { taskId, sourceChatJid, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isPrivileged || task.chat_jid === sourceChatJid)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceChatJid },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceChatJid },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isPrivileged || task.chat_jid === sourceChatJid)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceChatJid },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceChatJid },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isPrivileged || task.chat_jid === sourceChatJid)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceChatJid },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceChatJid },
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
            { taskId: data.taskId, sourceChatJid },
            'Task not found for update',
          );
          break;
        }
        if (!isPrivileged && task.chat_jid !== sourceChatJid) {
          logger.warn(
            { taskId: data.taskId, sourceChatJid },
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
          { taskId: data.taskId, sourceChatJid, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // 特権グループ（main/override）のみがリフレッシュを要求可能
      if (isPrivileged) {
        logger.info(
          { sourceChatJid },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // 更新されたスナップショットを即座に書き出し
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(sourceChatJid, isPrivileged, availableGroups);
      } else {
        logger.warn(
          { sourceChatJid },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // main または override グループのみが新しいグループを登録可能
      if (!isPrivileged) {
        logger.warn(
          { sourceChatJid },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceChatJid, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // 多層防御: エージェントは IPC 経由で override を設定できない
        if (data.group_type === 'override') {
          logger.warn({ sourceChatJid }, 'override type cannot be set via IPC');
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
            { sourceChatJid, group_type: data.group_type },
            'Invalid group_type in register_group request',
          );
          break;
        }
        const groupType = parsedGroupType ?? 'chat';
        const validatedThreadDefaults = validateThreadDefaults(
          data.thread_defaults,
          sourceChatJid,
        );
        if (validatedThreadDefaults === false) {
          break;
        }
        const hasContainerConfig = Object.prototype.hasOwnProperty.call(
          data,
          'containerConfig',
        );
        const sanitizedContainerConfig = hasContainerConfig
          ? _sanitizeContainerConfig(
              data.containerConfig,
              data.jid,
              'container_config',
            )
          : undefined;
        const channelMode = parseIpcChannelMode(data.channel_mode);
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: sanitizedContainerConfig,
          requiresTrigger: data.requiresTrigger,
          type: groupType,
          thread_defaults: validatedThreadDefaults ?? undefined,
          channel_mode: channelMode,
        });
        logger.info(
          {
            jid: data.jid,
            folder: data.folder,
            groupType,
            sourceChatJid,
          },
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
          { sourceChatJid },
          'Unauthorized update_group attempt blocked',
        );
        break;
      }
      // override への変更は IPC 経由で不可
      if (data.group_type === 'override') {
        logger.warn({ sourceChatJid }, 'override type cannot be set via IPC');
        break;
      }
      if (data.jid) {
        const hasGroupType = Object.prototype.hasOwnProperty.call(
          data,
          'group_type',
        );
        const newType = hasGroupType
          ? parseIpcGroupType(data.group_type)
          : null;
        if (hasGroupType && !newType) {
          logger.warn(
            { sourceChatJid, group_type: data.group_type },
            'Invalid group_type in update_group request',
          );
          break;
        }
        const hasThreadDefaults = Object.prototype.hasOwnProperty.call(
          data,
          'thread_defaults',
        );
        const validatedThreadDefaults = hasThreadDefaults
          ? validateThreadDefaults(data.thread_defaults, sourceChatJid)
          : null;
        if (validatedThreadDefaults === false) {
          break;
        }
        if (!hasGroupType && !hasThreadDefaults) {
          logger.warn(
            { data },
            'Invalid update_group request - no updatable fields',
          );
          break;
        }
        const targetGroup = registeredGroups[data.jid];
        if (!targetGroup) {
          logger.warn(
            { sourceChatJid, jid: data.jid },
            'update_group: target group not found',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          ...targetGroup,
          ...(newType ? { type: newType } : {}),
          ...(hasThreadDefaults
            ? { thread_defaults: validatedThreadDefaults ?? undefined }
            : {}),
        });
        logger.info(
          {
            jid: data.jid,
            ...(newType ? { newType } : {}),
            threadDefaultsUpdated: hasThreadDefaults,
            sourceChatJid,
          },
          'Group updated via IPC',
        );
      } else {
        logger.warn({ data }, 'Invalid update_group request - missing jid');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
