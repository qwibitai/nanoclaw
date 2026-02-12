import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MAX_CONCURRENT_DIRECT_HANDLERS,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import {
  WhatsAppChannel,
  isIndividualChat,
  extractPhoneNumber,
  VIRTUAL_COMPLAINT_GROUP_JID,
} from './channels/whatsapp.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  findGroupJidByName,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getDb,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  isUserBlocked,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import {
  formatMessages,
  formatMessagesWithUserContext,
  formatOutbound,
  resolveRouteJid,
  stripInternalTags,
} from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  loadTenantConfig,
  injectTemplateVariables,
  cacheTenantConfigToDb,
  type TenantConfig,
} from './tenant-config.js';
import { downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys';
import { handleComplaintMessage } from './complaint-handler.js';
import { processVoiceNote, getDefaultVoiceConfig } from './voice.js';
import { AdminService } from './admin-handler.js';
import { checkRateLimit } from './rate-limiter.js';
import { getUserRole } from './roles.js';
import {
  handleKaryakartaCommand,
  initKaryakartaNotifications,
} from './karyakarta-handler.js';
import { handleMlaReply } from './mla-escalation.js';
import { initUserNotifications } from './user-notifications.js';
import { runDailySummary } from './daily-summary.js';
import { checkPendingValidations } from './validation-scheduler.js';
import {
  detectLanguageFromText,
  getFallbackErrorMessage,
  getPreferredLanguage,
} from './error-fallback.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { Semaphore } from './semaphore.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let tenantConfig: TenantConfig;

/** Extract phone number from JID, falling back to the JID prefix if extraction fails. */
function phoneFromJid(jid: string): string {
  return extractPhoneNumber(jid) || jid.split('@')[0];
}

/** Advance the per-chat message cursor and persist state. */
function advanceCursor(chatJid: string, timestamp: string): void {
  lastAgentTimestamp[chatJid] = timestamp;
  saveState();
}

function resolveFallbackErrorMessage(phone: string, text: string): string {
  const preferredLanguage = getPreferredLanguage(phone, (phoneNumber) => {
    const row = getDb()
      .prepare('SELECT language FROM users WHERE phone = ?')
      .get(phoneNumber) as { language?: string } | undefined;
    return row?.language;
  });
  const language = preferredLanguage ?? detectLanguageFromText(text);
  return getFallbackErrorMessage(language);
}

/**
 * Compute a per-user session folder for 1:1 chats.
 * Each user gets their own Claude session + session directory so conversations
 * don't bleed between users. Group chats use the group folder directly.
 */
function getSessionFolder(groupFolder: string, chatJid: string): string {
  if (isIndividualChat(chatJid)) {
    return `${groupFolder}-${phoneFromJid(chatJid)}`;
  }
  return groupFolder;
}

let whatsapp: WhatsAppChannel;
const queue = new GroupQueue();
const directHandlerSemaphore = new Semaphore(MAX_CONCURRENT_DIRECT_HANDLERS);

/** @internal - exported for testing */
export { directHandlerSemaphore as _directHandlerSemaphore };

function getBusyMessage(phone: string, text: string): string {
  const preferredLanguage = getPreferredLanguage(phone, (phoneNumber) => {
    const row = getDb()
      .prepare('SELECT language FROM users WHERE phone = ?')
      .get(phoneNumber) as { language?: string } | undefined;
    return row?.language;
  });
  const language = preferredLanguage ?? detectLanguageFromText(text);
  if (language === 'hi')
    return 'सर्वर पर अभी बहुत अधिक अनुरोध आ रहे हैं। कृपया कुछ मिनट बाद पुन: प्रयास करें।';
  if (language === 'en')
    return 'The server is currently handling too many requests. Please try again in a few minutes.';
  return 'सर्व्हरवर सध्या खूप विनंत्या आहेत. कृपया काही मिनिटांनी पुन्हा प्रयत्न करा.';
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerAdminGroup(jid: string): void {
  if (registeredGroups[jid]) return;
  registerGroup(jid, {
    name: 'Admin',
    folder: 'admin',
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: true,
  });
  logger.info({ jid }, 'Registered admin group for command routing');
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group or individual chat.
 * Called by the GroupQueue when it's this JID's turn.
 * For 1:1 chats (individual JIDs), routes through the virtual complaint group.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  // Resolve the group config: 1:1 chats use the virtual complaint group
  const isIndividual = isIndividualChat(chatJid);
  const routeJid = resolveRouteJid(chatJid);
  const group = registeredGroups[isIndividual ? routeJid : chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // For 1:1 chats, include user context (phone + push name) in the prompt
  let prompt: string;
  if (isIndividual) {
    const phone = phoneFromJid(chatJid);
    const pushName = missedMessages[0]?.sender_name || phone;
    prompt = formatMessagesWithUserContext(missedMessages, phone, pushName);
  } else {
    prompt = formatMessages(missedMessages);
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  advanceCursor(chatJid, missedMessages[missedMessages.length - 1].timestamp);

  logger.info(
    {
      group: group.name,
      chatJid,
      messageCount: missedMessages.length,
      isIndividual,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await whatsapp.setTyping(chatJid, true);
  let hadError = false;

  const sessionFolder = getSessionFolder(group.folder, chatJid);
  const output = await runAgent(
    group,
    prompt,
    chatJid,
    sessionFolder,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = stripInternalTags(raw);
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await whatsapp.sendMessage(chatJid, `${ASSISTANT_NAME}: ${text}`);
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await whatsapp.setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // Roll back cursor so retries can re-process these messages
    advanceCursor(chatJid, previousCursor);
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  sessionFolder: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[sessionFolder];

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

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[sessionFolder] = output.newSessionId;
          setSession(sessionFolder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        sessionFolder,
        chatJid,
        isMain,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sessionFolder] = output.newSessionId;
      setSession(sessionFolder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`Constituency bot running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            advanceCursor(chatJid, messagesToSend[messagesToSend.length - 1].timestamp);
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Advance all message cursors to the latest stored message so the bot
 * starts clean after a restart — no replayed messages, no echo loops,
 * no accidental rate-limit hits from old traffic.
 */
function skipPendingMessages(): void {
  let skipped = 0;

  // Advance cursors for registered groups
  for (const [chatJid] of Object.entries(registeredGroups)) {
    if (chatJid === VIRTUAL_COMPLAINT_GROUP_JID) continue;
    const pending = getMessagesSince(
      chatJid,
      lastAgentTimestamp[chatJid] || '',
      ASSISTANT_NAME,
    );
    if (pending.length > 0) {
      lastAgentTimestamp[chatJid] = pending[pending.length - 1].timestamp;
      skipped += pending.length;
    }
  }

  // Advance cursors for 1:1 individual chats
  if (registeredGroups[VIRTUAL_COMPLAINT_GROUP_JID]) {
    const allChats = getAllChats();
    for (const chat of allChats) {
      if (!isIndividualChat(chat.jid)) continue;
      const pending = getMessagesSince(
        chat.jid,
        lastAgentTimestamp[chat.jid] || '',
        ASSISTANT_NAME,
      );
      if (pending.length > 0) {
        lastAgentTimestamp[chat.jid] = pending[pending.length - 1].timestamp;
        skipped += pending.length;
      }
    }
  }

  if (skipped > 0) {
    saveState();
    logger.info(
      { skipped },
      'Skipped pending messages from before restart',
    );
  }
}

/**
 * Gate check for direct (1:1) message handlers.
 * Returns true if the message should be processed, false if it was rejected
 * (blocked, rate-limited, or over concurrency limit).
 */
function acquireDirectHandler(
  chatJid: string,
  phone: string,
  fallbackText: string,
): boolean {
  if (isUserBlocked(phone)) {
    logger.info({ phone, chatJid }, 'Blocked user message ignored');
    return false;
  }

  const userRole = getUserRole(getDb(), phone);
  if (userRole === 'user') {
    const rateResult = checkRateLimit(getDb(), phone, tenantConfig);
    if (!rateResult.allowed) {
      whatsapp.sendMessage(chatJid, rateResult.reason!);
      return false;
    }
  }

  if (!directHandlerSemaphore.tryAcquire()) {
    logger.warn(
      { chatJid, phone, active: directHandlerSemaphore.active },
      'Direct handler concurrency limit reached, sending busy message',
    );
    whatsapp.sendMessage(chatJid, getBusyMessage(phone, fallbackText));
    return false;
  }

  return true;
}

/**
 * Send the agent result to the user, handling empty/internal-only responses.
 * Advances the cursor on success; skips cursor advance on empty result so
 * the message will be retried.
 */
async function sendAgentResult(
  chatJid: string,
  phone: string,
  timestamp: string,
  agentResult: string,
  fallbackText: string,
): Promise<void> {
  const text = stripInternalTags(agentResult);
  if (text) {
    await whatsapp.sendMessage(chatJid, text);
    advanceCursor(chatJid, timestamp);
  } else if (agentResult.length > 0) {
    logger.warn(
      { chatJid, phone, resultLength: agentResult.length },
      'Agent response was entirely internal tags — sending fallback',
    );
    await whatsapp.sendMessage(
      chatJid,
      resolveFallbackErrorMessage(phone, fallbackText),
    );
    advanceCursor(chatJid, timestamp);
  } else {
    logger.warn(
      { chatJid, phone },
      'Handler returned empty result, NOT advancing cursor — message will be retried',
    );
  }
}

/**
 * Handle a 1:1 complaint message directly via the in-process Agent SDK.
 * No containers, no queue — fires and forgets (response sent asynchronously).
 */
function handleComplaintDirect(chatJid: string, msg: NewMessage): void {
  const phone = phoneFromJid(chatJid);
  const userName = msg.sender_name || phone;

  if (!acquireDirectHandler(chatJid, phone, msg.content)) return;

  (async () => {
    try {
      await whatsapp.setTyping(chatJid, true);
      const result = await handleComplaintMessage(phone, userName, msg.content);
      await sendAgentResult(chatJid, phone, msg.timestamp, result, msg.content);
    } catch (err) {
      logger.error({ chatJid, err }, 'Direct complaint handler error');
      try {
        await whatsapp.sendMessage(
          chatJid,
          resolveFallbackErrorMessage(phone, msg.content),
        );
      } catch {
        /* best-effort */
      }
    } finally {
      directHandlerSemaphore.release();
      await whatsapp.setTyping(chatJid, false);
    }
  })();
}

/**
 * Handle a voice note from a 1:1 chat.
 * Downloads audio, validates, transcribes via Whisper, then passes
 * transcript to the complaint handler.
 */
function handleVoiceDirect(
  chatJid: string,
  msg: WAMessage,
  metadata: import('./channels/whatsapp.js').AudioMetadata,
): void {
  const phone = phoneFromJid(chatJid);

  if (!acquireDirectHandler(chatJid, phone, '')) return;

  (async () => {
    try {
      await whatsapp.setTyping(chatJid, true);

      // Look up user language for Whisper hint + error messages
      const userRow = getDb()
        .prepare('SELECT language FROM users WHERE phone = ?')
        .get(phone) as { language?: string } | undefined;
      const language = userRow?.language || 'mr';

      // Download audio from WhatsApp servers
      let audioBuffer: Buffer;
      try {
        audioBuffer = (await downloadMediaMessage(
          msg,
          'buffer',
          {},
        )) as Buffer;
      } catch (err) {
        logger.error(
          { err, messageId: metadata.messageId },
          'Failed to download audio',
        );
        await whatsapp.sendMessage(
          chatJid,
          resolveFallbackErrorMessage(phone, ''),
        );
        advanceCursor(chatJid, metadata.timestamp);
        return;
      }

      // Validate + transcribe via voice.ts
      const voiceConfig = getDefaultVoiceConfig();
      const voiceResult = await processVoiceNote(
        audioBuffer,
        language,
        metadata.messageId,
        voiceConfig,
      );

      // Handle rejection/error
      if (voiceResult.status === 'rejected' || voiceResult.status === 'error') {
        await whatsapp.sendMessage(chatJid, voiceResult.message!);
        advanceCursor(chatJid, metadata.timestamp);
        return;
      }

      // Pass transcript to complaint handler with voice context prefix
      const transcript = voiceResult.text!;
      logger.info(
        {
          phone,
          messageId: metadata.messageId,
          transcriptLength: transcript.length,
          transcript,
        },
        'Voice note transcribed, routing to complaint handler',
      );

      const voiceContent = `[Voice note transcribed — user spoke this message]\n${transcript}`;
      const agentResult = await handleComplaintMessage(
        phone,
        metadata.senderName,
        voiceContent,
      );
      await sendAgentResult(chatJid, phone, metadata.timestamp, agentResult, transcript);
    } catch (err) {
      logger.error({ chatJid, err }, 'Voice message handler error');
      try {
        await whatsapp.sendMessage(
          chatJid,
          resolveFallbackErrorMessage(phone, ''),
        );
      } catch {
        /* best-effort */
      }
    } finally {
      directHandlerSemaphore.release();
      await whatsapp.setTyping(chatJid, false);
    }
  })();
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
      logger.error({ err }, 'Failed to start Apple Container system');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Apple Container system failed to start                 ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without Apple Container. To fix:           ║',
      );
      console.error(
        '║  1. Install from: https://github.com/apple/container/releases ║',
      );
      console.error(
        '║  2. Run: container system start                               ║',
      );
      console.error(
        '║  3. Restart the bot                                            ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Apple Container system is required but failed to start');
    }
  }

  // Kill and clean up orphaned bot containers from previous runs
  try {
    const output = execSync('container ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    const orphans = containers
      .filter(
        (c) =>
          c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'),
      )
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(`container stop ${name}`, { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Load tenant config, cache to DB, and inject template variables into CLAUDE.md
  tenantConfig = loadTenantConfig();
  cacheTenantConfigToDb(getDb(), tenantConfig);
  logger.info(
    { mla: tenantConfig.mla_name, constituency: tenantConfig.constituency },
    'Tenant config loaded and cached to DB',
  );

  // Phase 2: Initialize admin service and notification listeners
  // adminDeps is kept as a mutable reference — wa_admin_group_jid may be
  // auto-discovered after WhatsApp connects and group metadata syncs.
  const adminDeps = {
    db: getDb(),
    sendMessage: async (jid: string, text: string) =>
      whatsapp.sendMessage(jid, text),
    adminGroupJid: tenantConfig.wa_admin_group_jid,
    adminPhones: tenantConfig.admin_phones ?? [],
    mlaPhone: tenantConfig.mla_phone,
  };
  const adminService = new AdminService(adminDeps);
  adminService.init();

  initUserNotifications({
    db: getDb(),
    sendMessage: async (jid, text) => whatsapp.sendMessage(jid, text),
  });

  initKaryakartaNotifications({
    db: getDb(),
    sendMessage: async (jid, text) => whatsapp.sendMessage(jid, text),
    get adminGroupJid() {
      return tenantConfig.wa_admin_group_jid;
    },
  });

  // Process CLAUDE.md template variables for the complaint group.
  // Write the injected version to data/runtime/ so the source template stays intact.
  const complaintGroupDir = path.join(process.cwd(), 'groups', 'complaint');
  const runtimeGroupDir = path.join(DATA_DIR, 'runtime', 'complaint');
  if (fs.existsSync(complaintGroupDir)) {
    fs.mkdirSync(runtimeGroupDir, { recursive: true });
    // Copy all files from source group dir to runtime dir
    for (const file of fs.readdirSync(complaintGroupDir)) {
      const srcFile = path.join(complaintGroupDir, file);
      if (!fs.statSync(srcFile).isFile()) continue;
      let content = fs.readFileSync(srcFile, 'utf-8');
      if (file === 'CLAUDE.md') {
        content = injectTemplateVariables(content, tenantConfig);
      }
      fs.writeFileSync(path.join(runtimeGroupDir, file), content);
    }
    // Also create logs dir in runtime
    fs.mkdirSync(path.join(runtimeGroupDir, 'logs'), { recursive: true });
    logger.info('Injected tenant config into runtime complaint CLAUDE.md');
  }

  // Auto-register the virtual complaint group for 1:1 message routing
  if (!registeredGroups[VIRTUAL_COMPLAINT_GROUP_JID]) {
    registerGroup(VIRTUAL_COMPLAINT_GROUP_JID, {
      name: 'Complaint',
      folder: 'complaint',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });
    logger.info('Registered virtual complaint group for 1:1 message routing');
  }

  // Register admin group so WhatsApp channel delivers its messages to onMessage.
  // requiresTrigger: true prevents the message loop from spawning container agents.
  if (tenantConfig.wa_admin_group_jid) {
    registerAdminGroup(tenantConfig.wa_admin_group_jid);
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await whatsapp.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create WhatsApp channel
  whatsapp = new WhatsAppChannel({
    onMessage: (chatJid, msg) => {
      storeMessage(msg);
      // Skip bot's own outgoing messages — WhatsApp echoes them back via messages.upsert
      if (msg.is_from_me) return;

      // Admin group: handle #commands, ignore non-command messages
      if (
        tenantConfig.wa_admin_group_jid &&
        chatJid === tenantConfig.wa_admin_group_jid
      ) {
        if (msg.content.trim().startsWith('#')) {
          (async () => {
            try {
              const response = await adminService.handleCommand(
                phoneFromJid(msg.sender),
                msg.content,
              );
              if (response) {
                await whatsapp.sendMessage(chatJid, response);
              }
            } catch (err) {
              logger.error({ err }, 'Admin command error');
            }
          })();
        }
        return;
      }

      // 1:1 chats: role-aware routing
      if (
        isIndividualChat(chatJid) &&
        registeredGroups[VIRTUAL_COMPLAINT_GROUP_JID]
      ) {
        const phone = phoneFromJid(chatJid);
        const text = msg.content.trim();

        // MLA replies → forward to admin group
        if (tenantConfig.mla_phone && phone === tenantConfig.mla_phone) {
          (async () => {
            try {
              const result = await handleMlaReply(
                {
                  db: getDb(),
                  sendMessage: async (jid, t) =>
                    whatsapp.sendMessage(jid, t),
                  adminGroupJid: tenantConfig.wa_admin_group_jid,
                  mlaPhone: tenantConfig.mla_phone,
                },
                phone,
                text,
              );
              if (result) {
                await whatsapp.sendMessage(chatJid, result);
                advanceCursor(chatJid, msg.timestamp);
              }
            } catch (err) {
              logger.error({ err, chatJid }, 'MLA reply handler error');
            }
          })();
          return;
        }

        // Karyakarta #commands (#approve, #reject, #my-complaints)
        if (text.startsWith('#')) {
          const role = getUserRole(getDb(), phone);
          if (role === 'karyakarta') {
            (async () => {
              try {
                const result = await handleKaryakartaCommand(
                  {
                    db: getDb(),
                    sendMessage: async (jid, t) =>
                      whatsapp.sendMessage(jid, t),
                    adminGroupJid: tenantConfig.wa_admin_group_jid,
                  },
                  phone,
                  text,
                );
                if (result) {
                  await whatsapp.sendMessage(chatJid, result);
                  advanceCursor(chatJid, msg.timestamp);
                } else {
                  // Unrecognized command — treat as complaint message
                  handleComplaintDirect(chatJid, msg);
                }
              } catch (err) {
                logger.error({ err, chatJid }, 'Karyakarta command error');
              }
            })();
            return;
          }
        }

        // Default: complaint handler (includes block check + rate limiting)
        handleComplaintDirect(chatJid, msg);
      }
    },
    onAudioMessage: (chatJid, msg, metadata) => {
      storeChatMetadata(chatJid, metadata.timestamp, metadata.senderName);

      // Skip bot's own audio messages
      if (msg.key.fromMe) return;

      // Only handle 1:1 chats with virtual complaint group registered
      if (
        isIndividualChat(chatJid) &&
        registeredGroups[VIRTUAL_COMPLAINT_GROUP_JID]
      ) {
        handleVoiceDirect(chatJid, msg, metadata);
      }
    },
    onChatMetadata: (chatJid, timestamp, name) =>
      storeChatMetadata(chatJid, timestamp, name),
    registeredGroups: () => registeredGroups,
  });

  // Connect — resolves when first connected
  await whatsapp.connect();

  // Auto-discover admin group by name if JID not already set
  if (tenantConfig.admin_group_name && !tenantConfig.wa_admin_group_jid) {
    await whatsapp.syncGroupMetadata(true);
    const resolvedJid = findGroupJidByName(tenantConfig.admin_group_name);
    if (resolvedJid) {
      tenantConfig.wa_admin_group_jid = resolvedJid;
      adminDeps.adminGroupJid = resolvedJid;
      cacheTenantConfigToDb(getDb(), tenantConfig);
      registerAdminGroup(resolvedJid);
      logger.info(
        { jid: resolvedJid, name: tenantConfig.admin_group_name },
        'Auto-discovered admin group',
      );
    } else {
      logger.warn(
        { name: tenantConfig.admin_group_name },
        'Admin group not found — create a WhatsApp group with this name and restart',
      );
    }
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(whatsapp, rawText);
      if (text) await whatsapp.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  skipPendingMessages();
  startMessageLoop();

  // Phase 2: Hourly scheduled tasks (validation reminders + daily summary)
  let lastDailySummaryDate = '';
  setInterval(async () => {
    if (!tenantConfig.wa_admin_group_jid) return;

    // Validation check: reminders and auto-escalation for pending complaints
    try {
      const result = await checkPendingValidations({
        db: getDb(),
        sendMessage: async (jid, text) => whatsapp.sendMessage(jid, text),
        adminGroupJid: tenantConfig.wa_admin_group_jid,
      });
      if (result.reminders > 0 || result.escalated > 0) {
        logger.info(result, 'Validation check completed');
      }
    } catch (err) {
      logger.error({ err }, 'Validation check failed');
    }

    // Daily summary at 9 AM IST
    try {
      const istHour = parseInt(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Kolkata',
          hour: 'numeric',
          hour12: false,
        }).format(new Date()),
      );
      const today = new Date().toISOString().slice(0, 10);
      if (istHour === 9 && lastDailySummaryDate !== today) {
        lastDailySummaryDate = today;
        await runDailySummary(
          getDb(),
          async (jid, text) => whatsapp.sendMessage(jid, text),
          tenantConfig.wa_admin_group_jid,
        );
        logger.info('Daily summary sent');
      }
    } catch (err) {
      logger.error({ err }, 'Daily summary failed');
    }
  }, 3600_000);
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start bot');
    process.exit(1);
  });
}
