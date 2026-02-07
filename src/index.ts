import dotenv from 'dotenv';
import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';

import { Telegraf, Context, Markup } from 'telegraf';
import { Message, InlineKeyboardButton } from 'telegraf/types';

// Load environment variables from .env file
dotenv.config();

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  STORE_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  AvailableGroup,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllTasks,
  getLastGroupSync,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  initDatabase,
  setLastGroupSync,
  storeChatMetadata,
  storeTelegramMessage,
  updateChatName,
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let bot: Telegraf;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Guards to prevent duplicate loops on reconnect
let ipcWatcherRunning = false;
let groupSyncTimerStarted = false;

async function setTyping(chatId: number, isTyping: boolean): Promise<void> {
  if (!isTyping) return; // Telegram doesn't have a "stop typing" concept
  try {
    await bot.telegram.sendChatAction(chatId, 'typing');
  } catch (err) {
    logger.debug({ chatId, err }, 'Failed to update typing status');
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(
    path.join(DATA_DIR, 'registered_groups.json'),
    {},
  );
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder and subdirectories
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Create IPC directories for the new group
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });

  // Create session directory for the new group
  const groupSessionDir = path.join(DATA_DIR, 'sessions', group.folder);
  fs.mkdirSync(groupSessionDir, { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered with all directories created',
  );
}

