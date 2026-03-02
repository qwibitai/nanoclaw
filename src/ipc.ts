import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
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
  sendMessage: (jid: string, text: string) => Promise<void>;
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
    // For run_host_command
    // (name and chatJid reused from above)
    // For update_mount_allowlist
    paths?: Array<{ path: string; allowReadWrite?: boolean; description?: string }>;
    replyJid?: string;
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

    case 'run_host_command': {
      const commandName = data.name;
      const replyJid = data.chatJid;

      if (!commandName || !replyJid) {
        logger.warn({ data }, 'run_host_command missing name or chatJid');
        break;
      }

      // Allowlist lives outside the project — tamper-proof from containers
      const allowlistPath = path.join(
        os.homedir(),
        '.config',
        'nanoclaw',
        'host-commands.json',
      );
      let allowlist: HostCommandsAllowlist;
      try {
        allowlist = JSON.parse(
          fs.readFileSync(allowlistPath, 'utf-8'),
        ) as HostCommandsAllowlist;
      } catch (err) {
        logger.warn({ err }, 'Failed to load host-commands.json');
        await deps.sendMessage(
          replyJid,
          `⚠️ Host commands not configured (host-commands.json not found).`,
        );
        break;
      }

      const entry = allowlist.commands?.[commandName];
      if (!entry) {
        const available =
          Object.keys(allowlist.commands || {}).join(', ') || 'none';
        logger.warn({ commandName, sourceGroup }, 'Unknown host command');
        await deps.sendMessage(
          replyJid,
          `Unknown command: \`${commandName}\`\nAvailable: ${available}`,
        );
        break;
      }

      const cmdStr = typeof entry === 'string' ? entry : entry.command;
      const timeout =
        typeof entry === 'object' ? (entry.timeout ?? 120000) : 120000;

      logger.info({ commandName, sourceGroup }, 'Running host command');
      try {
        const output = execSync(cmdStr, {
          encoding: 'utf-8',
          timeout,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: '/bin/bash',
        });
        const trimmed = output.trim().slice(0, 3000);
        await deps.sendMessage(
          replyJid,
          trimmed
            ? `✅ \`${commandName}\`\n\`\`\`\n${trimmed}\n\`\`\``
            : `✅ \`${commandName}\` completed.`,
        );
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const combined = [e.stdout?.trim(), e.stderr?.trim()]
          .filter(Boolean)
          .join('\n')
          .slice(0, 3000);
        logger.error(
          { commandName, err: e.message },
          'Host command failed',
        );
        await deps.sendMessage(
          replyJid,
          combined
            ? `❌ \`${commandName}\` failed\n\`\`\`\n${combined}\n\`\`\``
            : `❌ \`${commandName}\` failed.`,
        );
      }
      break;
    }

    case 'update_mount_allowlist': {
      // Only main group can update the allowlist
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized update_mount_allowlist attempt blocked',
        );
        break;
      }

      const { paths: newPaths, replyJid: allowlistReplyJid } = data as {
        paths?: Array<{ path: string; allowReadWrite?: boolean; description?: string }>;
        replyJid?: string;
      };

      if (!newPaths || !Array.isArray(newPaths) || newPaths.length === 0) {
        logger.warn({ data }, 'update_mount_allowlist missing paths');
        break;
      }

      const allowlistFilePath = path.join(
        os.homedir(),
        '.config',
        'nanoclaw',
        'mount-allowlist.json',
      );

      try {
        let allowlist: {
          allowedRoots: Array<{ path: string; allowReadWrite: boolean; description?: string }>;
          blockedPatterns: string[];
          nonMainReadOnly: boolean;
        };
        try {
          allowlist = JSON.parse(fs.readFileSync(allowlistFilePath, 'utf-8'));
        } catch {
          allowlist = { allowedRoots: [], blockedPatterns: [], nonMainReadOnly: false };
        }

        const added: string[] = [];
        for (const entry of newPaths) {
          const expandedPath = entry.path.startsWith('~/')
            ? path.join(os.homedir(), entry.path.slice(2))
            : entry.path;
          const alreadyExists = allowlist.allowedRoots.some(
            (r) => {
              const rExpanded = r.path.startsWith('~/')
                ? path.join(os.homedir(), r.path.slice(2))
                : r.path;
              return rExpanded === expandedPath;
            },
          );
          if (!alreadyExists) {
            allowlist.allowedRoots.push({
              path: entry.path,
              allowReadWrite: entry.allowReadWrite ?? true,
              ...(entry.description ? { description: entry.description } : {}),
            });
            added.push(entry.path);
          }
        }

        fs.writeFileSync(
          allowlistFilePath,
          JSON.stringify(allowlist, null, 2) + '\n',
        );

        logger.info(
          { added, sourceGroup },
          'Mount allowlist updated via IPC',
        );

        if (allowlistReplyJid) {
          await deps.sendMessage(
            allowlistReplyJid,
            added.length > 0
              ? `Mount allowlist updated: added ${added.join(', ')}`
              : `Mount allowlist unchanged (all paths already present).`,
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to update mount allowlist');
        if (allowlistReplyJid) {
          await deps.sendMessage(
            allowlistReplyJid,
            `Failed to update mount allowlist: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

interface HostCommandEntry {
  command: string;
  description?: string;
  timeout?: number;
}

interface HostCommandsAllowlist {
  commands: Record<string, string | HostCommandEntry>;
}
