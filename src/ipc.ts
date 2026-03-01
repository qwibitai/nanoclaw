import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { execSync } from 'child_process';
import os from 'os';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
} from './config.js';
import { sendPoolMessage, sendPoolPhoto, sendPoolVoice } from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendPhoto: (jid: string, filePath: string, caption?: string) => Promise<void>;
  sendVoice: (jid: string, filePath: string, caption?: string) => Promise<void>;
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
 * Resolve a container file path to the host filesystem.
 * Container mounts /workspace/group → GROUPS_DIR/{groupFolder}
 */
function resolveContainerPath(containerPath: string, groupFolder: string): string {
  const prefix = '/workspace/group/';
  if (containerPath.startsWith(prefix)) {
    return path.join(GROUPS_DIR, groupFolder, containerPath.slice(prefix.length));
  }
  return containerPath;
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
                  if (data.sender && data.chatJid.startsWith('tg:')) {
                    await sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                    );
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
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
              } else if (data.type === 'photo' && data.chatJid && data.filePath) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const hostPath = resolveContainerPath(data.filePath, sourceGroup);
                  if (!fs.existsSync(hostPath)) {
                    logger.warn(
                      { filePath: data.filePath, hostPath, sourceGroup },
                      'IPC photo file not found on host',
                    );
                  } else if (data.sender && data.chatJid.startsWith('tg:')) {
                    await sendPoolPhoto(
                      data.chatJid,
                      hostPath,
                      data.sender,
                      sourceGroup,
                      data.caption,
                    );
                  } else {
                    await deps.sendPhoto(data.chatJid, hostPath, data.caption);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, filePath: hostPath },
                    'IPC photo sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC photo attempt blocked',
                  );
                }
              } else if (data.type === 'voice' && data.chatJid && data.filePath) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const hostPath = resolveContainerPath(data.filePath, sourceGroup);
                  if (!fs.existsSync(hostPath)) {
                    logger.warn(
                      { filePath: data.filePath, hostPath, sourceGroup },
                      'IPC voice file not found on host',
                    );
                  } else if (data.sender && data.chatJid.startsWith('tg:')) {
                    if (data.text) {
                      await sendPoolMessage(
                        data.chatJid,
                        data.text,
                        data.sender,
                        sourceGroup,
                      );
                    }
                    await sendPoolVoice(
                      data.chatJid,
                      hostPath,
                      data.sender,
                      sourceGroup,
                      data.caption,
                    );
                  } else {
                    if (data.text) {
                      await deps.sendMessage(data.chatJid, data.text);
                    }
                    await deps.sendVoice(data.chatJid, hostPath, data.caption);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, filePath: hostPath },
                    'IPC voice message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC voice attempt blocked',
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
    // For rebuild_dashboard
    requestId?: string;
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
              tz: 'UTC',
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
          const raw = data.schedule_value;
          const hasExplicitTZ =
            /[Zz]$/.test(raw) || /[+-]\d{2}:\d{2}$/.test(raw);
          if (!hasExplicitTZ) {
            logger.warn(
              { scheduleValue: raw },
              'once timestamp missing UTC indicator, assuming UTC',
            );
          }
          const normalized = hasExplicitTZ ? raw : `${raw}Z`;
          const scheduled = new Date(normalized);
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

    case 'rebuild_dashboard':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized rebuild_dashboard attempt blocked',
        );
        break;
      }
      if (!data.requestId) {
        logger.warn('rebuild_dashboard missing requestId');
        break;
      }
      {
        const dashboardDir = path.join(process.cwd(), 'dashboard');
        const responsesDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'responses',
        );
        fs.mkdirSync(responsesDir, { recursive: true });
        const responseFile = path.join(
          responsesDir,
          `${data.requestId}.json`,
        );

        let buildOutput = '';
        let buildSuccess = false;

        // launchd PATH may not include the node/npm directory.
        // Derive it from the running node binary so execSync can find npm.
        const nodeBinDir = path.dirname(process.execPath);
        const execEnv = {
          ...process.env,
          PATH: `${nodeBinDir}:${process.env.PATH || ''}`,
        };

        try {
          buildOutput = execSync('npm run build', {
            cwd: dashboardDir,
            stdio: 'pipe',
            timeout: 120_000,
            env: execEnv,
          }).toString();
          buildSuccess = true;
        } catch (err: unknown) {
          const execErr = err as { stdout?: Buffer; stderr?: Buffer };
          buildOutput = [
            execErr.stdout?.toString() || '',
            execErr.stderr?.toString() || '',
          ]
            .filter(Boolean)
            .join('\n');
        }

        if (buildSuccess) {
          try {
            const uid = os.userInfo().uid;
            execSync(
              `launchctl kickstart -k gui/${uid}/com.nanoclaw-dashboard`,
              { stdio: 'pipe', timeout: 10_000 },
            );
          } catch (restartErr) {
            logger.warn(
              { err: restartErr },
              'Dashboard launchctl restart failed (build succeeded)',
            );
            buildOutput += '\n[Warning: launchctl restart failed]';
          }
        }

        fs.writeFileSync(
          responseFile,
          JSON.stringify({ success: buildSuccess, output: buildOutput }),
        );
        logger.info(
          { requestId: data.requestId, success: buildSuccess },
          'Dashboard rebuild completed',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