/**
 * Sync group metadata from Telegram.
 * Fetches chat information for all known chats and stores their names in the database.
 * Called on startup, daily, and on-demand via IPC.
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  try {
    logger.info('Syncing group metadata from Telegram...');

    // Get all known chats from database
    const chats = getAllChats();
    let count = 0;

    for (const chat of chats) {
      // Skip special marker and private chats (chat_id > 0)
      if (chat.chat_id === -1 || chat.chat_id > 0) continue;

      try {
        const chatInfo = await bot.telegram.getChat(chat.chat_id);

        // Groups have title property
        if ('title' in chatInfo && chatInfo.title) {
          updateChatName(chat.chat_id, chatInfo.title);
          count++;
        }
      } catch (err) {
        logger.debug({ chatId: chat.chat_id, err }, 'Failed to fetch chat info');
      }
    }

    setLastGroupSync();
    logger.info({ count }, 'Group metadata synced');
  } catch (err) {
    logger.error({ err }, 'Failed to sync group metadata');
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredChatIds = new Set(
    Object.keys(registeredGroups).map((k) => parseInt(k, 10)),
  );

  return chats
    .filter((c) => c.chat_id !== -1 && c.chat_id < 0) // Telegram groups have negative chat_id
    .map((c) => ({
      chatId: c.chat_id,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredChatIds.has(c.chat_id),
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_id.toString()];
  if (!group) return;

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Main group responds to all messages; other groups require trigger prefix
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_id.toString()] || '';
  const missedMessages = getMessagesSince(
    msg.chat_id,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  const lines = missedMessages.map((m) => {
    // Escape XML special characters in content
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing message',
  );

  await setTyping(msg.chat_id, true);
  const response = await runAgent(group, prompt, msg.chat_id.toString(), msg.message_thread_id);
  await setTyping(msg.chat_id, false);

  if (response) {
    lastAgentTimestamp[msg.chat_id.toString()] = msg.timestamp;
    await sendMessage(msg.chat_id, `${ASSISTANT_NAME}: ${response}`, undefined, msg.message_thread_id);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatId: string,
  messageThreadId?: number,
): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatId,
      isMain,
      messageThreadId,
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return null;
  }
}

async function sendMessage(
  chatId: number | string,
  text: string,
  buttons?: InlineKeyboardButton[][],
  messageThreadId?: number,
): Promise<void> {
  try {
    const chatIdNum = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
    const options: any = {
      parse_mode: 'Markdown',
    };

    if (buttons && buttons.length > 0) {
      options.reply_markup = {
        inline_keyboard: buttons,
      };
    }

    if (messageThreadId) {
      options.message_thread_id = messageThreadId;
    }

    try {
      await bot.telegram.sendMessage(chatIdNum, text, options);
      logger.info({ chatId: chatIdNum, length: text.length, hasButtons: !!buttons, messageThreadId }, 'Message sent');
    } catch (markdownErr: any) {
      // If Markdown parsing fails, retry without parse_mode (plain text)
      if (markdownErr.description?.includes('parse entities')) {
        logger.warn({ chatId: chatIdNum, error: markdownErr.description }, 'Markdown parse failed, retrying as plain text');
        const plainOptions: any = {};
        if (buttons && buttons.length > 0) {
          plainOptions.reply_markup = options.reply_markup;
        }
        if (messageThreadId) {
          plainOptions.message_thread_id = messageThreadId;
        }
        await bot.telegram.sendMessage(chatIdNum, text, plainOptions);
        logger.info({ chatId: chatIdNum, length: text.length, hasButtons: !!buttons, messageThreadId }, 'Message sent (plain text fallback)');
      } else {
        throw markdownErr;
      }
    }
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send message');
  }
}

function startIpcWatcher(): void {
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
              // Support both chatId and chatJid for backward compatibility
              const chatId = data.chatId || data.chatJid;
              if (data.type === 'message' && chatId && data.text) {
                // Authorization: verify this group can send to this chatId
                const targetGroup = registeredGroups[chatId.toString()];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await sendMessage(
                    chatId,
                    `${ASSISTANT_NAME}: ${data.text}`,
                    data.buttons, // Pass through buttons if present
                    data.messageThreadId, // Pass through message_thread_id if present
                  );
                  logger.info(
                    { chatId, sourceGroup, hasButtons: !!data.buttons, messageThreadId: data.messageThreadId },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatId, sourceGroup },
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
              logger.debug(
                { file, sourceGroup, type: data.type },
                'Processing IPC task file',
              );
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
              logger.debug({ file, sourceGroup }, 'IPC task file processed');
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

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatId?: number; // Used for both schedule_task and register_group
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const {
    createTask,
    updateTask,
    deleteTask,
    getTaskById: getTask,
  } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.groupFolder
      ) {
        // Authorization: non-main groups can only schedule for themselves
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetGroup },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        // Resolve the correct chat_id for the target group (don't trust IPC payload)
        const targetChatIdStr = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup,
        )?.[0];

        if (!targetChatIdStr) {
          logger.warn(
            { targetGroup },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetChatId = parseInt(targetChatIdStr, 10);

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
          group_folder: targetGroup,
          chat_id: targetChatId,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetGroup, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
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
        const task = getTask(data.taskId);
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
        const task = getTask(data.taskId);
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
        await syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        const { writeGroupsSnapshot: writeGroups } =
          await import('./container-runner.js');
        writeGroups(
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
      if (data.chatId && data.name && data.folder && data.trigger) {
        logger.info(
          { chatId: data.chatId, name: data.name, folder: data.folder },
          'Processing register_group IPC request',
        );
        registerGroup(data.chatId.toString(), {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
        });

        // Immediately update available groups snapshot for all groups
        const availableGroups = getAvailableGroups();
        const registeredJids = new Set(Object.keys(registeredGroups));
        writeGroupsSnapshot(
          MAIN_GROUP_FOLDER,
          true,
          availableGroups,
          registeredJids,
        );
        // Also update other groups' snapshots if needed
        for (const [jid, group] of Object.entries(registeredGroups)) {
          if (group.folder !== MAIN_GROUP_FOLDER) {
            writeGroupsSnapshot(
              group.folder,
              false,
              availableGroups,
              registeredJids,
            );
          }
        }
        logger.info(
          { chatId: data.chatId, folder: data.folder },
          'Group registered and snapshots updated',
        );
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

async function connectTelegram(): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    logger.error('TELEGRAM_BOT_TOKEN not found in environment');
    console.error('\n╔════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Telegram bot token not configured             ║');
    console.error('║                                                        ║');
    console.error('║  Please add TELEGRAM_BOT_TOKEN to your .env file:     ║');
    console.error('║  1. Get token from @BotFather on Telegram             ║');
    console.error('║  2. Add to .env: TELEGRAM_BOT_TOKEN=your_token        ║');
    console.error('║  3. Run: npm run auth                                 ║');
    console.error('╚════════════════════════════════════════════════════════╝\n');
    process.exit(1);
  }

  bot = new Telegraf(botToken);

  // Middleware: log all updates
  bot.use(async (ctx, next) => {
    logger.debug({
      updateType: ctx.updateType,
      chatId: ctx.chat?.id,
      from: ctx.from?.username,
    }, 'Received update');
    await next();
  });

  // Handle all messages (event-driven, replaces polling loop)
  bot.on('message', async (ctx) => {
    const message = ctx.message;
    const chatId = ctx.chat.id;
    const messageId = message.message_id;
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name || 'Unknown';
    const isFromBot = ctx.from.is_bot;
    const messageThreadId = 'message_thread_id' in message ? message.message_thread_id : undefined;

    // Extract content from message
    let content = '';
    if ('text' in message) {
      content = message.text;
    } else if ('caption' in message && message.caption) {
      content = message.caption;
    } else if ('sticker' in message) {
      content = '[sticker]';
    } else if ('photo' in message) {
      content = '[photo]';
    } else if ('document' in message) {
      content = '[document]';
    } else {
      content = '[non-text message]';
    }

    const timestamp = new Date(message.date * 1000).toISOString();

    // Get chat name
    let chatName = chatId.toString();
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
      chatName = 'title' in ctx.chat ? ctx.chat.title : chatName;
    } else if (ctx.chat.type === 'private') {
      chatName = username;
    }

    // Always store chat metadata (for group discovery)
    storeChatMetadata(chatId, timestamp, chatName);

    // Only store and process full message content for registered groups
    const chatKey = chatId.toString();
    if (registeredGroups[chatKey]) {
      storeTelegramMessage(
        messageId,
        chatId,
        userId,
        username,
        content,
        isFromBot,
        timestamp,
        messageThreadId,
      );

      // Event-driven processing (replaces polling loop)
      const newMessage: NewMessage = {
        id: messageId.toString(),
        chat_id: chatId,
        user_id: userId,
        sender_name: username,
        content,
        timestamp,
        is_from_bot: isFromBot,
        message_thread_id: messageThreadId,
      };

      // Process message asynchronously (don't block event loop)
      processMessage(newMessage).catch((err) => {
        logger.error({ err, messageId, chatId }, 'Error processing message');
      });
    }
  });

  // Handle callback queries (button clicks)
  bot.on('callback_query', async (ctx) => {
    try {
      const callbackData = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;

      if (!callbackData) {
        await ctx.answerCbQuery('Invalid button');
        return;
      }

      logger.info(
        {
          chatId: ctx.chat?.id,
          userId: ctx.from.id,
          data: callbackData
        },
        'Callback query received'
      );

      // Answer the callback query to remove loading state
      await ctx.answerCbQuery();

      // Handle different callback actions
      if (callbackData.startsWith('confirm_')) {
        const action = callbackData.replace('confirm_', '');
        await ctx.editMessageText(`已確認: ${action}`);
      } else if (callbackData.startsWith('cancel_')) {
        await ctx.editMessageText('已取消操作');
      } else {
        // For other callbacks, send the data to the agent for processing
        const chatId = ctx.chat!.id;
        const chatKey = chatId.toString();
        const group = registeredGroups[chatKey];

        if (group) {
          const username = ctx.from.username || ctx.from.first_name || 'Unknown';
          const timestamp = new Date().toISOString();

          // Store as a message for context
          storeTelegramMessage(
            ctx.callbackQuery.message?.message_id || Date.now(),
            chatId,
            ctx.from.id,
            username,
            `[Button: ${callbackData}]`,
            false,
            timestamp,
          );

          // Process as a message
          const newMessage: NewMessage = {
            id: ctx.callbackQuery.id,
            chat_id: chatId,
            user_id: ctx.from.id,
            sender_name: username,
            content: `[Button clicked: ${callbackData}]`,
            timestamp,
            is_from_bot: false,
          };

          await processMessage(newMessage);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error handling callback query');
      ctx.answerCbQuery('處理錯誤').catch(() => {});
    }
  });

  // Error handling
  bot.catch((err, ctx) => {
    logger.error({ err, updateType: ctx.updateType }, 'Telegraf error');
  });

  // Launch bot (Long Polling)
  try {
    logger.info('Connecting to Telegram...');

    // Launch bot asynchronously (don't wait for completion)
    // The bot will start polling in the background
    bot.launch({ dropPendingUpdates: true })
      .then(() => {
        logger.info('Bot polling started successfully');
      })
      .catch((err) => {
        logger.error({ err }, 'Bot launch error (may still work)');
      });

    // Verify connection by calling getMe (this should work immediately)
    const botInfo = await bot.telegram.getMe();
    logger.info({ botId: botInfo.id, username: botInfo.username }, 'Connected to Telegram');
    logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

    // Sync group metadata on startup (respects 24h cache)
    syncGroupMetadata().catch((err) =>
      logger.error({ err }, 'Initial group sync failed'),
    );

    // Set up daily sync timer (only once)
    if (!groupSyncTimerStarted) {
      groupSyncTimerStarted = true;
      setInterval(() => {
        syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Periodic group sync failed'),
        );
      }, GROUP_SYNC_INTERVAL_MS);
    }

    // Start other services
    startSchedulerLoop({
      sendMessage,
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
    });
    startIpcWatcher();
  } catch (err) {
    logger.error({ err }, 'Failed to connect to Telegram');
    process.exit(1);
  }

  // Graceful shutdown
  process.once('SIGINT', async () => {
    logger.info('SIGINT received, stopping bot');
    try {
      await bot.stop('SIGINT');
      logger.info('Bot stopped successfully');
    } catch (err) {
      logger.error({ err }, 'Error stopping bot');
    }
    process.exit(0);
  });
  process.once('SIGTERM', async () => {
    logger.info('SIGTERM received, stopping bot');
    try {
      await bot.stop('SIGTERM');
      logger.info('Bot stopped successfully');
    } catch (err) {
      logger.error({ err }, 'Error stopping bot');
    }
    process.exit(0);
  });
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker is running');
  } catch (err) {
    logger.error({ err }, 'Docker is not running');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Docker is not running                                  ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without Docker. To fix:                    ║',
    );
    console.error(
      '║  1. Start Docker Desktop (or Docker daemon)                   ║',
    );
    console.error(
      '║  2. Wait for Docker to finish starting                        ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                          ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Docker is required but not running');
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Watch for changes to registered_groups.json for hot reload using chokidar
  const registeredGroupsPath = path.join(DATA_DIR, 'registered_groups.json');
  const watcher = chokidar.watch(registeredGroupsPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  watcher.on('change', (filePath) => {
    logger.info({ filePath }, 'Detected change in registered_groups.json, reloading...');
    try {
      const newGroups = loadJson<Record<string, RegisteredGroup>>(
        registeredGroupsPath,
        {},
      );
      registeredGroups = newGroups;
      logger.info(
        { groupCount: Object.keys(registeredGroups).length },
        'Groups reloaded successfully',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to reload registered groups');
    }
  });

  watcher.on('error', (error) => {
    logger.error({ error }, 'File watcher error');
  });

  logger.info('Chokidar file watcher started for registered_groups.json');

  await connectTelegram();
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
