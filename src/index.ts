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
import { SlackChannel } from './channels/slack.js';
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
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let slack: SlackChannel;
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
    .filter((c) => c.jid !== '__group_sync__' && /^[CG][A-Z0-9]+$/.test(c.jid))
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

function cursorKey(chatJid: string, threadTs?: string | null): string {
  return threadTs ? `${chatJid}:${threadTs}` : chatJid;
}

function getChannelMinCursor(chatJid: string): string {
  let min = lastAgentTimestamp[chatJid] || '';
  const prefix = `${chatJid}:`;
  for (const key of Object.keys(lastAgentTimestamp)) {
    if (key.startsWith(prefix)) {
      const val = lastAgentTimestamp[key];
      if (min === '' || val < min) {
        min = val;
      }
    }
  }
  return min;
}

/**
 * Process a single thread's messages: cursor management, trigger check, agent invocation.
 * Returns true on success, false on error requiring retry.
 */
async function processThread(
  chatJid: string,
  group: RegisteredGroup,
  threadTs: string | undefined,
  threadKey: string,
  isMainGroup: boolean,
  threadMessages: NewMessage[],
): Promise<boolean> {
  const cKey = cursorKey(chatJid, threadTs);
  const threadCursor = lastAgentTimestamp[cKey] || '';

  // Filter messages after this thread's cursor
  const pending = threadMessages.filter((m) => m.timestamp > threadCursor);
  if (pending.length === 0) return true;

  // Check trigger per-thread
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = pending.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const sessionKey = threadTs ? `${group.folder}:${threadTs}` : group.folder;
  const prompt = formatMessages(pending);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[cKey] || '';
  lastAgentTimestamp[cKey] = pending[pending.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, thread: threadTs, messageCount: pending.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name, thread: threadTs }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid, threadKey);
    }, IDLE_TIMEOUT);
  };

  await slack.setTyping(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, sessionKey, threadTs, threadKey, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await slack.sendMessage(chatJid, text, threadTs);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await slack.setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name, thread: threadTs }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
    } else {
      // Roll back cursor so retries can re-process these messages
      lastAgentTimestamp[cKey] = previousCursor;
      saveState();
      logger.warn({ group: group.name, thread: threadTs }, 'Agent error, rolled back message cursor for retry');
      return false;
    }
  }

  return true;
}

/**
 * Process all pending messages for a group, running threads in parallel.
 * Each Slack thread gets its own container and conversation context.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Get all messages since the minimum cursor across all threads for this channel
  const minCursor = getChannelMinCursor(chatJid);
  const allMessages = getMessagesSince(chatJid, minCursor, ASSISTANT_NAME);
  if (allMessages.length === 0) return true;

  // Group messages by thread
  const threadGroups = new Map<string, NewMessage[]>();
  for (const msg of allMessages) {
    const threadKey = msg.thread_ts || '__channel__';
    const existing = threadGroups.get(threadKey);
    if (existing) existing.push(msg);
    else threadGroups.set(threadKey, [msg]);
  }

  // Process threads in parallel — first thread reuses the slot already claimed
  // by runForGroup, additional threads claim their own slots
  const threadEntries = Array.from(threadGroups.entries());
  let allSuccess = true;

  const threadPromises = threadEntries.map(async ([threadKey, threadMessages], index) => {
    const threadTs = threadKey === '__channel__' ? undefined : threadKey;

    // First thread reuses the orchestrator's slot; additional threads need their own
    if (index > 0) {
      // Wait for a slot to become available
      while (!queue.claimSlot()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    try {
      queue.registerThread(chatJid, threadKey, null!, `pending-${threadKey}`, group.folder);
      const success = await processThread(chatJid, group, threadTs, threadKey, isMainGroup, threadMessages);
      if (!success) allSuccess = false;
    } finally {
      queue.unregisterThread(chatJid, threadKey);
      // Release the slot for additional threads (not the first one — managed by runForGroup)
      if (index > 0) {
        queue.releaseSlot();
      }
    }
  });

  await Promise.all(threadPromises);

  return allSuccess;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  sessionKey: string,
  threadTs: string | undefined,
  threadKey: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[sessionKey];

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
          sessions[sessionKey] = output.newSessionId;
          setSession(sessionKey, output.newSessionId);
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
        chatJid,
        isMain,
        threadTs,
        threadKey,
      },
      (proc, containerName) => queue.registerThread(chatJid, threadKey, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
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

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

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

          // Group messages by thread
          const threadGroups = new Map<string, NewMessage[]>();
          for (const msg of groupMessages) {
            const threadKey = msg.thread_ts || '__channel__';
            const existing = threadGroups.get(threadKey);
            if (existing) existing.push(msg);
            else threadGroups.set(threadKey, [msg]);
          }

          let shouldEnqueue = false;

          for (const [threadKey, threadMsgs] of threadGroups) {
            const threadTs = threadKey === '__channel__' ? undefined : threadKey;

            // For non-main groups, only act on trigger messages per-thread.
            // Non-trigger messages accumulate in DB and get pulled as
            // context when a trigger eventually arrives.
            if (needsTrigger) {
              const hasTrigger = threadMsgs.some((m) =>
                TRIGGER_PATTERN.test(m.content.trim()),
              );
              if (!hasTrigger) continue;
            }

            const cKey = cursorKey(chatJid, threadTs);

            // If same thread is active in a container, pipe messages to it
            if (queue.isThreadActive(chatJid, threadKey)) {
              const allPending = getMessagesSince(
                chatJid,
                lastAgentTimestamp[cKey] || '',
                ASSISTANT_NAME,
              ).filter((m) => (m.thread_ts ?? null) === (threadTs ?? null));
              const messagesToSend =
                allPending.length > 0 ? allPending : threadMsgs;
              const formatted = formatMessages(messagesToSend);

              if (queue.sendMessage(chatJid, formatted, threadKey)) {
                logger.debug(
                  { chatJid, thread: threadTs, count: messagesToSend.length },
                  'Piped messages to active container',
                );
                lastAgentTimestamp[cKey] =
                  messagesToSend[messagesToSend.length - 1].timestamp;
                saveState();
                // Show typing indicator while the container processes the piped message
                slack.setTyping(chatJid, true);
                continue;
              }
            }

            // Thread not active — enqueue for processing
            shouldEnqueue = true;
          }

          if (shouldEnqueue) {
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
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = getChannelMinCursor(chatJid);
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Docker is not running                                  ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without Docker. To fix:                     ║');
    console.error('║  macOS: Start Docker Desktop                                   ║');
    console.error('║  Linux: sudo systemctl start docker                            ║');
    console.error('║                                                                ║');
    console.error('║  Install from: https://docker.com/products/docker-desktop      ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Docker is required but not running');
  }

  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    const output = execSync('docker ps --filter "name=nanoclaw-" --format "{{.Names}}"', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(`docker stop ${name}`, { stdio: 'pipe' });
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
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await slack.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create Slack channel
  slack = new SlackChannel({
    onMessage: (chatJid, msg) => storeMessage(msg),
    onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
    registeredGroups: () => registeredGroups,
  });

  // Connect — resolves when Socket Mode is ready
  await slack.connect();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder, threadKey) =>
      queue.registerThread(groupJid, threadKey, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await slack.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, threadTs) => slack.sendMessage(jid, text, threadTs),
    sendFile: (jid, filePath, filename, title, comment, threadTs) => slack.sendFile(jid, filePath, filename, title, comment, threadTs),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (_force) => slack.syncChannelMetadata(),
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
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
