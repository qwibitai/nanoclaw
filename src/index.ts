import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRUST_GATEWAY_PORT,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  deleteRouterState,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getPendingCursors,
  getRouterState,
  initDatabase,
  logSessionCost,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  getPendingTrustApprovalIds,
} from './db.js';
import { ExecutorPool } from './executor-pool.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { isBudgetExceeded } from './budget.js';
import {
  formatApprovalPrompt,
  handlePotentialApprovalReply,
} from './trust-approval-handler.js';
import {
  parseTrustCommand,
  executeTrustCommand,
} from './trust-commands.js';
import { startTrustGateway } from './trust-gateway.js';
import { startDealWatchLoop } from './deal-watch-loop.js';
import { startEmailSSE } from './email-sse.js';
import {
  refreshGmailTokens,
  startGmailRefreshLoop,
} from './gmail-token-refresh.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { eventBus } from './event-bus.js';
import type {
  MessageInboundEvent,
  MessageOutboundEvent,
  SystemStartupEvent,
} from './events.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new ExecutorPool();
queue.initWarmPool();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
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
  // Recover from interrupted processing: if any group has a pending cursor,
  // it means the previous process was killed mid-work. Roll back the cursor
  // so those messages get re-processed.
  const pendingCursors = getPendingCursors();
  for (const [jid, previousCursor] of pendingCursors) {
    const currentCursor = lastAgentTimestamp[jid];
    if (currentCursor && currentCursor > previousCursor) {
      lastAgentTimestamp[jid] = previousCursor;
      logger.info(
        { jid, rolledBackFrom: currentCursor, rolledBackTo: previousCursor },
        'Recovered pending cursor — messages will be re-processed',
      );
    }
    deleteRouterState(`pending_cursor:${jid}`);
  }
  if (pendingCursors.size > 0) {
    setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  }

  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
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

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

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
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** @internal - exported for testing */
export { loadState as _loadState };

/** @internal - exported for testing */
export { registerGroup as _registerGroup };

/** @internal - exported for testing */
export { processGroupMessages as _processGroupMessages };

/** @internal - exported for testing */
export { runAgent as _runAgent };

