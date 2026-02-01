import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  WASocket
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  STORE_DIR,
  DATA_DIR,
  TRIGGER_PATTERN,
  MAIN_GROUP_FOLDER,
  IPC_POLL_INTERVAL
} from './config.js';
import { RegisteredGroup, Session, NewMessage } from './types.js';
import { initDatabase, storeMessage, storeChatMetadata, getNewMessages, getMessagesSince, getAllTasks, getTaskById } from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { loadJson, saveJson, validateSchedule, ScheduleType } from './utils.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let sock: WASocket;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  try {
    await sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to update typing status');
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_timestamp?: string; last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_timestamp: lastTimestamp, last_agent_timestamp: lastAgentTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();

  if (!TRIGGER_PATTERN.test(content)) return;

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(msg.chat_jid, sinceTimestamp);

  const lines = missedMessages.map(m => {
    const d = new Date(m.timestamp);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `[${date} ${time}] ${m.sender_name}: ${m.content}`;
  });
  const prompt = lines.join('\n');

  if (!prompt) return;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');

  await setTyping(msg.chat_jid, true);
  const response = await runAgent(group, prompt, msg.chat_jid);
  await setTyping(msg.chat_jid, false);

  lastAgentTimestamp[msg.chat_jid] = msg.timestamp;

  if (response) {
    await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${response}`);
  }
}

async function runAgent(group: RegisteredGroup, prompt: string, chatJid: string): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read
  const tasks = getAllTasks();
  writeTasksSnapshot(tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run
  })));

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return null;
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    await sock.sendMessage(jid, { text });
    logger.info({ jid, text: text.slice(0, 50) }, 'Message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
}

function startIpcWatcher(): void {
  const messagesDir = path.join(DATA_DIR, 'ipc', 'messages');
  const tasksDir = path.join(DATA_DIR, 'ipc', 'tasks');

  fs.mkdirSync(messagesDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  const processIpcFiles = async () => {
    try {
      const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
      for (const file of messageFiles) {
        const filePath = path.join(messagesDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (data.type === 'message' && data.chatJid && data.text) {
            await sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${data.text}`);
            logger.info({ chatJid: data.chatJid }, 'IPC message sent');
          }
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ file, err }, 'Error processing IPC message');
          // Move to error directory instead of deleting
          const errorDir = path.join(DATA_DIR, 'ipc', 'errors');
          fs.mkdirSync(errorDir, { recursive: true });
          fs.renameSync(filePath, path.join(errorDir, file));
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading IPC messages directory');
    }

    try {
      const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
      for (const file of taskFiles) {
        const filePath = path.join(tasksDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          await processTaskIpc(data);
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ file, err }, 'Error processing IPC task');
          const errorDir = path.join(DATA_DIR, 'ipc', 'errors');
          fs.mkdirSync(errorDir, { recursive: true });
          fs.renameSync(filePath, path.join(errorDir, file));
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading IPC tasks directory');
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started');
}

async function processTaskIpc(data: {
  type: string;
  taskId?: string;
  prompt?: string;
  schedule_type?: string;
  schedule_value?: string;
  groupFolder?: string;
  chatJid?: string;
  isMain?: boolean;
}): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const { createTask, updateTask, deleteTask, getTaskById: getTask } = await import('./db.js');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && data.groupFolder && data.chatJid) {
        const scheduleType = data.schedule_type as ScheduleType;

        // Validate the schedule before creating the task
        const validation = validateSchedule(scheduleType, data.schedule_value);
        if (!validation.valid) {
          logger.error(
            { scheduleType, scheduleValue: data.schedule_value, error: validation.error },
            'Invalid schedule value in IPC task creation'
          );
          // Don't create the task - it would fail anyway
          return;
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createTask({
          id: taskId,
          group_folder: data.groupFolder,
          chat_jid: data.chatJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          next_run: validation.nextRun ?? null,
          status: 'active',
          created_at: new Date().toISOString()
        });
        logger.info({ taskId, groupFolder: data.groupFolder }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (data.isMain || task.group_folder === data.groupFolder)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, groupFolder: data.groupFolder }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (data.isMain || task.group_folder === data.groupFolder)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, groupFolder: data.groupFolder }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (data.isMain || task.group_folder === data.groupFolder)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, groupFolder: data.groupFolder }, 'Unauthorized task cancel attempt');
        }
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function connectWhatsApp(): Promise<void> {
  const authDir = path.join(STORE_DIR, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const msg = 'WhatsApp authentication required. Run /setup in Claude Code.';
      logger.error(msg);
      exec(`osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`);
      setTimeout(() => process.exit(1), 1000);
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      logger.info({ reason, shouldReconnect }, 'Connection closed');

      if (shouldReconnect) {
        logger.info('Reconnecting...');
        connectWhatsApp();
      } else {
        logger.info('Logged out. Run /setup to re-authenticate.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      logger.info('Connected to WhatsApp');
      startSchedulerLoop({ sendMessage, registeredGroups: () => registeredGroups });
      startIpcWatcher();
      startMessageLoop();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const chatJid = msg.key.remoteJid;
      if (!chatJid || chatJid === 'status@broadcast') continue;

      const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();

      // Always store chat metadata for group discovery
      storeChatMetadata(chatJid, timestamp);

      // Only store full message content for registered groups
      if (registeredGroups[chatJid]) {
        storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined);
      }
    }
  });
}

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp);
      lastTimestamp = newTimestamp;

      if (messages.length > 0) logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) await processMessage(msg);
      saveState();
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system - agents will not work');
    }
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  await connectWhatsApp();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
