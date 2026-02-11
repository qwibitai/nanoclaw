import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
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
} from './tenant-config.js';
import { handleComplaintMessage } from './complaint-handler.js';
import {
  detectLanguageFromText,
  getFallbackErrorMessage,
  getPreferredLanguage,
} from './error-fallback.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

/** Extract phone number from JID, falling back to the JID prefix if extraction fails. */
function phoneFromJid(jid: string): string {
  return extractPhoneNumber(jid) || jid.split('@')[0];
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
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
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
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
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
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, chatJid, messageCount: missedMessages.length, isIndividual },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await whatsapp.setTyping(chatJid, true);
  let hadError = false;

  const sessionFolder = getSessionFolder(group.folder, chatJid);
  const output = await runAgent(group, prompt, chatJid, sessionFolder, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = stripInternalTags(raw);
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await whatsapp.sendMessage(chatJid, `${ASSISTANT_NAME}: ${text}`);
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await whatsapp.setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
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
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
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
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
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
 * Startup recovery: check for unprocessed messages in registered groups AND
 * individual chats. 1:1 chats store messages under their phone JID, not the
 * virtual group JID, so we also scan for those.
 */
function recoverPendingMessages(): void {
  // Recover group messages
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (chatJid === VIRTUAL_COMPLAINT_GROUP_JID) continue; // virtual, no direct messages
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed group messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }

  // Recover 1:1 individual chat messages: find distinct chat_jids for individual
  // chats that have messages newer than their last agent cursor.
  // Uses the direct in-process handler (no container/queue).
  if (registeredGroups[VIRTUAL_COMPLAINT_GROUP_JID]) {
    const allChats = getAllChats();
    for (const chat of allChats) {
      if (!isIndividualChat(chat.jid)) continue;
      const sinceTimestamp = lastAgentTimestamp[chat.jid] || '';
      const pending = getMessagesSince(chat.jid, sinceTimestamp, ASSISTANT_NAME);
      if (pending.length > 0) {
        logger.info(
          { chatJid: chat.jid, pendingCount: pending.length },
          'Recovery: found unprocessed 1:1 messages',
        );
        // Process each pending message directly (last one is most relevant)
        const lastMsg = pending[pending.length - 1];
        handleComplaintDirect(chat.jid, lastMsg);
      }
    }
  }
}

/**
 * Handle a 1:1 complaint message directly via the in-process Agent SDK.
 * No containers, no queue — fires and forgets (response sent asynchronously).
 */
function handleComplaintDirect(chatJid: string, msg: NewMessage): void {
  const phone = phoneFromJid(chatJid);
  const userName = msg.sender_name || phone;

  // Block check — skip LLM call entirely for blocked users
  if (isUserBlocked(phone)) {
    logger.info({ phone, chatJid }, 'Blocked user message ignored');
    return;
  }

  // Fire-and-forget: handle asynchronously, don't block the message callback
  (async () => {
    try {
      await whatsapp.setTyping(chatJid, true);
      const result = await handleComplaintMessage(phone, userName, msg.content);
      const text = stripInternalTags(result);
      if (text) {
        // 1:1 chats don't need the bot name prefix — WhatsApp already shows the sender
        await whatsapp.sendMessage(chatJid, text);
        // Only advance cursor after a reply was actually sent
        lastAgentTimestamp[chatJid] = msg.timestamp;
        saveState();
      } else {
        logger.warn({ chatJid, phone }, 'Complaint handler returned empty result, NOT advancing cursor — message will be retried');
      }
    } catch (err) {
      logger.error({ chatJid, err }, 'Direct complaint handler error');
      // Send fallback error message so user isn't left without a response
      try {
        await whatsapp.sendMessage(chatJid, resolveFallbackErrorMessage(phone, msg.content));
      } catch { /* best-effort */ }
    } finally {
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
    const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
    const orphans = containers
      .filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'))
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(`container stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
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
  const tenantConfig = loadTenantConfig();
  cacheTenantConfigToDb(getDb(), tenantConfig);
  logger.info(
    { mla: tenantConfig.mla_name, constituency: tenantConfig.constituency },
    'Tenant config loaded and cached to DB',
  );

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
      // For 1:1 chats, use the direct in-process handler (no container)
      if (isIndividualChat(chatJid) && registeredGroups[VIRTUAL_COMPLAINT_GROUP_JID]) {
        handleComplaintDirect(chatJid, msg);
      }
    },
    onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
    registeredGroups: () => registeredGroups,
  });

  // Connect — resolves when first connected
  await whatsapp.connect();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
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
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start bot');
    process.exit(1);
  });
}
