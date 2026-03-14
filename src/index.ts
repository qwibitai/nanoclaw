import {
  ASSISTANT_NAME,
  BUDGET_INTERACTIVE,
  CONTAINER_TIMEOUT_MS,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MAX_DAILY_SPEND_USD,
  MODEL_INTERACTIVE,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
  validateConfig,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDailySpendUsd,
  getMessagesSince,
  getNewMessages,
  setRouterState,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { formatMessages, formatOutbound } from './router.js';
import type { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  backupDatabase,
  ensureContainerSystemRunning,
  initDatabase,
  seedHealthTasks,
  checkCliReadiness,
  initChannels,
  startServices,
} from './bootstrap.js';
import {
  getRegisteredGroups,
  getSessions,
  getLastTimestamp,
  setLastTimestamp,
  getLastAgentTimestamp,
  getAvailableGroups,
  loadState,
  saveState,
  updateSession,
  _setRegisteredGroups,
} from './registry.js';
import {
  routeOutbound,
  findChannel,
  getChannels,
} from './routing.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';
export { getAvailableGroups, _setRegisteredGroups } from './registry.js';

// ── Utilities ─────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── State ──────────────────────────────────────────────────────────

let messageLoopRunning = false;
let shuttingDown = false;
let messageLoopDone: (() => void) | null = null;
const messageLoopFinished = new Promise<void>((resolve) => { messageLoopDone = resolve; });
const queue = new GroupQueue();

// Tracks the latest message timestamp piped to an active container via IPC.
// This is in-memory only — NOT persisted — so a crash resets it and messages retry.
// Used to (a) avoid re-piping the same messages and (b) advance cursor on success.
const pipedCursors = new Map<string, string>();

// ── Agent orchestration ───────────────────────────────────────────

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const registeredGroups = getRegisteredGroups();
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const dailySpend = getDailySpendUsd();
  if (dailySpend >= MAX_DAILY_SPEND_USD) {
    logger.warn(
      { dailySpend: dailySpend.toFixed(2), limit: MAX_DAILY_SPEND_USD, group: group.name },
      'Daily spend limit reached — skipping container spawn',
    );
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const lastAgentTimestamp = getLastAgentTimestamp();
  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
  if (missedMessages.length === 0) return true;

  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);
  const nextCursor = missedMessages[missedMessages.length - 1].timestamp;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing messages');

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  const channel = findChannel(chatJid);
  await channel?.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await routeOutbound(chatJid, text);
        outputSentToUser = true;
      }
      resetIdleTimer();
    }
    if (result.status === 'error') hadError = true;
  });

  await channel?.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // Clear piped cursor so piped messages also get retried
    pipedCursors.delete(chatJid);

    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output sent, advancing cursor');
      lastAgentTimestamp[chatJid] = nextCursor;
      saveState();
      return true;
    }
    logger.warn({ group: group.name }, 'Agent error, cursor not advanced — will retry');
    return false;
  }

  // Advance cursor to the latest of the initial batch or any piped follow-ups
  const pipedCursor = pipedCursors.get(chatJid);
  const finalCursor = pipedCursor && pipedCursor > nextCursor ? pipedCursor : nextCursor;
  pipedCursors.delete(chatJid);

  lastAgentTimestamp[chatJid] = finalCursor;
  saveState();
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const registeredGroups = getRegisteredGroups();
  const sessions = getSessions();
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  const tasks = getAllTasks();
  writeTasksSnapshot(group.folder, isMain, tasks.map((t) => ({
    id: t.id, groupFolder: t.group_folder, prompt: t.prompt,
    schedule_type: t.schedule_type, schedule_value: t.schedule_value,
    status: t.status, next_run: t.next_run,
  })));

  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          updateSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await withTimeout(
      runContainerAgent(
        group,
        { prompt, sessionId, groupFolder: group.folder, chatJid, isMain, model: MODEL_INTERACTIVE, maxBudgetUsd: BUDGET_INTERACTIVE },
        (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
      ),
      CONTAINER_TIMEOUT_MS,
      'container agent',
    );

    if (output.newSessionId) {
      updateSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      return 'error';
    }
    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

// ── Message loop ──────────────────────────────────────────────────

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (!shuttingDown) {
    try {
      const registeredGroups = getRegisteredGroups();
      const lastAgentTimestamp = getLastAgentTimestamp();
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, getLastTimestamp(), ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');
        setLastTimestamp(newTimestamp);
        saveState();

        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) existing.push(msg);
          else messagesByGroup.set(msg.chat_jid, [msg]);
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
            if (!hasTrigger) continue;
          }

          // Use the piped cursor if set (messages already sent to container but not yet confirmed),
          // otherwise fall back to the persisted cursor.
          const effectiveCursor = pipedCursors.get(chatJid) || lastAgentTimestamp[chatJid] || '';
          const allPending = getMessagesSince(chatJid, effectiveCursor, ASSISTANT_NAME);
          const messagesToSend = allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            const pipedTimestamp = messagesToSend[messagesToSend.length - 1].timestamp;
            logger.debug({ chatJid, count: messagesToSend.length }, 'Piped messages to active container');
            // Track in-memory only — cursor advances when container succeeds.
            // If container crashes, pipedCursors is cleared and messages retry.
            pipedCursors.set(chatJid, pipedTimestamp);
            findChannel(chatJid)?.setTyping?.(chatJid, true);
          } else {
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  messageLoopRunning = false;
  messageLoopDone?.();
}

// ── Recovery ──────────────────────────────────────────────────────

function recoverPendingMessages(): void {
  const staleThresholdMs = 10 * 60 * 1000;
  const now = Date.now();
  const registeredGroups = getRegisteredGroups();
  const lastAgentTimestamp = getLastAgentTimestamp();

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length === 0) continue;

    const fresh = pending.filter((m) => now - new Date(m.timestamp).getTime() < staleThresholdMs);

    if (fresh.length > 0) {
      logger.info(
        { group: group.name, freshCount: fresh.length, staleCount: pending.length - fresh.length },
        'Recovery: found fresh unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    } else {
      const latestTimestamp = pending[pending.length - 1].timestamp;
      lastAgentTimestamp[chatJid] = latestTimestamp;
      setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
      logger.info(
        { group: group.name, skippedCount: pending.length, advancedTo: latestTimestamp },
        'Recovery: skipped stale messages, advanced cursor',
      );
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  validateConfig();
  ensureContainerSystemRunning();
  backupDatabase();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  seedHealthTasks();
  checkCliReadiness();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // prevent double-shutdown
    logger.info({ signal }, 'Graceful shutdown initiated...');
    shuttingDown = true;

    // Wait for the message loop to finish its current iteration (up to 10s)
    const loopDrain = Promise.race([
      messageLoopFinished,
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    await loopDrain;

    await queue.shutdown(10_000);
    for (const ch of getChannels()) await ch.disconnect();
    logger.info({ signal }, 'Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const whatsapp = await initChannels(queue);
  startServices(queue, whatsapp);

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
