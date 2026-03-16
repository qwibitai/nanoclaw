import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
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
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getGroupUsageCategory,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  insertUsageRecord,
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
import {
  addCaseCost,
  addCaseTime,
  Case,
  formatCaseStatus,
  getActiveCases,
  getCaseById,
  getRoutableCases,
  getSuggestedCases,
  updateCase,
  writeCasesSnapshot,
} from './cases.js';
import { routeMessageToCase } from './case-router.js';
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
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup, UsageData } from './types.js';
import { logger } from './logger.js';
import { detectAuthMode } from './credential-proxy.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/**
 * Record API usage from a container result.
 * Stores one row per model used, or a single aggregate row if no model breakdown.
 */
function recordUsage(
  usage: UsageData,
  groupFolder: string,
  source: string,
  sessionId?: string,
  caseId?: string,
): void {
  const category = getGroupUsageCategory(groupFolder);
  const authMode = detectAuthMode();

  const models = Object.keys(usage.modelUsage);
  if (models.length === 1) {
    const model = models[0];
    const mu = usage.modelUsage[model];
    insertUsageRecord({
      group_folder: groupFolder,
      category,
      source,
      auth_mode: authMode,
      model,
      input_tokens: mu.inputTokens,
      output_tokens: mu.outputTokens,
      cache_read_tokens: mu.cacheReadInputTokens,
      cache_create_tokens: mu.cacheCreationInputTokens,
      cost_usd: usage.totalCostUsd,
      duration_ms: usage.durationMs ?? null,
      duration_api_ms: usage.durationApiMs ?? null,
      num_turns: usage.numTurns ?? null,
      session_id: sessionId ?? null,
      case_id: caseId ?? null,
    });
  } else {
    // Aggregate row (zero or multiple models)
    insertUsageRecord({
      group_folder: groupFolder,
      category,
      source,
      auth_mode: authMode,
      model: models.length > 0 ? models.join(',') : null,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cache_create_tokens: usage.cacheCreateTokens,
      cost_usd: usage.totalCostUsd,
      duration_ms: usage.durationMs ?? null,
      duration_api_ms: usage.durationApiMs ?? null,
      num_turns: usage.numTurns ?? null,
      session_id: sessionId ?? null,
      case_id: caseId ?? null,
    });
  }

  // Update case cost/time when running in case context
  if (caseId) {
    if (usage.totalCostUsd > 0) {
      addCaseCost(caseId, usage.totalCostUsd);
    }
    if (usage.durationMs) {
      addCaseTime(caseId, usage.durationMs);
    }
  }
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
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

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 *
 * If the group has active cases, messages are routed through the case router
 * before being dispatched to the appropriate case's container.
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

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // --- Case routing ---
  const activeCases = getActiveCases(chatJid);
  let targetCase: Case | undefined;

  if (activeCases.length > 0) {
    const lastMsg = missedMessages[missedMessages.length - 1].content.trim();

    // Status command — show all cases and return
    if (/^(status|cases|tasks)\b/i.test(lastMsg)) {
      const statusLines = activeCases.map((c) => formatCaseStatus(c));
      const suggested = getSuggestedCases(chatJid);
      let statusText = `Active cases:\n\n${statusLines.join('\n\n')}`;
      if (suggested.length > 0) {
        statusText += `\n\nSuggested dev cases:\n${suggested.map((s) => `  - ${s.name}: ${s.description.slice(0, 100)}`).join('\n')}`;
      }
      await channel.sendMessage(chatJid, statusText);
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      return true;
    }

    // Route message to a case
    const routableCases = getRoutableCases(chatJid);

    if (routableCases.length >= 2) {
      const lastMsgText = missedMessages[missedMessages.length - 1].content;
      const senderName =
        missedMessages[missedMessages.length - 1].sender_name ||
        missedMessages[missedMessages.length - 1].sender;

      const routeResult = await routeMessageToCase(
        lastMsgText,
        senderName,
        routableCases,
      );

      if (routeResult.caseId) {
        targetCase = getCaseById(routeResult.caseId) || undefined;
        logger.info(
          {
            caseId: routeResult.caseId,
            caseName: routeResult.caseName,
            confidence: routeResult.confidence,
          },
          'Message routed to case',
        );
      } else if (routeResult.suggestNew) {
        // No matching case — let the agent process without case context.
        // The agent has the create_case tool and can decide whether to
        // create a new case or handle it as a one-off.
        logger.info(
          { confidence: routeResult.confidence, reason: routeResult.reason },
          'No case match, routing to agent without case context',
        );
      }
    } else if (routableCases.length === 1) {
      targetCase = routableCases[0];
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      caseId: targetCase?.id,
      caseName: targetCase?.name,
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

  const agentStartTime = Date.now();

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Send immediate acknowledgment so users know we received their message.
  // Telegram typing indicators expire after 5s — not enough for container spawn.
  const ackPrefix = targetCase ? `[case: ${targetCase.name}]\n` : '';
  await channel
    .sendMessage(chatJid, `${ackPrefix}⏳`)
    .catch((err: unknown) =>
      logger.warn({ chatJid, err }, 'Failed to send processing ack'),
    );

  // Case-specific session key to isolate conversation context per case
  const sessionKey = targetCase ? `case:${targetCase.id}` : group.folder;

  const agentResult = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        let text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );

        // Prefix with case name for tracking in Telegram/chat
        if (
          targetCase &&
          text &&
          !text.startsWith(`[case: ${targetCase.name}]`)
        ) {
          text = `[case: ${targetCase.name}]\n${text}`;
          updateCase(targetCase.id, {
            last_message: text.slice(0, 200),
            last_activity_at: new Date().toISOString(),
          });
        }

        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        resetIdleTimer();
      }

      // Record API usage (requires usage-tracking skill)
      if (result.usage) {
        try {
          recordUsage(
            result.usage,
            group.folder,
            channel.name,
            result.newSessionId || sessions[sessionKey],
            targetCase?.id,
          );
        } catch (err) {
          logger.warn({ group: group.name, err }, 'Failed to record usage');
        }
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    targetCase,
    sessionKey,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Track time spent on this case (cost tracking requires usage-tracking skill)
  if (targetCase) {
    const durationMs = Date.now() - agentStartTime;
    try {
      addCaseTime(targetCase.id, durationMs);
    } catch (err) {
      logger.warn({ caseId: targetCase.id, err }, 'Failed to update case time');
    }
  }

  if (agentResult.status === 'error' || hadError) {
    // Send mechanistic error notification — no LLM needed, pre-canned messages.
    // Users must never be left in silence wondering if the system is broken.
    const errDetail = (agentResult.errorDetail || '').toLowerCase();
    let errorMsg: string;

    if (
      errDetail.includes('rate limit') ||
      errDetail.includes('rate_limit') ||
      errDetail.includes('429')
    ) {
      errorMsg =
        '⚠️ API rate limit reached. Your message was received — will retry automatically.';
    } else if (
      errDetail.includes('budget') ||
      errDetail.includes('billing') ||
      errDetail.includes('insufficient') ||
      errDetail.includes('credit') ||
      errDetail.includes('payment') ||
      errDetail.includes('quota')
    ) {
      errorMsg =
        '⚠️ API budget/billing issue — unable to process requests. Aviad has been notified.';
    } else if (
      errDetail.includes('401') ||
      errDetail.includes('403') ||
      errDetail.includes('unauthorized') ||
      errDetail.includes('forbidden') ||
      errDetail.includes('authentication') ||
      errDetail.includes('invalid.*key')
    ) {
      errorMsg =
        '⚠️ Authentication error — API access denied. Aviad has been notified.';
    } else if (
      errDetail.includes('timeout') ||
      errDetail.includes('timed out')
    ) {
      errorMsg =
        '⚠️ Request timed out. The task may be too complex — try breaking it into smaller parts.';
    } else if (
      errDetail.includes('docker') ||
      errDetail.includes('container') ||
      errDetail.includes('spawn')
    ) {
      errorMsg = '⚠️ Processing system unavailable. Aviad has been notified.';
    } else {
      errorMsg =
        '⚠️ Something went wrong processing your message. Will retry automatically.';
    }

    // Send error notification to user — this is mechanistic, no LLM needed
    await channel
      .sendMessage(chatJid, errorMsg)
      .catch((sendErr: unknown) =>
        logger.error(
          { chatJid, sendErr },
          'Failed to send error notification to user',
        ),
      );

    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name, errorDetail: agentResult.errorDetail },
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
  onOutput?: (output: ContainerOutput) => Promise<void>,
  targetCase?: Case,
  sessionKey?: string,
): Promise<{ status: 'success' | 'error'; errorDetail?: string }> {
  const isMain = group.isMain === true;
  const effectiveSessionKey = sessionKey || group.folder;
  const sessionId = sessions[effectiveSessionKey];

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

  // Update cases snapshot for container to read
  const allCases = getActiveCases();
  writeCasesSnapshot(group.folder, isMain, allCases);

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[effectiveSessionKey] = output.newSessionId;
          setSession(effectiveSessionKey, output.newSessionId);
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
        assistantName: ASSISTANT_NAME,
        caseId: targetCase?.id,
        caseName: targetCase?.name,
        caseType: targetCase?.type,
        caseWorkspacePath: targetCase?.workspace_path,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[effectiveSessionKey] = output.newSessionId;
      setSession(effectiveSessionKey, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return { status: 'error', errorDetail: output.error || '' };
    }

    return { status: 'success' };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      errorDetail: err instanceof Error ? err.message : String(err),
    };
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

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
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
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
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
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
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
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
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
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
