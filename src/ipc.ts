import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, setRegisteredGroup, updateTask } from './db.js';
import { transferFiles } from './file-transfer.js';
import { findGroupByFolder, findJidByFolder, findMainGroupJid, isMainGroup } from './group-helpers.js';
import { logger } from './logger.js';
import { reconcileHeartbeats } from './task-scheduler.js';
import { BackendType, Channel, HeartbeatConfig, RegisteredGroup } from './types.js';
import { DaytonaBackend } from './backends/daytona-backend.js';
import { startDaytonaIpcPoller } from './backends/daytona-ipc-poller.js';
import { startSpritesIpcPoller } from './backends/sprites-ipc-poller.js';
import { SpritesBackend } from './backends/sprites-backend.js';
import { getBackend } from './backends/index.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<string | void>;
  /** Store a message in a group's DB and enqueue it for agent processing */
  notifyGroup: (jid: string, text: string) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  updateGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  findChannel?: (jid: string) => Channel | undefined;
}

// --- Pending share request tracking ---

export interface PendingShareRequest {
  sourceJid: string;
  sourceName: string;
  sourceGroup: string;
  description: string;
  serverFolder?: string;
  timestamp: number;
}

const pendingShareRequests = new Map<string, PendingShareRequest>();
const STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function trackShareRequest(messageId: string, meta: PendingShareRequest): void {
  // Clean stale entries
  const now = Date.now();
  for (const [id, entry] of pendingShareRequests) {
    if (now - entry.timestamp > STALE_TTL_MS) pendingShareRequests.delete(id);
  }
  pendingShareRequests.set(messageId, meta);
  logger.info({ messageId, sourceGroup: meta.sourceGroup }, 'Share request tracked for reaction approval');
}

