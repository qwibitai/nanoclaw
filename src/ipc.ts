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
import {
  createTask,
  deleteTask,
  getRecentMessages,
  getRecentMessagesByThread,
  getTaskById,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type { MessageLogger } from './message-logger.js';
import { formatMessages } from './router.js';
import { triggerSchedulerCheck } from './task-scheduler.js';
import { RegisteredGroup } from './types.js';

const ALLOWED_TASK_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
]);

export interface IpcDeps {
  sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
  sendAudio: (jid: string, audio: Buffer, mimetype?: string) => Promise<void>;
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
  messageLogger: MessageLogger;
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
                data.type === 'send_audio' &&
                data.chatJid &&
                data.filePath
              ) {
                // Authorization: same rules as text messages
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const audioFilePath = path.join(
                    ipcBaseDir,
                    sourceGroup,
                    'media',
                    data.filePath,
                  );
                  if (fs.existsSync(audioFilePath)) {
                    const audioBuffer = fs.readFileSync(audioFilePath);
                    await deps.sendAudio(
                      data.chatJid,
                      audioBuffer,
                      data.mimetype,
                    );
                    // Clean up the audio file after sending
                    fs.unlinkSync(audioFilePath);
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        file: data.filePath,
                        size: audioBuffer.length,
                      },
                      'IPC audio sent',
                    );
                  } else {
                    logger.warn(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        file: data.filePath,
                      },
                      'IPC audio file not found',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC audio attempt blocked',
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
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For Google Chat message context (gchat-msg-* tasks)
    senderName?: string;
    senderEmail?: string;
    messageText?: string;
    threadId?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    model?: string | null;
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
        let targetGroupEntry = registeredGroups[targetJid];

        // Topic-aware fallback: "telegram:mygroup:241" -> try "telegram:mygroup"
        if (!targetGroupEntry && targetJid.startsWith('telegram:')) {
          const baseJid = targetJid.split(':').slice(0, 2).join(':');
          targetGroupEntry = registeredGroups[baseJid];
          if (targetGroupEntry) {
            logger.debug(
              { targetJid, baseJid },
              'Resolved topic JID to base Telegram group',
            );
          }
        }

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        // ISO-01: derive folder from sourceGroup to preserve topic suffix.
        // When sourceGroup is the same group (or topic thereof) as the target,
        // use sourceGroup directly so the topic ID is preserved in group_folder.
        // For cross-group scheduling (main scheduling another group), use
        // targetGroupEntry.folder — sourceGroup is the scheduler, not the target.
        const sourceBase = sourceGroup.replace(/_\d+$/, '');
        const targetFolder =
          sourceGroup === targetGroupEntry.folder ||
          sourceBase === targetGroupEntry.folder
            ? sourceGroup
            : targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves.
        // Topic IPC dirs (e.g. telegram_mygroup_241) belong to their parent group.
        if (
          !isMain &&
          targetFolder !== sourceGroup &&
          targetFolder !== sourceBase
        ) {
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

        // ── Conversation history injection (Google Chat + Telegram) ──
        // For interactive chat messages (gchat-msg-* / tg-msg-* tasks), store
        // the inbound message in the messages DB and prepend recent
        // conversation history to the prompt. This ensures Holly has
        // context even when spawned in a fresh container.
        //
        // Thread-scoped: when a threadId is present, only messages from
        // the same thread are included in history. This prevents topic
        // pollution when multiple Chat threads are active simultaneously.
        let enrichedPrompt = data.prompt;
        if (
          (taskId.startsWith('gchat-msg-') || taskId.startsWith('tg-msg-')) &&
          data.senderName
        ) {
          const now = new Date().toISOString();
          const msgPrefix = taskId.startsWith('tg-msg-') ? 'tg-in' : 'gchat-in';
          const msgId = `${msgPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const threadId = data.threadId || null;

          // Ensure chat metadata exists (foreign key constraint)
          const ipcChannel =
            targetJid.startsWith('gchat:') || targetJid.startsWith('spaces/')
              ? 'google-chat'
              : targetJid.startsWith('telegram:')
                ? 'telegram'
                : 'whatsapp';
          storeChatMetadata(targetJid, now, undefined, ipcChannel);

          // Store the inbound message with thread context
          storeMessage({
            id: msgId,
            chat_jid: targetJid,
            sender: data.senderEmail || data.senderName,
            sender_name: data.senderName,
            content: data.messageText || '',
            timestamp: now,
            is_from_me: false,
            is_bot_message: false,
            thread_id: threadId ?? undefined,
          });

          // Also persist to memory.db for cross-session search
          deps.messageLogger.logMessage({
            id: msgId,
            chat_jid: targetJid,
            thread_id: threadId ?? null,
            sender: data.senderEmail || data.senderName || 'unknown',
            sender_name: data.senderName || 'Craig',
            channel: ipcChannel,
            direction: 'inbound',
            content: data.messageText || '',
            timestamp: now,
          });

          // Fetch recent conversation history scoped to this thread.
          // When threadId is present, only messages from the same thread
          // are returned — preventing cross-thread context pollution.
          const recentMessages = getRecentMessagesByThread(
            targetJid,
            threadId,
            20,
          );
          if (recentMessages.length > 1) {
            // More than just this message — there's history to include
            // Exclude the message we just stored (it's already in the prompt)
            const history = recentMessages.filter((m) => m.id !== msgId);
            if (history.length > 0) {
              const formattedHistory = formatMessages(history, TIMEZONE);
              enrichedPrompt =
                `<conversation-history>\n${formattedHistory}\n</conversation-history>\n\n` +
                data.prompt;
            }
          }

          logger.info(
            {
              taskId,
              chatJid: targetJid,
              historyCount: recentMessages.length - 1,
              sender: data.senderName,
              threadId: threadId || 'none',
            },
            'Message stored with thread-scoped conversation history',
          );
        }

        // Validate model if provided
        let taskModel: string | null = null;
        if (data.model) {
          if (!ALLOWED_TASK_MODELS.has(data.model)) {
            logger.warn({ model: data.model }, 'Invalid model value, ignoring');
          } else {
            taskModel = data.model;
          }
        }

        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: enrichedPrompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          thread_id: data.threadId != null ? String(data.threadId) : null,
          model: taskModel,
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );

        // Immediately notify the scheduler so interactive messages don't
        // wait up to SCHEDULER_POLL_INTERVAL (60s) for the next poll cycle.
        triggerSchedulerCheck();
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
            {
              taskId: data.taskId,
              sourceGroup,
              taskGroupFolder: task?.group_folder,
            },
            'Unauthorized task pause attempt blocked — (group, topicId) mismatch',
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
            {
              taskId: data.taskId,
              sourceGroup,
              taskGroupFolder: task?.group_folder,
            },
            'Unauthorized task resume attempt blocked — (group, topicId) mismatch',
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
            {
              taskId: data.taskId,
              sourceGroup,
              taskGroupFolder: task?.group_folder,
            },
            'Unauthorized task cancel attempt blocked — (group, topicId) mismatch',
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
            {
              taskId: data.taskId,
              sourceGroup,
              taskGroupFolder: task.group_folder,
            },
            'Unauthorized task update attempt blocked — (group, topicId) mismatch',
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
        if (data.model !== undefined) {
          if (data.model === null || data.model === '') {
            updates.model = null;
          } else if (ALLOWED_TASK_MODELS.has(data.model)) {
            updates.model = data.model;
          } else {
            logger.warn(
              { model: data.model },
              'Invalid model value in update_task, ignoring',
            );
          }
        }

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
