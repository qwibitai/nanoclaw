import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_NAME,
  CONTAINER_RUNTIME,
  DATA_DIR,
  EMAIL_CONFIG,
  EMAIL_ENABLED,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  PUSHOVER_ENABLED,
  STORE_DIR,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME,
  TELEGRAM_ENABLED,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { EmailChannel } from './email-channel.js';
import { TelegramChannel } from './telegram-channel.js';
import type { IncomingEmail } from './types.js';
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
  storeGenericMessage,
  storeMessage,
  updateChatName,
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';
import {
  sendNotification,
  type PushoverOptions,
} from './pushover.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TELEGRAM_DEEP_LINK = TELEGRAM_BOT_USERNAME
  ? `https://t.me/${TELEGRAM_BOT_USERNAME}`
  : undefined;

function notify(
  title: string,
  message: string,
  options: PushoverOptions = {},
): void {
  if (TELEGRAM_DEEP_LINK && !options.url) {
    options.url = TELEGRAM_DEEP_LINK;
    options.url_title = 'Open in Telegram';
  }
  sendNotification(title, message, options);
}

function notifyError(title: string, message: string): void {
  notify(title, message, { priority: 1 as const });
}

let sock: WASocket;
let whatsAppConnected = false;
let telegramChannel: TelegramChannel | null = null;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// LID to phone number mapping (WhatsApp now sends LID JIDs for self-chats)
let lidToPhoneMap: Record<string, string> = {};
let emailChannel: EmailChannel | null = null;

/**
 * Translate a JID from LID format to phone format if we have a mapping.
 * Returns the original JID if no mapping exists.
 */