export function consumeShareRequest(messageId: string): PendingShareRequest | undefined {
  const entry = pendingShareRequests.get(messageId);
  if (entry) pendingShareRequests.delete(messageId);
  return entry;
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
              if (data.type === 'react_to_message' && data.chatJid && data.messageId && data.emoji) {
                const ch = deps.findChannel?.(data.chatJid);
                if (data.remove) {
                  await (ch?.removeReaction?.(data.chatJid, data.messageId, data.emoji) ?? Promise.resolve());
                } else {
                  await (ch?.addReaction?.(data.chatJid, data.messageId, data.emoji) ?? Promise.resolve());
                }
                logger.info(
                  { chatJid: data.chatJid, messageId: data.messageId, emoji: data.emoji, remove: !!data.remove, sourceGroup },
                  'IPC reaction processed',
                );
                fs.unlinkSync(filePath);
                continue;
              }
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: any registered agent can message any other registered agent
                const targetGroup = registeredGroups[data.chatJid];
                const isSelf = targetGroup && targetGroup.folder === sourceGroup;
                const isRegisteredTarget = !!targetGroup;
                if (isMain || isSelf || isRegisteredTarget) {
                  await deps.sendMessage(
                    data.chatJid,
                    data.text,
                  );
                  // Cross-group message: also wake up the target agent
                  if (targetGroup && targetGroup.folder !== sourceGroup) {
                    deps.notifyGroup(data.chatJid, data.text);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked (target not registered)',
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

  // Also start Sprites IPC poller for cloud-backed groups
  startSpritesIpcPoller({
    spritesBackend: (() => {
      try {
        return getBackend('sprites') as SpritesBackend;
      } catch {
        return new SpritesBackend();
      }
    })(),
    registeredGroups: deps.registeredGroups,
    processMessage: async (sourceGroup, data) => {
      const registeredGroups = deps.registeredGroups();
      if (data.type === 'message' && data.chatJid && data.text) {
        const targetGroup = registeredGroups[data.chatJid];
        const isRegisteredTarget = !!targetGroup;
        const isSelf = targetGroup && targetGroup.folder === sourceGroup;
        const isMain = sourceGroup === MAIN_GROUP_FOLDER;
        if (isMain || isSelf || isRegisteredTarget) {
          await deps.sendMessage(data.chatJid, data.text);
          // Cross-group message: also wake up the target agent
          if (targetGroup && targetGroup.folder !== sourceGroup) {
            deps.notifyGroup(data.chatJid, data.text);
          }
          logger.info({ chatJid: data.chatJid, sourceGroup }, 'Sprites IPC message sent');
        }
      }
    },
    processTask: async (sourceGroup, isMain, data) => {
      await processTaskIpc(data, sourceGroup, isMain, deps);
    },
  });

  // Also start Daytona IPC poller for Daytona-backed groups
  startDaytonaIpcPoller({
    daytonaBackend: (() => {
      try {
        return getBackend('daytona') as DaytonaBackend;
      } catch {
        return new DaytonaBackend();
      }
    })(),
    registeredGroups: deps.registeredGroups,
    processMessage: async (sourceGroup, data) => {
      const registeredGroups = deps.registeredGroups();
      if (data.type === 'message' && data.chatJid && data.text) {
        const targetGroup = registeredGroups[data.chatJid];
        const isRegisteredTarget = !!targetGroup;
        const isSelf = targetGroup && targetGroup.folder === sourceGroup;
        const isMain = sourceGroup === MAIN_GROUP_FOLDER;
        if (isMain || isSelf || isRegisteredTarget) {
          await deps.sendMessage(data.chatJid, data.text);
          if (targetGroup && targetGroup.folder !== sourceGroup) {
            deps.notifyGroup(data.chatJid, data.text);
          }
          logger.info({ chatJid: data.chatJid, sourceGroup }, 'Daytona IPC message sent');
        }
      }
    },
    processTask: async (sourceGroup, isMain, data) => {
      await processTaskIpc(data, sourceGroup, isMain, deps);
    },
  });
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
    discord_guild_id?: string;
    // For configure_heartbeat
    enabled?: boolean;
    interval?: string;
    heartbeat_schedule_type?: string;
    target_group_jid?: string;
    // For share_request
    description?: string;
    sourceGroup?: string;
    scope?: string;
    serverFolder?: string;
    discordGuildId?: string;
    target_agent?: string;
    files?: string[];
    request_files?: string[];
    // For register_group: backend config
    backend?: BackendType;
    group_description?: string;
    // For delegate_task
    callbackAgentId?: string;
    // For context_request
    requestedTopics?: string[];
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
        const groupToRegister: RegisteredGroup = {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          backend: data.backend,
          description: data.group_description,
          requiresTrigger: data.requiresTrigger,
        };

        // If a Discord guild ID is provided, set it and compute serverFolder
        if (data.discord_guild_id) {
          groupToRegister.discordGuildId = data.discord_guild_id;
          groupToRegister.serverFolder = `servers/${data.discord_guild_id}`;
        }

        deps.registerGroup(data.jid, groupToRegister);
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'configure_heartbeat': {
      if (data.enabled === undefined) {
        logger.warn({ data }, 'configure_heartbeat missing enabled field');
        break;
      }

      // Resolve target group
      const targetJid = isMain && data.target_group_jid
        ? data.target_group_jid
        : findJidByFolder(registeredGroups, sourceGroup);

      if (!targetJid) {
        logger.warn({ sourceGroup }, 'configure_heartbeat: could not resolve target group');
        break;
      }

      const targetGroup = registeredGroups[targetJid];
      if (!targetGroup) {
        logger.warn({ targetJid }, 'configure_heartbeat: target group not registered');
        break;
      }

      // Authorization: non-main groups can only configure their own heartbeat
      if (!isMain && targetGroup.folder !== sourceGroup) {
        logger.warn({ sourceGroup, targetFolder: targetGroup.folder }, 'Unauthorized configure_heartbeat attempt');
        break;
      }

      const heartbeat: HeartbeatConfig | undefined = data.enabled
        ? {
            enabled: true,
            interval: data.interval || '1800000',
            scheduleType: (data.heartbeat_schedule_type === 'cron' ? 'cron' : 'interval') as 'cron' | 'interval',
          }
        : undefined;

      const updatedGroup: RegisteredGroup = { ...targetGroup, heartbeat };
      deps.updateGroup(targetJid, updatedGroup);
      reconcileHeartbeats(deps.registeredGroups());

      logger.info(
        { targetJid, folder: targetGroup.folder, enabled: data.enabled },
        'Heartbeat configured via IPC',
      );
      break;
    }

    case 'share_request': {
      if (!data.description) {
        logger.warn({ data }, 'share_request missing description');
        break;
      }

      // Find the source group's display name and JID
      const sourceGroupEntry = findGroupByFolder(registeredGroups, sourceGroup);
      const sourceName = sourceGroupEntry?.[1].name || sourceGroup;
      const sourceJid = sourceGroupEntry?.[0] || sourceGroup;

      // If files are specified with a target_agent, do the file transfer
      if (data.target_agent && data.files && data.files.length > 0) {
        const targetGroupEntry = findGroupByFolder(registeredGroups, data.target_agent!);
        if (targetGroupEntry && sourceGroupEntry) {
          const result = await transferFiles({
            sourceGroup: sourceGroupEntry[1],
            targetGroup: targetGroupEntry[1],
            files: data.files,
            direction: 'push',
          });
          logger.info(
            { sourceGroup, targetAgent: data.target_agent, transferred: result.transferred, errors: result.errors },
            'Share request file transfer completed',
          );
        }
      }

      // If request_files are specified, pull files from target to source
      if (data.target_agent && data.request_files && data.request_files.length > 0) {
        const targetGroupEntry = findGroupByFolder(registeredGroups, data.target_agent!);
        if (targetGroupEntry && sourceGroupEntry) {
          const result = await transferFiles({
            sourceGroup: targetGroupEntry[1],
            targetGroup: sourceGroupEntry[1],
            files: data.request_files,
            direction: 'push',
          });
          logger.info(
            { sourceGroup, targetAgent: data.target_agent, transferred: result.transferred },
            'Share request file pull completed',
          );
        }
      }

      // Determine target JID: specific agent or main
      let targetJid: string | undefined;
      if (data.target_agent) {
        targetJid = findJidByFolder(registeredGroups, data.target_agent);
      }
      if (!targetJid) {
        // Fall back to main group
        targetJid = findMainGroupJid(registeredGroups);
      }

      if (!targetJid) {
        logger.warn('share_request: could not find target group JID');
        break;
      }

      // Build path guidance
      const serverFolder = data.serverFolder;
      const scope = data.scope || 'auto';
      let pathGuidance: string;
      if (serverFolder) {
        pathGuidance = `\n\n*Where to write context:*\n• _Channel-specific:_ \`groups/${sourceGroup}/CLAUDE.md\`\n• _Server-wide (all Discord channels):_ \`groups/${serverFolder}/CLAUDE.md\``;
        if (scope === 'server') {
          pathGuidance += ' ← requested';
        } else if (scope === 'channel') {
          pathGuidance = `\n\n*Write context to:* \`groups/${sourceGroup}/CLAUDE.md\``;
        }
      } else {
        pathGuidance = `\n\n*Write context to:* \`groups/${sourceGroup}/CLAUDE.md\``;
      }

      const filesInfo = data.files?.length ? `\n\n*Files shared:* ${data.files.join(', ')}` : '';
      const requestFilesInfo = data.request_files?.length ? `\n\n*Files requested:* ${data.request_files.join(', ')}` : '';
      const targetInfo = data.target_agent ? ` (targeted to ${data.target_agent})` : '';

      const message = `*Context Request* from _${sourceName}_ (${sourceJid})${targetInfo}:\n\n${data.description}${pathGuidance}${filesInfo}${requestFilesInfo}\n\n_React 👍 to approve, or reply manually._`;
      const sentId = await deps.sendMessage(targetJid, message);

      // Track for reaction-based approval
      if (sentId) {
        trackShareRequest(sentId, {
          sourceJid,
          sourceName,
          sourceGroup,
          description: data.description,
          serverFolder,
          timestamp: Date.now(),
        });
      }

      logger.info(
        { sourceGroup, sourceJid, targetJid, scope, serverFolder, targetAgent: data.target_agent, trackedMessageId: sentId },
        'Share request forwarded',
      );
      break;
    }

    case 'delegate_task': {
      if (!data.description) {
        logger.warn({ data }, 'delegate_task missing description');
        break;
      }

      // Find the source group's display name and JID
      const sourceGroupEntry = findGroupByFolder(registeredGroups, sourceGroup);
      const sourceName = sourceGroupEntry?.[1].name || sourceGroup;
      const sourceJid = sourceGroupEntry?.[0] || sourceGroup;
      const callbackAgent = data.callbackAgentId || sourceGroup;

      // Route to admin (main) group for approval
      const mainJid = findMainGroupJid(registeredGroups);
      if (!mainJid) {
        logger.warn('delegate_task: could not find main group JID');
        break;
      }

      const filesInfo = data.files?.length ? `\n\n*Files included:* ${data.files.join(', ')}` : '';
      const delegateMsg = `*Task Request* from _${sourceName}_ (${sourceJid}):\n\n${data.description}${filesInfo}\n\n_React 👍 to approve, or reply manually._`;
      const sentId = await deps.sendMessage(mainJid, delegateMsg);

      // Track for reaction-based approval
      if (sentId) {
        trackShareRequest(sentId, {
          sourceJid,
          sourceName,
          sourceGroup,
          description: `[DELEGATE TASK] ${data.description}\n\nCallback agent: ${callbackAgent}`,
          serverFolder: undefined,
          timestamp: Date.now(),
        });
      }

      logger.info(
        { sourceGroup, callbackAgent, description: data.description.slice(0, 100) },
        'Delegate task forwarded for approval',
      );
      break;
    }

    case 'context_request': {
      if (!data.description) {
        logger.warn({ data }, 'context_request missing description');
        break;
      }

      const sourceGroupEntry = findGroupByFolder(registeredGroups, sourceGroup);
      const sourceName = sourceGroupEntry?.[1].name || sourceGroup;
      const sourceJid = sourceGroupEntry?.[0] || sourceGroup;

      // Route to admin for approval
      const mainJid = findMainGroupJid(registeredGroups);
      if (!mainJid) {
        logger.warn('context_request: could not find main group JID');
        break;
      }

      const topicsInfo = data.requestedTopics?.length ? `\n\n*Requested topics:* ${data.requestedTopics.join(', ')}` : '';
      const contextMsg = `*Context Request* from _${sourceName}_ (${sourceJid}):\n\n${data.description}${topicsInfo}\n\n_React 👍 to approve, or reply manually._`;
      const sentCtxId = await deps.sendMessage(mainJid, contextMsg);

      if (sentCtxId) {
        trackShareRequest(sentCtxId, {
          sourceJid,
          sourceName,
          sourceGroup,
          description: `[CONTEXT REQUEST] ${data.description}${data.requestedTopics?.length ? `\nTopics: ${data.requestedTopics.join(', ')}` : ''}`,
          serverFolder: undefined,
          timestamp: Date.now(),
        });
      }

      logger.info(
        { sourceGroup, description: data.description.slice(0, 100), topics: data.requestedTopics },
        'Context request forwarded for approval',
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
