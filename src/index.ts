import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  STORE_DIR,
  TRIGGER_PATTERN,
} from './config.js';
import { getLeadAgentId, loadAgentsConfig, resolveAgentImage } from './agents.js';
import { loadChannels } from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  writeWorkersSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  getAllAgentDefinitions,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getAgentDefinition,
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
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { createCamBotCore, createStandaloneConfig } from 'cambot-core';
import { createLifecycleInterceptor } from './lifecycle-interceptor.js';
import type { LifecycleInterceptor } from './lifecycle-interceptor.js';
import { readEnvFile } from './env.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

/**
 * Remove orphaned IPC input files (messages + _close sentinel) so a retry
 * container starts with a clean input directory.
 */
function cleanIpcInputDir(groupFolder: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  try {
    for (const f of fs.readdirSync(inputDir)) {
      if (f.endsWith('.json') || f === '_close') {
        try { fs.unlinkSync(path.join(inputDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore — dir may not exist */ }
}

const channels: Channel[] = [];
const queue = new GroupQueue();
let interceptor: LifecycleInterceptor | null = null;

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
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
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
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
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
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Clean stale IPC input files from previous container runs before spawning.
  // Prevents orphaned containers' leftover files from being misprocessed.
  cleanIpcInputDir(group.folder);

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const rawPrompt = formatMessages(missedMessages);

  // Lifecycle interceptor: boot context + PII redaction
  // Build the full prompt first (boot context + message text), then redact
  // everything in one pass so entity names in boot context headings get caught.
  const bootContext = interceptor ? interceptor.getBootContext() : '';
  const fullRawPrompt = bootContext
    ? `<system-context>\n${bootContext}\n</system-context>\n\n${rawPrompt}`
    : rawPrompt;
  const { redacted: prompt, mappings: piiMappings } = interceptor
    ? interceptor.redactPrompt(fullRawPrompt)
    : { redacted: fullRawPrompt, mappings: [] };
  interceptor?.startSession(group.folder, chatJid);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
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

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let lastSentText = '';
  let lastSentTime = 0;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        // Suppress duplicate outputs within a 10-second window (defense-in-depth
        // against SDK/container emitting the same result multiple times)
        const now = Date.now();
        if (text === lastSentText && (now - lastSentTime) < 10_000) {
          logger.warn({ group: group.name }, 'Duplicate agent output suppressed');
        } else {
          lastSentText = text;
          lastSentTime = now;
          const restoredText = interceptor
            ? interceptor.restoreOutput(text, piiMappings)
            : text;
          await channel.sendMessage(chatJid, restoredText);
          interceptor?.ingestResponse(group.folder, chatJid, restoredText);
          outputSentToUser = true;
        }
      }

      // Advance cursor to cover any messages piped via IPC that the
      // container has now processed.  The message loop does NOT advance
      // the cursor when piping — we do it here on confirmed output.
      const latest = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
      if (latest.length > 0) {
        lastAgentTimestamp[chatJid] = latest[latest.length - 1].timestamp;
        saveState();
      }

      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  interceptor?.endSession(group.folder, output !== 'error' && !hadError);

  if (output === 'error' || hadError) {
    cleanIpcInputDir(group.folder);
    // If we already sent output to the user, check for remaining messages
    // before giving up — IPC-piped messages may still need processing.
    if (outputSentToUser) {
      const remaining = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
      if (remaining.length > 0) {
        logger.warn({ group: group.name, count: remaining.length }, 'Agent error after output; unprocessed messages remain, retrying');
        return false;
      }
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  // Safety net: detect messages piped via IPC that the container never
  // processed (e.g. container exited before reading the IPC file, SDK
  // hang, Docker bind-mount visibility delay on Windows, etc.).
  const remaining = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
  if (remaining.length > 0) {
    logger.warn(
      { group: group.name, count: remaining.length },
      'Unprocessed messages found after container exit, re-queuing',
    );
    cleanIpcInputDir(group.folder);
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
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

  // Update available workers snapshot for delegation
  const allWorkers = getAllAgentDefinitions();
  writeWorkersSnapshot(group.folder, allWorkers);

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const leadId = getLeadAgentId();
    const agentOpts = resolveAgentImage(leadId);

    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      agentOpts,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
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

  logger.info(`CamBot-Agent running (trigger: @${ASSISTANT_NAME})`);

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

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
            continue;
          }

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

          // Pull messages since the latest piped timestamp (to avoid
          // re-piping already-sent messages), falling back to lastAgentTimestamp
          // for the first pipe of this container session.
          const pipeSince = queue.getLastPipedTimestamp(chatJid)
            || lastAgentTimestamp[chatJid] || '';
          const allPending = getMessagesSince(
            chatJid,
            pipeSince,
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);
          const safeFormatted = interceptor
            ? interceptor.redactPrompt(formatted).redacted
            : formatted;

          const latestTs = messagesToSend[messagesToSend.length - 1]?.timestamp;
          if (queue.sendMessage(chatJid, safeFormatted, latestTs)) {
            logger.info(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container via IPC',
            );
            // Cursor is NOT advanced here. processGroupMessages advances it
            // in the onOutput callback when the container confirms processing.
            // If the container exits without processing, the safety-net check
            // in processGroupMessages detects remaining messages and retries.
            channel.setTyping?.(chatJid, true)?.catch((err) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
          } else {
            // No active container — enqueue for a new one
            logger.info(
              { chatJid, count: messagesToSend.length },
              'No active container, enqueueing for new container',
            );
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
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }

  // Sync global "seen" cursor to prevent startMessageLoop from
  // rediscovering messages that recovery already claimed.
  const maxAgentTs = Object.values(lastAgentTimestamp).reduce(
    (max, ts) => (ts > max ? ts : max),
    lastTimestamp,
  );
  if (maxAgentTs > lastTimestamp) {
    logger.info(
      { old: lastTimestamp, new: maxAgentTs },
      'Recovery: advancing lastTimestamp to match agent cursors',
    );
    lastTimestamp = maxAgentTs;
    saveState();
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err);
  });
  process.on('beforeExit', (code) => {
    console.error('[DEBUG] beforeExit code:', code);
  });
  process.on('exit', (code) => {
    console.error('[DEBUG] exit code:', code);
  });
  process.on('SIGTERM', () => console.error('[DEBUG] SIGTERM'));
  process.on('SIGINT', () => console.error('[DEBUG] SIGINT'));

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  loadAgentsConfig();

  // Initialize cambot-core lifecycle interceptor
  try {
    const coreEnv = readEnvFile(['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CAMBOT_DB_PATH']);
    const coreConfig = createStandaloneConfig({
      dbPath: coreEnv.CAMBOT_DB_PATH || process.env.CAMBOT_DB_PATH || path.join(STORE_DIR, 'cambot-core.sqlite'),
      geminiApiKey: coreEnv.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
      anthropicApiKey: coreEnv.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
      piiRedactionTags: [],
    });
    const core = createCamBotCore(coreConfig);
    interceptor = createLifecycleInterceptor(core, logger);
    interceptor.startPeriodicTasks();
    logger.info('Lifecycle interceptor initialized');
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize lifecycle interceptor, running without memory');
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    if (interceptor) await interceptor.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => {
      storeMessage(msg);
      interceptor?.ingestMessage(msg);
    },
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup,
  };

  // Create and connect channels
  channels.push(...await loadChannels(channelOpts));

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) {
        await channel.sendMessage(jid, text);
        // Ingest scheduled task output for fact extraction
        const group = registeredGroups[jid];
        if (group) interceptor?.ingestResponse(group.folder, jid, text);
      }
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: async (force) => {
      for (const ch of channels) await ch.syncMetadata?.(force);
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    resolveAgentImage,
    getAgentDefinition,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start CamBot-Agent');
    process.exit(1);
  });
}
