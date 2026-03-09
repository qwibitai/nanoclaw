import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_MODEL,
  IDLE_TIMEOUT,
  MODEL_ALIASES,
  MODEL_OVERRIDE_PATTERN,
  POLL_INTERVAL,
  SESSION_IDLE_RESET_HOURS,
  SESSION_SWEEP_INTERVAL,
  THREAD_DEBOUNCE_MS,
  THREAD_SESSION_IDLE_HOURS,
  buildTriggerPattern,
  resolveAssistantName,
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
  buildSessionKey,
  deleteSessionV2,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessionsV2,
  getAllTasks,
  getIdleSessions,
  findPendingThreadJids,
  getMessageById,
  getMessagesSince,
  getRecentMessages,
  getNewMessages,
  getRouterState,
  initDatabase,
  pruneThreadOrigins,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setSessionV2,
  storeChatMetadata,
  storeMessage,
  touchSessionActivity,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { checkUserOverride, shouldResetSession } from './topic-classifier.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions = new Map<string, string>(); // V2: composite session keys
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// Thread creation debounce: batch rapid messages before enqueuing
// Key: parentJid, Value: debounce timer
const debounceTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

// Throttle touchSessionActivity to max once per 30s per session key
const lastTouchTime = new Map<string, number>();

function throttledTouchActivity(sessionKey: string): void {
  const now = Date.now();
  const last = lastTouchTime.get(sessionKey) || 0;
  if (now - last >= 30_000) {
    touchSessionActivity(sessionKey);
    lastTouchTime.set(sessionKey, now);
  }
}

/**
 * Resolve a chat JID to its registered group, handling thread JID formats.
 * Thread JIDs: dc:{parentId}:thread:{threadId}, slack:{channel}:thread:{ts}
 */
function resolveGroup(
  jid: string,
): { group: RegisteredGroup; threadId?: string } | undefined {
  const direct = registeredGroups[jid];
  if (direct) return { group: direct };

  // Discord thread: dc:{parentId}:thread:{threadId}
  const dcMatch = jid.match(/^(dc:[^:]+):thread:(.+)$/);
  if (dcMatch) {
    const parent = registeredGroups[dcMatch[1]];
    if (parent) return { group: parent, threadId: dcMatch[2] };
  }

  // Slack thread: slack:{channel}:thread:{ts}
  const slackMatch = jid.match(/^(slack:[^:]+):thread:(.+)$/);
  if (slackMatch) {
    const parent = registeredGroups[slackMatch[1]];
    if (parent) return { group: parent, threadId: slackMatch[2] };
  }

  return undefined;
}

/**
 * Check if thread sessions are enabled for a group.
 * Default on for Discord/Slack channels; explicit false to disable.
 */
function isThreadSessionEnabled(jid: string, group: RegisteredGroup): boolean {
  if (group.containerConfig?.enableThreadSessions === false) return false;
  if (group.containerConfig?.enableThreadSessions === true) return true;
  // Default: on for Discord and Slack, off for others
  return jid.startsWith('dc:') || jid.startsWith('slack:');
}

/** Extract parent JID from a thread JID, or return the JID unchanged. */
function getParentJid(jid: string): string {
  const dcMatch = jid.match(/^(dc:[^:]+):thread:.+$/);
  if (dcMatch) return dcMatch[1];
  const slackMatch = jid.match(/^(slack:[^:]+):thread:.+$/);
  if (slackMatch) return slackMatch[1];
  return jid;
}

/**
 * Extract a per-message model override from raw message content.
 * Looks for "use opus", "use sonnet", "use haiku" in any message.
 * Returns the full model ID or undefined.
 */
function extractModelOverride(messages: NewMessage[]): string | undefined {
  for (const msg of messages) {
    const match = MODEL_OVERRIDE_PATTERN.exec(msg.content);
    if (match) {
      const alias = match[1].toLowerCase();
      return MODEL_ALIASES[alias];
    }
  }
  return undefined;
}

/**
 * Resolve a model alias (e.g. "opus") to a full model ID.
 * Passes through full IDs unchanged.
 */
function resolveAlias(model: string): string {
  return MODEL_ALIASES[model.toLowerCase()] || model;
}

/**
 * Resolve the model for a container run.
 * Priority: per-message override > per-group config > global default.
 */
