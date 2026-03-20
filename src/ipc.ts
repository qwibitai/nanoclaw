import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  MEM0_USER_ID,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteSession,
  deleteTask,
  getTaskById,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  searchMemories,
  addMemory,
  updateMemory,
  removeMemory,
  forgetSession,
  forgetTimerange,
  getMemoryHistory,
} from './mem0-memory.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendReaction?: (
    jid: string,
    emoji: string,
    messageId?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  unregisterGroup?: (jid: string) => boolean;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  statusHeartbeat?: () => void;
  recoverPendingMessages?: () => void;
}

let ipcWatcherRunning = false;
const RECOVERY_INTERVAL_MS = 60_000;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  let lastRecoveryTime = Date.now();

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
                data.type === 'reaction' &&
                data.chatJid &&
                data.emoji &&
                deps.sendReaction
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  try {
                    await deps.sendReaction(
                      data.chatJid,
                      data.emoji,
                      data.messageId,
                    );
                    logger.info(
                      { chatJid: data.chatJid, emoji: data.emoji, sourceGroup },
                      'IPC reaction sent',
                    );
                  } catch (err) {
                    logger.error(
                      {
                        chatJid: data.chatJid,
                        emoji: data.emoji,
                        sourceGroup,
                        err,
                      },
                      'IPC reaction failed',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC reaction attempt blocked',
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

      // Process memory operations from this group's IPC directory
      const memoryDir = path.join(ipcBaseDir, sourceGroup, 'memory');
      try {
        if (fs.existsSync(memoryDir)) {
          const memoryFiles = fs
            .readdirSync(memoryDir)
            .filter((f) => f.endsWith('.json') && !f.startsWith('res-'));
          for (const file of memoryFiles) {
            const filePath = path.join(memoryDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processMemoryIpc(data, sourceGroup, isMain, memoryDir);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC memory operation',
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
          'Error reading IPC memory directory',
        );
      }
    }

    // Status emoji heartbeat — detect dead containers with stale emoji state
    deps.statusHeartbeat?.();

    // Periodic message recovery — catch stuck messages after retry exhaustion or pipeline stalls
    const now = Date.now();
    if (now - lastRecoveryTime >= RECOVERY_INTERVAL_MS) {
      lastRecoveryTime = now;
      deps.recoverPendingMessages?.();
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
    // For run_claude_code
    workdir?: string;
    timeout_seconds?: number;
    request_id?: string;
    session_id?: string;
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

    case 'run_claude_code': {
      const prompt = data.prompt as string;
      const workdir = (data.workdir as string) || process.cwd();
      const timeoutSec = Math.min((data.timeout_seconds as number) || 120, 600);
      const requestId = data.request_id as string;
      const resumeSessionId = data.session_id as string | undefined;

      if (!prompt || !requestId) {
        logger.warn({ data }, 'Invalid run_claude_code request');
        break;
      }

      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      logger.info(
        { workdir, timeoutSec, sourceGroup, resume: resumeSessionId },
        'Running Claude Code task via IPC',
      );

      (async () => {
        const responseFile = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'memory',
          `res-${requestId}.json`,
        );
        try {
          const args = [
            '-p',
            prompt,
            '--dangerously-skip-permissions',
            '--output-format',
            'json',
          ];
          if (resumeSessionId) {
            args.push('--resume', resumeSessionId);
          }

          const { stdout } = await execFileAsync(
            '/home/admin/.local/bin/claude',
            args,
            {
              cwd: workdir,
              timeout: timeoutSec * 1000,
              maxBuffer: 10 * 1024 * 1024,
              env: { ...process.env, HOME: '/home/admin' },
            },
          );

          // Parse JSON output to extract session_id and result text
          let sessionId = '';
          let resultText = '';
          try {
            const events = stdout.trim().split('\n').filter(Boolean);
            for (const line of events) {
              const evt = JSON.parse(line.startsWith('[') ? line : `[${line}]`);
              const items = Array.isArray(evt) ? evt : [evt];
              for (const item of items) {
                if (item.session_id) sessionId = item.session_id;
                if (item.type === 'result' && item.result) {
                  resultText =
                    typeof item.result === 'string'
                      ? item.result
                      : JSON.stringify(item.result);
                }
                // Also capture assistant text messages
                if (item.type === 'assistant' && item.message?.content) {
                  for (const block of item.message.content) {
                    if (block.type === 'text') resultText = block.text;
                  }
                }
              }
            }
          } catch {
            resultText = stdout.slice(0, 5000);
          }

          const response = {
            result: resultText || '(no output)',
            session_id: sessionId,
            resumed: !!resumeSessionId,
          };
          fs.writeFileSync(responseFile, JSON.stringify(response));
          logger.info(
            { sourceGroup, sessionId, chars: resultText.length },
            'Claude Code task completed',
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          fs.writeFileSync(
            responseFile,
            JSON.stringify({ error: errMsg.slice(0, 500), session_id: '' }),
          );
          logger.error({ err, sourceGroup }, 'Claude Code task failed');
        }
      })();
      break;
    }

    case 'reset_session': {
      const resetGroup = data.groupFolder as string;
      if (resetGroup && (isMain || resetGroup === sourceGroup)) {
        deleteSession(resetGroup);
        logger.info(
          { groupFolder: resetGroup, sourceGroup },
          'Session reset via IPC',
        );
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function processMemoryIpc(
  data: { type: string; [key: string]: unknown },
  sourceGroup: string,
  isMain: boolean,
  memoryDir: string,
): Promise<void> {
  const userId = (data.user_id as string) || MEM0_USER_ID;

  switch (data.type) {
    case 'memory_add': {
      const result = await addMemory({
        messages: [{ role: 'user', content: data.content as string }],
        userId,
        runId: (data.run_id as string) || `${sourceGroup}:ipc:live`,
        metadata: (data.metadata as Record<string, unknown>) || {},
      });
      logger.info({ sourceGroup, memoryId: result }, 'Memory added via IPC');
      break;
    }

    case 'memory_update': {
      await updateMemory(data.memory_id as string, data.content as string);
      logger.info(
        { sourceGroup, memoryId: data.memory_id },
        'Memory updated via IPC',
      );
      break;
    }

    case 'memory_remove': {
      await removeMemory(data.memory_id as string);
      logger.info(
        { sourceGroup, memoryId: data.memory_id },
        'Memory removed via IPC',
      );
      break;
    }

    case 'memory_search': {
      const results = await searchMemories(
        data.query as string,
        userId,
        (data.limit as number) || 10,
      );
      // Write response file for the container to read
      const responseFile = path.join(
        memoryDir,
        `res-${data.request_id || Date.now()}.json`,
      );
      fs.writeFileSync(responseFile, JSON.stringify({ results }, null, 2));
      logger.debug(
        { sourceGroup, resultCount: results.length },
        'Memory search via IPC',
      );
      break;
    }

    case 'memory_forget_session': {
      await forgetSession(data.run_id as string);
      logger.info(
        { sourceGroup, runId: data.run_id },
        'Session forgotten via IPC',
      );
      break;
    }

    case 'memory_forget_timerange': {
      const deleted = await forgetTimerange(
        userId,
        data.before as string,
        data.after as string,
      );
      logger.info({ sourceGroup, deleted }, 'Timerange forgotten via IPC');
      break;
    }

    case 'memory_history': {
      const history = await getMemoryHistory(data.memory_id as string);
      const responseFile = path.join(
        memoryDir,
        `res-${data.request_id || Date.now()}.json`,
      );
      fs.writeFileSync(responseFile, JSON.stringify({ history }, null, 2));
      break;
    }

    default:
      logger.warn({ type: data.type, sourceGroup }, 'Unknown memory IPC type');
  }
}
