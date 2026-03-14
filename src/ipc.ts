import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
  getParentJid,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  addBacklogItem,
  addShipLogEntry,
  createTask,
  deleteBacklogItem,
  deleteTask,
  findMessageById,
  getBacklog,
  getMessagesAroundTimestamp,
  getShipLog,
  getTaskById,
  getThreadMessages,
  getThreadMetadata,
  getThreadOrigin,
  updateBacklogItem,
  updateTask,
} from './db.js';
import { searchThreads } from './thread-search.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
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
      const queriesDir = path.join(ipcBaseDir, sourceGroup, 'queries');

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
                // Handle thread JIDs by checking parent JID for group resolution
                const targetGroup =
                  registeredGroups[data.chatJid] ||
                  registeredGroups[getParentJid(data.chatJid)];
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

      // Process queries from this group's IPC directory (request-response pattern)
      try {
        if (fs.existsSync(queriesDir)) {
          const queryFiles = fs
            .readdirSync(queriesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of queryFiles) {
            const filePath = path.join(queriesDir, file);
            let requestId: string | undefined;
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              requestId = data.requestId;
              processQueryIpc(
                data,
                sourceGroup,
                isMain,
                ipcBaseDir,
                registeredGroups,
              );
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC query',
              );
              if (requestId) {
                writeQueryResponse(ipcBaseDir, sourceGroup, requestId, {
                  status: 'error',
                  error: 'Internal processing error',
                });
              }
            } finally {
              try {
                fs.unlinkSync(filePath);
              } catch {
                /* already deleted */
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC queries directory',
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
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    model?: string;
    // For ship_log / backlog
    itemId?: string;
    title?: string;
    description?: string;
    pr_url?: string;
    branch?: string;
    tags?: string;
    status?: string;
    priority?: string;
    notes?: string;
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
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'set_group_model':
      // Only main group can update group model
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized set_group_model attempt blocked',
        );
        break;
      }
      if (data.jid) {
        const existing = registeredGroups[data.jid];
        if (!existing) {
          logger.warn({ jid: data.jid }, 'set_group_model: unknown JID');
          break;
        }
        const updatedConfig = {
          ...existing.containerConfig,
          ...(data.model ? { model: data.model } : {}),
        };
        // If model is null/empty string, remove the key
        if (!data.model) {
          delete updatedConfig.model;
        }
        deps.registerGroup(data.jid, {
          ...existing,
          containerConfig:
            Object.keys(updatedConfig).length > 0 ? updatedConfig : undefined,
        });
        logger.info(
          { jid: data.jid, model: data.model || '(cleared)' },
          'Group model updated',
        );
      } else {
        logger.warn({ data }, 'set_group_model: missing jid');
      }
      break;

    case 'add_ship_log':
      if (data.title) {
        const entryId = `ship-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        addShipLogEntry({
          id: entryId,
          group_folder: sourceGroup,
          title: data.title,
          description: data.description || null,
          pr_url: data.pr_url || null,
          branch: data.branch || null,
          tags: data.tags || null,
          shipped_at: new Date().toISOString(),
        });
        logger.info(
          { entryId, title: data.title, sourceGroup },
          'Ship log entry added via IPC',
        );
      } else {
        logger.warn({ data }, 'add_ship_log missing title');
      }
      break;

    case 'add_backlog_item':
      if (data.title) {
        const itemId = `backlog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        addBacklogItem({
          id: itemId,
          group_folder: sourceGroup,
          title: data.title,
          description: data.description || null,
          status:
            (data.status as 'open' | 'in_progress' | 'resolved' | 'wont_fix') ||
            'open',
          priority: (data.priority as 'low' | 'medium' | 'high') || 'medium',
          tags: data.tags || null,
          notes: data.notes || null,
          created_at: now,
          updated_at: now,
          resolved_at: null,
        });
        logger.info(
          { itemId, title: data.title, sourceGroup },
          'Backlog item added via IPC',
        );
      } else {
        logger.warn({ data }, 'add_backlog_item missing title');
      }
      break;

    case 'update_backlog_item':
      if (data.itemId) {
        const updates: Parameters<typeof updateBacklogItem>[1] = {};
        if (data.title !== undefined) updates.title = data.title;
        if (data.description !== undefined)
          updates.description = data.description;
        if (data.status !== undefined)
          updates.status = data.status as
            | 'open'
            | 'in_progress'
            | 'resolved'
            | 'wont_fix';
        if (data.priority !== undefined)
          updates.priority = data.priority as 'low' | 'medium' | 'high';
        if (data.tags !== undefined) updates.tags = data.tags;
        if (data.notes !== undefined) updates.notes = data.notes;
        if (data.status === 'resolved' || data.status === 'wont_fix') {
          updates.resolved_at = new Date().toISOString();
        }
        updateBacklogItem(data.itemId, updates);
        logger.info(
          { itemId: data.itemId, updates },
          'Backlog item updated via IPC',
        );
      } else {
        logger.warn({ data }, 'update_backlog_item missing itemId');
      }
      break;

    case 'delete_backlog_item':
      if (data.itemId) {
        deleteBacklogItem(data.itemId, sourceGroup);
        logger.info({ itemId: data.itemId }, 'Backlog item deleted via IPC');
      } else {
        logger.warn({ data }, 'delete_backlog_item missing itemId');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

// --- IPC Query handling (request-response pattern) ---

function writeQueryResponse(
  ipcBaseDir: string,
  groupFolder: string,
  requestId: string,
  response: object,
): void {
  const responseDir = path.join(ipcBaseDir, groupFolder, 'query_responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const filepath = path.join(responseDir, `${requestId}.json`);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(response));
  fs.renameSync(tempPath, filepath);
}

/** Convert DB message rows to IPC wire format. */
function formatMessagesForIpc(
  messages: Array<{
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: number;
  }>,
): Array<{
  sender: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}> {
  return messages.map((m) => ({
    sender: m.sender_name,
    content: m.content,
    timestamp: m.timestamp,
    is_from_me: m.is_from_me === 1,
  }));
}

function processQueryIpc(
  data: {
    type: string;
    requestId: string;
    channelId?: string;
    threadTs?: string;
    chatJid?: string;
    messageId?: string;
    limit?: number;
    query?: string;
    threadKey?: string;
    // For backlog/ship_log queries
    status?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  ipcBaseDir: string,
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  if (!data.requestId) {
    logger.warn({ data }, 'IPC query missing requestId');
    return;
  }

  switch (data.type) {
    case 'read_thread': {
      // Resolve thread JID from Slack channel ID + thread ts
      if (!data.channelId || !data.threadTs) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing channelId or threadTs',
        });
        break;
      }

      const parentJid = `slack:${data.channelId}`;
      const threadJid = `slack:${data.channelId}:thread:${data.threadTs}`;

      // Authorization: verify this group can read from this channel
      const targetGroup =
        registeredGroups[parentJid] ||
        registeredGroups[getParentJid(parentJid)];
      if (!isMain && (!targetGroup || targetGroup.folder !== sourceGroup)) {
        logger.warn(
          { sourceGroup, parentJid },
          'Unauthorized read_thread attempt blocked',
        );
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Unauthorized: channel not accessible to this group',
        });
        break;
      }

      const messages = getThreadMessages(threadJid, data.limit || 50);
      logger.info(
        { sourceGroup, threadJid, count: messages.length },
        'IPC read_thread query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        chatJid: threadJid,
        messages: formatMessagesForIpc(messages),
      });
      break;
    }

    case 'read_messages': {
      // Read messages from a specific JID (parent channel or thread)
      if (!data.chatJid) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing chatJid',
        });
        break;
      }

      const targetGroup2 =
        registeredGroups[data.chatJid] ||
        registeredGroups[getParentJid(data.chatJid)];
      if (!isMain && (!targetGroup2 || targetGroup2.folder !== sourceGroup)) {
        logger.warn(
          { sourceGroup, chatJid: data.chatJid },
          'Unauthorized read_messages attempt blocked',
        );
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Unauthorized: channel not accessible to this group',
        });
        break;
      }

      const msgs = getThreadMessages(data.chatJid, data.limit || 50);
      logger.info(
        { sourceGroup, chatJid: data.chatJid, count: msgs.length },
        'IPC read_messages query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        chatJid: data.chatJid,
        messages: formatMessagesForIpc(msgs),
      });
      break;
    }

    case 'read_discord': {
      // Read messages from a Discord channel or thread by channel ID.
      // Resolves thread channel IDs via thread_origins table.
      // Cross-group reads allowed — URL-is-authorization model.
      if (!data.channelId) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing channelId',
        });
        break;
      }

      // Resolve chat_jid: try direct channel first, then thread_origins
      let chatJid = `dc:${data.channelId}`;
      const threadOrigin = getThreadOrigin(data.channelId);
      if (threadOrigin) {
        chatJid = `${threadOrigin.parent_jid}:thread:${threadOrigin.origin_message_id}`;
      }

      let messages;
      if (data.messageId) {
        // Specific message linked — find it and return context around it.
        // Validate it's a Discord message to prevent cross-platform auth bypass.
        const target = findMessageById(data.messageId);
        if (target && target.chat_jid.startsWith('dc:')) {
          // Use the chat_jid from the found message (most reliable)
          messages = getMessagesAroundTimestamp(
            target.chat_jid,
            target.timestamp,
            data.limit || 50,
          );
          chatJid = target.chat_jid;
        } else {
          // Message not in DB — fall back to latest from the channel
          messages = getThreadMessages(chatJid, data.limit || 50);
        }
      } else {
        messages = getThreadMessages(chatJid, data.limit || 50);
      }

      logger.info(
        {
          sourceGroup,
          chatJid,
          channelId: data.channelId,
          count: messages.length,
        },
        'IPC read_discord query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        chatJid,
        messages: formatMessagesForIpc(messages),
      });
      break;
    }

    case 'read_thread_by_key': {
      // Read thread messages using a thread_key from search_threads results.
      // Resolves the chat_jid by trying each registered parent JID for the group.
      if (!data.threadKey) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing threadKey',
        });
        break;
      }

      const meta = getThreadMetadata(data.threadKey);
      if (!meta) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Thread not found in index',
        });
        break;
      }

      // Security: verify the thread belongs to the requesting group
      if (!isMain && meta.group_folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, threadKey: data.threadKey },
          'Unauthorized read_thread_by_key attempt blocked',
        );
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Unauthorized: thread not accessible to this group',
        });
        break;
      }

      // Find the chat_jid by trying each registered parent JID for this group.
      // Thread chat_jids are "{parentJid}:thread:{threadId}" in the messages table.
      const parentJids = Object.entries(registeredGroups)
        .filter(([, g]) => g.folder === meta.group_folder)
        .map(([jid]) => jid);

      let found = false;
      for (const parentJid of parentJids) {
        const chatJid = `${parentJid}:thread:${meta.thread_id}`;
        const msgs = getThreadMessages(chatJid, data.limit || 100);
        if (msgs.length > 0) {
          logger.info(
            { sourceGroup, chatJid, count: msgs.length },
            'IPC read_thread_by_key query served',
          );
          writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
            status: 'ok',
            chatJid,
            threadKey: data.threadKey,
            messages: formatMessagesForIpc(msgs),
          });
          found = true;
          break;
        }
      }

      if (!found) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'ok',
          threadKey: data.threadKey,
          messages: [],
        });
      }
      break;
    }

    case 'list_groups': {
      const groups = Object.entries(registeredGroups).map(([jid, g]) => ({
        jid,
        name: g.name,
        folder: g.folder,
        trigger: g.trigger,
        isMain: g.isMain || false,
        requiresTrigger: g.requiresTrigger,
        // Only expose containerConfig to the group's own entry or main callers
        containerConfig:
          isMain || g.folder === sourceGroup ? g.containerConfig : undefined,
      }));
      logger.info(
        { sourceGroup, count: groups.length },
        'IPC list_groups query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        groups,
      });
      break;
    }

    case 'search_threads': {
      if (!data.query) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing query',
        });
        break;
      }

      // Security: scope search to sourceGroup (derived from IPC directory, not payload)
      searchThreads(sourceGroup, data.query, data.limit || 5)
        .then((results) => {
          logger.info(
            { sourceGroup, query: data.query, count: results.length },
            'IPC search_threads query served',
          );
          writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
            status: 'ok',
            results,
          });
        })
        .catch((err) => {
          logger.error({ err, sourceGroup }, 'search_threads query failed');
          writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
            status: 'error',
            error: 'Search failed',
          });
        });
      break;
    }

    case 'list_backlog': {
      const items = getBacklog(sourceGroup, data.status, data.limit || 50);
      logger.info(
        { sourceGroup, count: items.length },
        'IPC list_backlog query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        items,
      });
      break;
    }

    case 'list_ship_log': {
      const entries = getShipLog(sourceGroup, data.limit || 20);
      logger.info(
        { sourceGroup, count: entries.length },
        'IPC list_ship_log query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        entries,
      });
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC query type');
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'error',
        error: `Unknown query type: ${data.type}`,
      });
  }
}