function translateJid(jid: string): string {
  if (!jid.endsWith('@lid')) return jid;
  const lidUser = jid.split('@')[0].split(':')[0];
  const phoneJid = lidToPhoneMap[lidUser];
  if (phoneJid) {
    logger.debug({ lidJid: jid, phoneJid }, 'Translated LID to phone JID');
    return phoneJid;
  }
  return jid;
}

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  try {
    if (jid.startsWith('tg:')) {
      if (isTyping && telegramChannel) {
        await telegramChannel.setTyping(jid.slice(3));
      }
    } else if (whatsAppConnected) {
      await sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
    }
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to update typing status');
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

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Sync group metadata from WhatsApp.
 * Fetches all participating groups and stores their names in the database.
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
    logger.info('Syncing group metadata from WhatsApp...');
    const groups = await sock.groupFetchAllParticipating();

    let count = 0;
    for (const [jid, metadata] of Object.entries(groups)) {
      if (metadata.subject) {
        updateChatName(jid, metadata.subject);
        count++;
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
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter(
      (c) =>
        c.jid !== '__group_sync__' &&
        (c.jid.endsWith('@g.us') || c.jid.startsWith('tg:')),
    )
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Main group responds to all messages; other groups require trigger prefix
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(
    msg.chat_jid,
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

  // WhatsApp reactions provide visual feedback, no need for Pushover notifications
  // on routine message processing. Only errors get notified.
  await sendReaction(msg, '\u{1F440}'); // 👀
  await setTyping(msg.chat_jid, true);

  // Telegram typing status expires after 5s, so refresh it periodically
  const typingInterval = msg.chat_jid.startsWith('tg:')
    ? setInterval(() => setTyping(msg.chat_jid, true), 4000)
    : null;

  const startTime = Date.now();
  const response = await runAgent(group, prompt, msg.chat_jid);
  const durationSec = Math.round((Date.now() - startTime) / 1000);

  if (typingInterval) clearInterval(typingInterval);
  await setTyping(msg.chat_jid, false);

  if (response) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    const isTelegram = msg.chat_jid.startsWith('tg:');
    await sendMessage(
      msg.chat_jid,
      isTelegram ? response : `${ASSISTANT_NAME}: ${response}`,
    );
  } else {
    // Only notify on failures - WhatsApp reactions handle success feedback
    notifyError(
      `\u{274C} ${ASSISTANT_NAME} \u2014 ${group.name}`,
      `Failed after ${durationSec}s`,
    );
  }
  await sendReaction(msg, '\u{2705}'); // ✅
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
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
      chatJid,
      isMain,
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

async function sendReaction(msg: NewMessage, emoji: string): Promise<void> {
  // Telegram Bot API doesn't support message reactions in standard bot mode
  if (msg.chat_jid.startsWith('tg:')) return;
  if (!whatsAppConnected) return;

  try {
    await sock.sendMessage(msg.chat_jid, {
      react: {
        text: emoji,
        key: {
          remoteJid: msg.chat_jid,
          id: msg.id,
          fromMe: !!msg.is_from_me,
          participant: msg.is_from_me ? undefined : msg.sender,
        },
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to send reaction');
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    if (jid.startsWith('tg:')) {
      if (telegramChannel) {
        await telegramChannel.sendMessage(jid.slice(3), text);
      } else {
        logger.warn(
          { jid },
          'Telegram message dropped - channel not connected',
        );
        return;
      }
    } else if (whatsAppConnected) {
      await sock.sendMessage(jid, { text });
    } else {
      logger.warn({ jid }, 'WhatsApp message dropped - not connected');
      return;
    }
    logger.info({ jid, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
}

async function processEmails(emails: IncomingEmail[]): Promise<void> {
  if (emails.length === 0) return;

  // Find the main group entry — emails always route through main
  const mainEntry = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === MAIN_GROUP_FOLDER,
  );
  if (!mainEntry) {
    logger.warn('Cannot process emails: main group not registered');
    return;
  }

  const [mainJid, mainGroup] = mainEntry;

  const escapeXml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const emailXmls = emails.map(
    (email) => `<email>
<from name="${escapeXml(email.fromName)}">${escapeXml(email.from)}</from>
<to>${email.to.map(escapeXml).join(', ')}</to>
<subject>${escapeXml(email.subject)}</subject>
<date>${email.date instanceof Date ? email.date.toISOString() : email.date}</date>
<message_id>${escapeXml(email.messageId)}</message_id>
${email.inReplyTo ? `<in_reply_to>${escapeXml(email.inReplyTo)}</in_reply_to>` : ''}
${email.references ? `<references>${escapeXml(email.references)}</references>` : ''}
<folder>${escapeXml(email.folder)}</folder>
<body>
${escapeXml(email.body)}
</body>
</email>`,
  );

  const today = new Date().toISOString().slice(0, 10);

  const prompt = `<incoming_emails count="${emails.length}">
${emailXmls.join('\n')}
</incoming_emails>

You received ${emails.length} new email${emails.length > 1 ? 's' : ''}. Process them silently — do NOT send WhatsApp messages unless something is genuinely urgent.

For each email, decide what to do:
- Leave it alone — work emails, personal/health emails, and anything that doesn't need your involvement. Just log it.
- Organize info — save travel itineraries, receipts, confirmations, etc. to relevant files.
- Draft a reply — if warranted, use create_email_draft to save a draft to the Drafts folder. The user will review and send it manually. NEVER send email directly.

After processing each email, append a one-line summary to /workspace/group/email-activity/${today}.jsonl — one JSON object per line with fields: from, subject, action.

Example log entries:
{"from":"alice@example.com","subject":"Flight confirmation","action":"saved travel itinerary to trips/"}
{"from":"boss@work.com","subject":"Q4 report","action":"left alone (work email)"}
{"from":"newsletter@example.com","subject":"Weekly digest","action":"ignored"}`;

  logger.info(
    { count: emails.length, subjects: emails.map((e) => e.subject) },
    'Processing email batch through agent',
  );

  // Build summary of incoming emails for notification
  const emailSummaries = emails
    .map((e) => `• ${e.fromName || e.from}: ${e.subject}`)
    .join('\n');
  notify(
    `\u{1F4E7} ${ASSISTANT_NAME} \u2014 Email`,
    `Processing ${emails.length} email${emails.length > 1 ? 's' : ''}:\n${emailSummaries}`,
  );

  // Track existing log lines to find new entries after processing
  const logFile = path.join(
    GROUPS_DIR,
    'main',
    'email-activity',
    `${today}.jsonl`,
  );
  let existingLines = 0;
  try {
    if (fs.existsSync(logFile)) {
      existingLines = fs
        .readFileSync(logFile, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean).length;
    }
  } catch {
    // Ignore read errors
  }

  const startTime = Date.now();
  await runAgent(mainGroup, prompt, mainJid);
  const durationSec = Math.round((Date.now() - startTime) / 1000);

  // Read agent's action log to include in notification
  let actionSummary = '';
  try {
    if (fs.existsSync(logFile)) {
      const allLines = fs
        .readFileSync(logFile, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);
      const newLines = allLines.slice(existingLines);
      if (newLines.length > 0) {
        actionSummary = newLines
          .map((line) => {
            try {
              const entry = JSON.parse(line);
              return `• ${entry.from}: ${entry.action}`;
            } catch {
              return `• ${line}`;
            }
          })
          .join('\n');
      }
    }
  } catch {
    // Ignore read errors
  }

  notify(
    `\u{2709}\u{FE0F} ${ASSISTANT_NAME} \u2014 Email`,
    actionSummary
      ? `Processed in ${durationSec}s:\n${actionSummary}`
      : `Processed ${emails.length} email${emails.length > 1 ? 's' : ''} in ${durationSec}s`,
  );
}

async function sendDailyEmailSummary(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(
    GROUPS_DIR,
    'main',
    'email-activity',
    `${today}.jsonl`,
  );

  if (!fs.existsSync(logFile)) return;

  const mainJid = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === MAIN_GROUP_FOLDER,
  )?.[0];
  if (!mainJid) return;

  try {
    const lines = fs
      .readFileSync(logFile, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);
    if (lines.length === 0) return;

    const bullets = lines.map((line) => {
      try {
        const entry = JSON.parse(line);
        return `• *${entry.from}*: ${entry.subject} — _${entry.action}_`;
      } catch {
        return `• ${line}`;
      }
    });

    const summary = `${ASSISTANT_NAME}: *Resumo de emails de hoje* (${lines.length})\n\n${bullets.join('\n')}`;
    await sendMessage(mainJid, summary);

    // Rename to prevent re-sending
    fs.renameSync(logFile, `${logFile}.sent`);
    logger.info({ count: lines.length }, 'Daily email summary sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send daily email summary');
  }
}

function startEmailSummaryTimer(): void {
  // Check every hour; send summary at 10 PM local time
  const check = () => {
    const hour = new Date().getHours();
    if (hour === 22) {
      sendDailyEmailSummary().catch((err) =>
        logger.error({ err }, 'Email summary error'),
      );
    }
  };
  setInterval(check, 60 * 60 * 1000);
  logger.info('Email daily summary timer started (22:00 local)');
}

function startIpcWatcher(): void {
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
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const isTelegram = data.chatJid.startsWith('tg:');
                  const text = isTelegram
                    ? data.text
                    : `${ASSISTANT_NAME}: ${data.text}`;

                  if (data.buttons && isTelegram && telegramChannel) {
                    await telegramChannel.sendMessageWithButtons(
                      data.chatJid.slice(3),
                      text,
                      data.buttons,
                    );
                  } else {
                    if (data.buttons && !isTelegram) {
                      logger.warn(
                        { chatJid: data.chatJid },
                        'Buttons ignored for non-Telegram target',
                      );
                    }
                    await sendMessage(data.chatJid, text);
                  }
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      hasButtons: !!data.buttons,
                    },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'create_email_draft' && emailChannel) {
                try {
                  await emailChannel.createDraft({
                    to: data.to,
                    subject: data.subject,
                    body: data.body,
                    inReplyTo: data.inReplyTo,
                    references: data.references,
                  });
                  logger.info(
                    { to: data.to, subject: data.subject, sourceGroup },
                    'Email draft created via IPC',
                  );
                } catch (err) {
                  logger.error(
                    { err, to: data.to, sourceGroup },
                    'Failed to create email draft via IPC',
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
              await processTaskIpc(data, sourceGroup, isMain);
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

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    // For register_group
    jid?: string;
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

        // Resolve the correct JID for the target group (don't trust IPC payload)
        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup,
        )?.[0];

        if (!targetJid) {
          logger.warn(
            { targetGroup },
            'Cannot schedule task: target group not registered',
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
          group_folder: targetGroup,
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
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
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

async function connectWhatsApp(): Promise<void> {
  const authDir = path.join(STORE_DIR, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const msg =
        'WhatsApp authentication required. Run /setup in Claude Code.';
      logger.error(msg);
      exec(
        `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
      );
      setTimeout(() => process.exit(1), 1000);
    }

    if (connection === 'close') {
      whatsAppConnected = false;
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
      whatsAppConnected = true;
      logger.info('Connected to WhatsApp');

      notify(
        `\u{1F7E2} ${ASSISTANT_NAME} Online`,
        `WhatsApp connected${PUSHOVER_ENABLED ? ', notifications enabled' : ''}`,
      );

      // Build LID to phone mapping from auth state for self-chat translation
      if (sock.user) {
        const phoneUser = sock.user.id.split(':')[0];
        const lidUser = sock.user.lid?.split(':')[0];
        if (lidUser && phoneUser) {
          lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
          logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
        }
      }

      // Sync group metadata on startup (respects 24h cache)
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Initial group sync failed'),
      );
      setInterval(() => {
        syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Periodic group sync failed'),
        );
      }, GROUP_SYNC_INTERVAL_MS);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      // Skip reaction and protocol messages - they have no text content
      if (msg.message.reactionMessage || msg.message.protocolMessage) continue;
      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid === 'status@broadcast') continue;

      // Translate LID JID to phone JID if applicable
      const chatJid = translateJid(rawJid);

      const timestamp = new Date(
        Number(msg.messageTimestamp) * 1000,
      ).toISOString();

      // Always store chat metadata for group discovery
      storeChatMetadata(chatJid, timestamp);

      // Only store full message content for registered groups
      if (registeredGroups[chatJid]) {
        storeMessage(
          msg,
          chatJid,
          msg.key.fromMe || false,
          msg.pushName || undefined,
        );
      }
    }
  });
}

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: ${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0)
        logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { err, msg: msg.id },
            'Error processing message, will retry',
          );
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function ensureContainerRuntimeReady(): void {
  try {
    execSync(`${CONTAINER_RUNTIME} info`, { stdio: 'pipe', timeout: 10000 });
    logger.debug(`Container runtime ready: ${CONTAINER_RUNTIME}`);
  } catch {
    logger.error(`Container runtime not available: ${CONTAINER_RUNTIME}`);
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      `║  FATAL: ${CONTAINER_RUNTIME} is not running                                  ║`,
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:       ║',
    );
    console.error(
      '║  - Podman: podman machine start                               ║',
    );
    console.error(
      '║  - Docker: start Docker Desktop or systemctl start docker     ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error(`${CONTAINER_RUNTIME} is required but not running`);
  }
}

async function main(): Promise<void> {
  ensureContainerRuntimeReady();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Start Telegram channel if configured
  if (TELEGRAM_ENABLED && TELEGRAM_BOT_TOKEN) {
    telegramChannel = new TelegramChannel(TELEGRAM_BOT_TOKEN, {
      onMessage: (
        chatJid,
        chatName,
        senderId,
        senderName,
        content,
        messageId,
      ) => {
        const timestamp = new Date().toISOString();
        storeChatMetadata(chatJid, timestamp, chatName);

        if (registeredGroups[chatJid]) {
          storeGenericMessage(
            messageId,
            chatJid,
            senderId,
            senderName,
            content,
            timestamp,
            false,
          );
        }
      },
    });
    await telegramChannel.start();
    logger.info('Telegram channel started');
    notify(
      `\u{1F7E2} ${ASSISTANT_NAME} Online`,
      `Telegram connected${PUSHOVER_ENABLED ? ', notifications enabled' : ''}`,
    );
  }

  // Start WhatsApp connection (non-blocking — reconnects automatically)
  connectWhatsApp();

  // Start shared services immediately — independent of any single channel
  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
  });
  startIpcWatcher();
  startMessageLoop();

  // Start email channel if configured
  if (EMAIL_ENABLED && EMAIL_CONFIG) {
    emailChannel = new EmailChannel(EMAIL_CONFIG, {
      processEmails,
    });
    emailChannel
      .start()
      .catch((err) => logger.error({ err }, 'Email channel failed to start'));
    startEmailSummaryTimer();
  }
}

function shutdown(): void {
  logger.info('Shutting down...');
  if (telegramChannel) telegramChannel.stop();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