/**
 * Process all pending messages for a group.
 * Called by the ExecutorPool when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  // The pending cursor is persisted to DB so we can recover on crash/restart.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  setRouterState(`pending_cursor:${chatJid}`, previousCursor);
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
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Progress UX: three states — ack → narrate → alert.
  //
  // 1. Immediately send an editable "⏳ Working…" message (confirms receipt,
  //    persists even if you leave/re-enter the chat).
  // 2. Refresh the typing indicator every 5s as an ambient "still alive" signal.
  // 3. Update the progress message only on progressLabel changes (tool narration).
  // 4. Alert only after 5 minutes of silence — before that, typing indicator
  //    is sufficient and avoids false-positive "stuck" warnings on complex tasks.
  // 5. Delete the progress message when the real response arrives.
  let progressHandle: {
    update: (t: string) => Promise<void>;
    clear: () => Promise<void>;
  } | null = null;
  if (channel.sendProgress) {
    progressHandle = await channel.sendProgress(chatJid, '⏳ Working…');
  } else {
    await channel.setTyping?.(chatJid, true);
  }

  // Refresh typing indicator every 5s (Telegram typing expires after ~5s).
  const typingInterval = setInterval(async () => {
    try {
      await channel.setTyping?.(chatJid, true);
    } catch {
      // Swallow — typing is best-effort
    }
  }, 5_000);

  let hadError = false;
  let outputSentToUser = false;
  const responseStartMs = Date.now();
  let lastActivityMs = Date.now();

  // Watchdog: only alert after 5 minutes of silence — genuine problems only.
  const WATCHDOG_ALERT_MS = 300_000;
  let watchdogFired = false;
  const watchdogInterval = setInterval(async () => {
    const silenceMs = Date.now() - lastActivityMs;
    if (silenceMs >= WATCHDOG_ALERT_MS && !watchdogFired) {
      watchdogFired = true;
      const elapsed = Math.round((Date.now() - responseStartMs) / 1000);
      const mins = Math.round(elapsed / 60);
      if (progressHandle) {
        await progressHandle.update(
          `⚠️ No response after ${mins}m — may need attention`,
        );
      }
    }
  }, 30_000);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    lastActivityMs = Date.now();
    watchdogFired = false; // reset on any activity

    // Tool narration: update progress message with what the agent is doing.
    // No elapsed time — keeps it clean and avoids adding anxiety.
    if (result.progressLabel && progressHandle) {
      await progressHandle.update(`⏳ ${result.progressLabel}…`);
    }

    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        // Clear progress message before sending the real response
        if (progressHandle) {
          await progressHandle.clear();
          progressHandle = null;
        }
        // Only add transparency footer to substantive responses.
        // Short one-liners (< 80 chars) don't need turn counts and elapsed time.
        let outText = text;
        if (text.length >= 80) {
          const elapsedSec = Math.round((Date.now() - responseStartMs) / 1000);
          const parts: string[] = [];
          if (result.numTurns != null) parts.push(`${result.numTurns} turns`);
          parts.push(`${elapsedSec}s`);
          outText = text + `\n\n_${parts.join(' · ')}_`;
        }
        await channel.sendMessage(chatJid, outText);
        eventBus.emit('message.outbound', {
          type: 'message.outbound',
          source: 'router',
          groupId: chatJid,
          timestamp: Date.now(),
          payload: {
            chatJid,
            channel: channel.name,
            text: outText.slice(0, 200),
          },
        });
        outputSentToUser = true;
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

  clearInterval(watchdogInterval);
  clearInterval(typingInterval);
  if (progressHandle) {
    await progressHandle.clear();
    progressHandle = null;
  }
  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      deleteRouterState(`pending_cursor:${chatJid}`);
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    deleteRouterState(`pending_cursor:${chatJid}`);
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // Processing complete — clear the pending cursor
  deleteRouterState(`pending_cursor:${chatJid}`);
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  if (isBudgetExceeded()) {
    logger.warn({ group: group.name }, 'Agent blocked by budget ceiling');
    return 'error';
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Accumulate real per-query cost reported by the SDK's result messages.
  // One container run can issue multiple queries (the keep-alive loop);
  // every result message brings its own total_cost_usd, so we sum them.
  let realCostUsd = 0;
  let sawRealCost = false;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
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

  // Wrap onOutput to track session ID and accumulate real cost from streamed results
  const wrappedOnOutput = async (output: ContainerOutput) => {
    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
    if (typeof output.totalCostUsd === 'number') {
      realCostUsd += output.totalCostUsd;
      sawRealCost = true;
    }
    if (onOutput) await onOutput(output);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        verbose: group.verbose,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      const durationMs = Date.now() - startMs;
      logSessionCost({
        session_type: 'message',
        group_folder: group.folder,
        started_at: startedAt,
        duration_ms: durationMs,
        estimated_cost_usd: sawRealCost
          ? realCostUsd
          : (durationMs / 10_000) * 0.01,
      });
      return 'error';
    }

    const durationMs = Date.now() - startMs;
    logSessionCost({
      session_type: 'message',
      group_folder: group.folder,
      started_at: startedAt,
      duration_ms: durationMs,
      estimated_cost_usd: sawRealCost
        ? realCostUsd
        : (durationMs / 10_000) * 0.01,
    });
    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    const durationMs = Date.now() - startMs;
    logSessionCost({
      session_type: 'message',
      group_folder: group.folder,
      started_at: startedAt,
      duration_ms: durationMs,
      estimated_cost_usd: sawRealCost
        ? realCostUsd
        : (durationMs / 10_000) * 0.01,
    });
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

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

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // --- Trust approval interception ---
          // Check if any new message resolves a pending trust approval.
          // If so, consume it (don't pass to agent).
          const pendingIds = getPendingTrustApprovalIds(chatJid);
          if (pendingIds.length > 0) {
            for (const msg of groupMessages) {
              if (
                handlePotentialApprovalReply(msg.content, chatJid, pendingIds)
              ) {
                // Remove from batch so it doesn't trigger agent
                const idx = groupMessages.indexOf(msg);
                if (idx >= 0) groupMessages.splice(idx, 1);
              }
            }
            if (groupMessages.length === 0) continue;
          }

          // --- Trust command interception ---
          // Check if any trigger message is a trust command (e.g. "trust status").
          const triggerPatternForCmd = getTriggerPattern(group.trigger);
          for (const msg of groupMessages) {
            const trimmedContent = msg.content.trim();
            if (triggerPatternForCmd.test(trimmedContent)) {
              const strippedText = trimmedContent
                .replace(triggerPatternForCmd, '')
                .trim();
              const trustCmd = parseTrustCommand(strippedText);
              if (trustCmd) {
                const response = executeTrustCommand(trustCmd, group.folder);
                channel
                  .sendMessage(chatJid, response)
                  .catch((err) =>
                    logger.warn(
                      { chatJid, err },
                      'Failed to send trust command response',
                    ),
                  );
                const idx = groupMessages.indexOf(msg);
                if (idx >= 0) groupMessages.splice(idx, 1);
              }
            }
          }
          if (groupMessages.length === 0) continue;

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Acknowledge receipt so the user knows their message wasn't lost.
            // The agent is already busy — this ack bridges the gap until it responds.
            channel
              .sendMessage(chatJid, '↳ Got it — queued behind current task.')
              .catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to send pipe ack'),
              );
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            eventBus.emit('message.inbound', {
              type: 'message.inbound',
              source: 'channel',
              groupId: chatJid,
              timestamp: Date.now(),
              payload: { chatJid, channel: channel.name, messageCount: 1 },
            });
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
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    enqueueEmailTrigger: (chatJid, prompt, onResult) => {
      const taskId = `email-trigger-${Date.now()}`;
      queue.enqueueTask(chatJid, taskId, async () => {
        const group = registeredGroups[chatJid];
        if (!group) {
          logger.warn({ chatJid }, 'No group for email trigger');
          return;
        }

        // Pre-refresh Gmail OAuth tokens before spawning the container.
        // Tokens have a 1-hour lifetime and routinely expire mid-session,
        // causing the gmail-mcp inside the container to silently lose its
        // ability to read email bodies. Refreshing here is fast (<200ms
        // when nothing needs refresh) and never blocks the spawn — even on
        // refresh failure we proceed with subject-only classification
        // rather than dropping the trigger.
        const refreshResult = await refreshGmailTokens();
        if (refreshResult.status === 'error') {
          logger.warn(
            { chatJid, summary: refreshResult.summary },
            'Gmail token refresh failed before email trigger — agent may degrade to subject-only',
          );
        } else if (refreshResult.status === 'missing') {
          logger.debug(
            { chatJid, summary: refreshResult.summary },
            'Some Gmail accounts not authorized — proceeding with available accounts',
          );
        }

        // System-injected progress message: email triggers routinely take
        // 30-90s while the agent reads threads and drafts replies. Send a
        // single in-place-editable "⏳ Working..." message IMMEDIATELY,
        // then update it as the agent invokes tools (Reading Gmail thread →
        // Generating reply → ...). This gives the user instant confirmation
        // AND live visibility into what's happening, without spamming chat.
        // Channels that don't support edit-in-place fall back to
        // append-only via sendMessage.
        const ackChannel = findChannel(channels, chatJid);
        let progressHandle: {
          update: (t: string) => Promise<void>;
          clear: () => Promise<void>;
        } | null = null;
        if (ackChannel) {
          try {
            await ackChannel.setTyping?.(chatJid, true);
            if (ackChannel.sendProgress) {
              progressHandle = await ackChannel.sendProgress(
                chatJid,
                '⏳ New email(s) — processing now…',
              );
            } else {
              await ackChannel.sendMessage(
                chatJid,
                '⏳ New email(s) — processing now…',
              );
            }
          } catch (err) {
            logger.debug(
              { chatJid, err },
              'Failed to send email-trigger acknowledgment',
            );
          }
        }

        // Email triggers are single-shot: agent replies, we're done. Close
        // the container shortly after the first result so it exits cleanly
        // via the _close sentinel instead of hanging for the 30-min idle
        // window (during which external OOM reapers can SIGKILL it and
        // produce confusing code-137 exits).
        const EMAIL_TRIGGER_CLOSE_DELAY_MS = 10_000;
        let closeScheduled = false;
        const scheduleClose = () => {
          if (closeScheduled) return;
          closeScheduled = true;
          setTimeout(() => {
            logger.debug(
              { chatJid, taskId },
              'Closing email-trigger container after result',
            );
            queue.closeStdin(chatJid);
          }, EMAIL_TRIGGER_CLOSE_DELAY_MS);
        };

        const result = await runAgent(
          group,
          prompt,
          chatJid,
          async (output) => {
            // Live tool-call narration: edit the in-place ack message with
            // whatever the agent is currently doing.
            if (output.progressLabel && progressHandle) {
              await progressHandle.update(`⏳ ${output.progressLabel}…`);
            }
            if (output.result) {
              // Real result arrived — clear the progress message before
              // sending, so the chat ends with a single clean answer.
              if (progressHandle) {
                await progressHandle.clear();
                progressHandle = null;
              }
              const clean = formatOutbound(output.result);
              if (clean) await onResult(clean);
              scheduleClose();
            }
          },
        );

        // If we errored out before any result landed, still clean up the
        // progress message so the user isn't left staring at "⏳ …".
        if (progressHandle) {
          await progressHandle.clear();
          progressHandle = null;
        }

        if (result === 'error') {
          const telegramJid = Object.keys(registeredGroups).find((jid) =>
            jid.startsWith('tg:'),
          );
          const notifyJid = telegramJid || chatJid;
          const channel = findChannel(channels, notifyJid);
          if (channel) {
            await channel.sendMessage(
              notifyJid,
              '⚠️ Email intelligence trigger failed. Check logs.',
            );
          }
        }
      });
    },
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  // Start trust gateway (containers call this before write/transact ops)
  startTrustGateway(TRUST_GATEWAY_PORT);

  // Real-time email notifications via SSE (poll is fallback)
  startEmailSSE();
  // Deal-watch: real-time HubSpot + Gong signal layer → main group.
  // Opt-in via DEAL_WATCH_ENABLED=1 in .env; no-op otherwise.
  startDealWatchLoop({
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'deal-watch: no channel owns JID, cannot send');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
  });
  // Background Gmail token refresh: tokens expire every 60 min, refresh every 45 min.
  startGmailRefreshLoop({
    onAuthExpired: (summary) => {
      // Alert via the main group's channel
      const mainJid = Object.keys(registeredGroups).find(
        (jid) => registeredGroups[jid].isMain,
      );
      if (!mainJid) return;
      const channel = findChannel(channels, mainJid);
      if (!channel) return;
      channel
        .sendMessage(
          mainJid,
          `⚠️ Gmail auth needs re-authorization.\n\nRun on your Mac:\ncd ~/.gmail-mcp && npx -y @gongrzhe/server-gmail-autoauth-mcp auth\n\nDetails: ${summary}`,
        )
        .catch((err) =>
          logger.warn({ err }, 'Failed to send Gmail auth alert'),
        );
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  eventBus.emit('system.startup', {
    type: 'system.startup',
    source: 'orchestrator',
    timestamp: Date.now(),
    payload: {
      channels: channels.map((c) => c.name),
      groupCount: Object.keys(registeredGroups).length,
    },
  });
}

// Guard: only run when executed directly, not when imported by tests
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