function resolveModel(
  group: RegisteredGroup,
  messageOverride?: string,
): string {
  if (messageOverride) return messageOverride; // already resolved from alias
  const groupModel = group.containerConfig?.model;
  if (groupModel) return resolveAlias(groupModel);
  return DEFAULT_MODEL;
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
  sessions = getAllSessionsV2();
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
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const resolved = resolveGroup(chatJid);
  if (!resolved) return true;
  const { group, threadId } = resolved;

  // Use parent JID for channel lookup (channels own parent JIDs, not thread JIDs)
  const parentJid = getParentJid(chatJid);
  const channel = findChannel(channels, parentJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;
  const groupAssistantName = resolveAssistantName(group.containerConfig);
  const triggerPattern = buildTriggerPattern(groupAssistantName);

  // Query messages using the chatJid directly:
  // - Slack threads: stored as slack:{channel}:thread:{ts} → query that JID
  // - Discord threads: stored under parent JID → chatJid IS the parent JID
  //   (Discord emits thread JIDs on inbound but stores under parent)
  // - Top-level messages: chatJid = parentJid → same either way
  let queryJid = chatJid;
  const sinceTimestamp =
    lastAgentTimestamp[chatJid] || lastAgentTimestamp[parentJid] || '';
  let missedMessages = getMessagesSince(
    queryJid,
    sinceTimestamp,
    groupAssistantName,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Topic classifier for threadless channels (WhatsApp, Telegram)
  // Discord/Slack use thread-as-session instead, so skip classifier for them.
  const isThreadChannel =
    chatJid.startsWith('dc:') || chatJid.startsWith('slack:');
  if (!isThreadChannel && !threadId) {
    const sessionKey = buildSessionKey(group.folder);
    const existingSession = sessions.get(sessionKey);

    if (existingSession) {
      // Check for user override commands
      const lastMsg = missedMessages[missedMessages.length - 1];
      const override = checkUserOverride(lastMsg.content);

      if (override === 'new') {
        deleteSessionV2(sessionKey);
        sessions.delete(sessionKey);
        logger.info(
          { sessionKey, reason: 'user_override' },
          'Session reset (/new)',
        );
      } else if (override !== 'continue') {
        // Run topic classifier (if not overridden to continue)
        const recentMsgs = getRecentMessages(chatJid, 5);
        const lastActivity = recentMsgs[0]?.timestamp;
        const idleMinutes = lastActivity
          ? (Date.now() - new Date(lastActivity).getTime()) / 60000
          : Infinity;

        const decision = await shouldResetSession(
          recentMsgs.map((m) => ({
            content: m.content,
            is_from_me: !!m.is_from_me,
          })),
          lastMsg.content,
          idleMinutes,
        );

        if (decision.reset) {
          deleteSessionV2(sessionKey);
          sessions.delete(sessionKey);
          logger.info(
            { sessionKey, reason: decision.reason, idleMinutes },
            'Session reset (topic change)',
          );
        }
      }
    }
  }

  // ── effectiveThreadId decision tree ──────────────────────────
  // 1. Thread reply (threadId from resolveGroup): use as-is
  //    Session key: {folder}:thread:{threadId}
  // 2. Top-level msg on thread-enabled channel: use triggerMsg.id
  //    Slack: msg.ts = thread_ts for replies → same session
  //    Discord: one-shot session (thread replies use threadOriginMessage)
  // 3. Non-thread channel (WA/Telegram) or disabled: undefined
  //    Uses group-level session; topic classifier handles resets
  // ─────────────────────────────────────────────────────────────
  let effectiveThreadId = threadId;
  const isThreadEnabled = isThreadSessionEnabled(chatJid, group);
  if (isThreadEnabled && !effectiveThreadId && missedMessages.length > 0) {
    const triggerMsg = missedMessages[missedMessages.length - 1];
    effectiveThreadId = triggerMsg.id;
  }

  // For thread sessions on first invocation (no existing session),
  // prepend the parent message that started the thread for context.
  // The parent message is stored under the parent JID with id = threadId (Slack ts).
  if (effectiveThreadId && threadId) {
    const sessionKey = buildSessionKey(group.folder, effectiveThreadId);
    const existingSession = sessions.get(sessionKey);
    if (!existingSession) {
      const parentMsg = getMessageById(effectiveThreadId, parentJid);
      if (parentMsg && !missedMessages.some((m) => m.id === parentMsg.id)) {
        missedMessages.unshift(parentMsg);
      }
    }
  }

  const modelOverride = extractModelOverride(missedMessages);
  const model = resolveModel(group, modelOverride);
  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  // Track thread ID on the queue so piping can check thread affinity
  queue.setActiveThreadId(parentJid, effectiveThreadId || null);

  const sessionKey = buildSessionKey(group.folder, effectiveThreadId);
  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      sessionKey,
      threadId: effectiveThreadId,
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
      queue.closeStdin(parentJid);
    }, IDLE_TIMEOUT);
  };

  // Use parent JID for typing/sending (channel doesn't know thread JIDs yet)
  const sendJid = chatJid;
  await channel.setTyping?.(sendJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    model,
    effectiveThreadId,
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
          await channel.sendMessage(sendJid, text);
          if (!outputSentToUser) {
            await channel.setTyping?.(sendJid, false);
          }
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      // Throttled activity touch for session sweep
      throttledTouchActivity(sessionKey);

      if (result.status === 'success') {
        queue.notifyIdle(parentJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(sendJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Clear stale thread redirect state so the next conversation (or scheduled
  // task) for this channel doesn't accidentally send into the old thread.
  channel.clearThreadState?.(parentJid);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
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
  model?: string,
  threadId?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionKey = buildSessionKey(group.folder, threadId);
  const sessionId = sessions.get(sessionKey);

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
          sessions.set(sessionKey, output.newSessionId);
          setSessionV2(sessionKey, group.folder, output.newSessionId, threadId);
          // Keep V1 in sync for upstream compat (group-level only)
          if (!threadId) setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const parentJid = getParentJid(chatJid);
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        threadId,
        assistantName: resolveAssistantName(group.containerConfig),
        model,
      },
      (proc, containerName) =>
        queue.registerProcess(parentJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions.set(sessionKey, output.newSessionId);
      setSessionV2(sessionKey, group.folder, output.newSessionId, threadId);
      if (!threadId) setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Auto-recovery: if prompt_too_long, delete broken session and retry fresh
      if (output.errorType === 'prompt_too_long' && sessionId) {
        logger.warn(
          { group: group.name, sessionKey },
          'prompt_too_long detected — deleting broken session and retrying',
        );
        deleteSessionV2(sessionKey);
        sessions.delete(sessionKey);

        // Prepend summary from the broken session (if available, capped at 4000 chars)
        const summary = output.result?.startsWith('[Previous context summary]')
          ? output.result.slice(0, 4000)
          : '';
        const retryPrompt = summary ? `${summary}\n\n---\n\n${prompt}` : prompt;

        // Retry once with fresh session (no sessionId)
        try {
          const retryOutput = await runContainerAgent(
            group,
            {
              prompt: retryPrompt,
              groupFolder: group.folder,
              chatJid,
              isMain,
              threadId,
              assistantName: resolveAssistantName(group.containerConfig),
              model,
            },
            (proc, containerName) =>
              queue.registerProcess(
                parentJid,
                proc,
                containerName,
                group.folder,
              ),
            wrappedOnOutput,
          );

          if (retryOutput.newSessionId) {
            sessions.set(sessionKey, retryOutput.newSessionId);
            setSessionV2(
              sessionKey,
              group.folder,
              retryOutput.newSessionId,
              threadId,
            );
            if (!threadId) setSession(group.folder, retryOutput.newSessionId);
          }

          if (retryOutput.status === 'error') {
            logger.error(
              { group: group.name, error: retryOutput.error },
              'Retry after prompt_too_long also failed',
            );
            return 'error';
          }

          logger.info(
            { group: group.name },
            'Auto-recovered from prompt_too_long',
          );
          return 'success';
        } catch (retryErr) {
          logger.error(
            { group: group.name, err: retryErr },
            'Retry after prompt_too_long threw',
          );
          return 'error';
        }
      }

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
          const resolved = resolveGroup(chatJid);
          if (!resolved) continue;
          const { group } = resolved;

          const parentJid = getParentJid(chatJid);
          const channel = findChannel(channels, parentJid);
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
            const groupName = resolveAssistantName(group.containerConfig);
            const groupTrigger = buildTriggerPattern(groupName);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                groupTrigger.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Thread-aware piping: if a container is active for this group,
          // check if the incoming message belongs to the same thread.
          // Only pipe if thread affinity matches; otherwise enqueue new invocation.
          const activeThreadId = queue.getActiveThreadId(parentJid);
          const isThreadEnabled = isThreadSessionEnabled(parentJid, group);

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            resolveAssistantName(group.containerConfig),
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          // Thread-aware piping decision:
          // - If thread sessions enabled and active container is handling a different thread,
          //   DON'T pipe — enqueue for a new container instead.
          // - Top-level messages (no threadId) on thread-enabled channels should NOT
          //   pipe into a thread container.
          const incomingThreadId = resolved.threadId || null;
          const canPipe =
            !isThreadEnabled || activeThreadId === incomingThreadId;

          if (canPipe && queue.sendMessage(parentJid, formatted)) {
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
              ?.catch((err: unknown) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else if (
            isThreadEnabled &&
            !incomingThreadId &&
            THREAD_DEBOUNCE_MS > 0
          ) {
            // Debounce top-level messages on thread-enabled channels:
            // Wait THREAD_DEBOUNCE_MS for rapid follow-up messages before
            // creating a new thread. Batches multiple messages into one thread.
            const existing = debounceTimers.get(parentJid);
            if (existing) {
              clearTimeout(existing);
            }
            debounceTimers.set(parentJid, setTimeout(() => {
              debounceTimers.delete(parentJid);
              queue.enqueueMessageCheck(parentJid);
            }, THREAD_DEBOUNCE_MS));
            logger.debug(
              { chatJid, debounceMs: THREAD_DEBOUNCE_MS },
              'Debouncing thread creation for rapid messages',
            );
          } else {
            // No active container or thread mismatch — enqueue for a new one.
            // Pass chatJid as processJid so the queue knows exactly which
            // JID to process (thread JID or parent JID) without needing
            // to rediscover it via LIKE queries.
            queue.enqueueMessageCheck(parentJid, chatJid);
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
 * For thread-capable channels (Discord/Slack), also discovers pending thread messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const assistantName = resolveAssistantName(group.containerConfig);
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';

    // Parent messages
    const pending = getMessagesSince(chatJid, sinceTimestamp, assistantName);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid); // parent processes itself
    }

    // Thread messages (Discord and Slack channels only)
    if (chatJid.startsWith('dc:') || chatJid.startsWith('slack:')) {
      const threadJids = findPendingThreadJids(
        chatJid,
        lastAgentTimestamp,
        assistantName,
      );
      for (const threadJid of threadJids) {
        logger.info(
          { group: group.name, threadJid },
          'Recovery: found unprocessed thread messages',
        );
        queue.enqueueMessageCheck(chatJid, threadJid);
      }
    }
  }
}

/**
 * Session sweep: periodically clean up idle sessions.
 * Runs every SESSION_SWEEP_INTERVAL (5 min).
 */
function startSessionSweep(): void {
  const sweep = () => {
    try {
      // Compute cutoff for group-level sessions
      const groupCutoff = new Date(
        Date.now() - SESSION_IDLE_RESET_HOURS * 60 * 60 * 1000,
      ).toISOString();

      const idleSessions = getIdleSessions(groupCutoff);
      if (idleSessions.length === 0) return;

      // Collect group folders with active containers (skip ALL their sessions)
      const activeFolders = new Set<string>();
      for (const [jid] of Object.entries(registeredGroups)) {
        if (queue.isActive(jid)) {
          const group = registeredGroups[jid];
          if (group) activeFolders.add(group.folder);
        }
      }

      for (const session of idleSessions) {
        // Skip if any container is active for this group
        if (activeFolders.has(session.group_folder)) continue;

        // For thread sessions, use thread-specific idle hours if configured
        if (session.thread_id) {
          const group = Object.values(registeredGroups).find(
            (g) => g.folder === session.group_folder,
          );
          const threadIdleHours =
            group?.containerConfig?.threadSessionIdleHours ??
            THREAD_SESSION_IDLE_HOURS;
          const threadCutoff = new Date(
            Date.now() - threadIdleHours * 60 * 60 * 1000,
          ).toISOString();
          if (session.last_activity >= threadCutoff) continue;
        }

        // Honor sessionIdleResetHours: 0 as "never auto-reset"
        if (!session.thread_id) {
          const group = Object.values(registeredGroups).find(
            (g) => g.folder === session.group_folder,
          );
          const idleHours =
            group?.containerConfig?.sessionIdleResetHours ??
            SESSION_IDLE_RESET_HOURS;
          if (idleHours === 0) continue;
          const specificCutoff = new Date(
            Date.now() - idleHours * 60 * 60 * 1000,
          ).toISOString();
          if (session.last_activity >= specificCutoff) continue;
        }

        // Delete the session from DB (disk cleanup happens on container close)
        deleteSessionV2(session.session_key);
        sessions.delete(session.session_key);
        logger.info(
          {
            sessionKey: session.session_key,
            reason: 'idle_timeout',
            lastActivity: session.last_activity,
          },
          'Session swept (idle)',
        );
      }
      // Prune stale thread entries from lastAgentTimestamp and lastTouchTime.
      // Use the max configured idle hours across all groups so we don't prune
      // timestamps that a group with a longer idle window still needs.
      const registeredJids = new Set(Object.keys(registeredGroups));
      let maxIdleHours = Math.max(SESSION_IDLE_RESET_HOURS, THREAD_SESSION_IDLE_HOURS);
      for (const group of Object.values(registeredGroups)) {
        const h = group.containerConfig?.threadSessionIdleHours;
        if (h && h > maxIdleHours) maxIdleHours = h;
        const sh = group.containerConfig?.sessionIdleResetHours;
        if (sh && sh > maxIdleHours) maxIdleHours = sh;
      }
      const pruneCutoff = Date.now() - maxIdleHours * 60 * 60 * 1000;
      let pruned = 0;
      for (const key of Object.keys(lastAgentTimestamp)) {
        if (registeredJids.has(key)) continue; // Keep registered groups
        const ts = new Date(lastAgentTimestamp[key]).getTime();
        if (ts < pruneCutoff) {
          delete lastAgentTimestamp[key];
          pruned++;
        }
      }
      for (const [key, ts] of lastTouchTime) {
        if (ts < pruneCutoff) lastTouchTime.delete(key);
      }
      if (pruned > 0) {
        saveState();
        logger.debug({ pruned }, 'Pruned stale lastAgentTimestamp entries');
      }

      // Prune old thread_origins rows (7 days — they're immutable mappings,
      // keep longer than sessions so restarts within a week still resolve)
      const originsCutoff = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const originsPruned = pruneThreadOrigins(originsCutoff);
      if (originsPruned > 0) {
        logger.debug({ originsPruned }, 'Pruned stale thread_origins entries');
      }
    } catch (err) {
      logger.error({ err }, 'Error in session sweep');
    }
  };

  setInterval(sweep, SESSION_SWEEP_INTERVAL);
  logger.info('Session sweep started');
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  // Prevent multiple instances — WhatsApp revokes sessions on conflict
  const pidFile = path.join(DATA_DIR, 'nanoclaw.pid');
  if (fs.existsSync(pidFile)) {
    const oldPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    try {
      process.kill(oldPid, 0); // check if still running
      logger.error(
        { oldPid },
        'Another NanoClaw instance is running. Kill it first or remove ' +
          pidFile,
      );
      process.exit(1);
    } catch {
      // Process not running, stale pid file — continue
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // best-effort
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && resolveGroup(chatJid)) {
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
    registerGroup,
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
  }

  // Connect all channels in parallel — they're independent of each other
  const connectResults = await Promise.allSettled(
    channels.map((ch) => ch.connect()),
  );
  // Remove channels that failed to connect
  for (let i = connectResults.length - 1; i >= 0; i--) {
    if (connectResults[i].status === 'rejected') {
      const failed = channels[i];
      logger.error(
        {
          channel: failed.name,
          err: (connectResults[i] as PromiseRejectedResult).reason,
        },
        'Channel failed to connect',
      );
      channels.splice(i, 1);
    }
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start session sweep (idle session cleanup)
  startSessionSweep();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => Object.fromEntries(sessions),
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
