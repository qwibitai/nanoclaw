import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_MODEL,
  GROUP_THREAD_KEY,
  IDLE_TIMEOUT,
  MODEL_ALIASES,
  MODEL_FLAG_PATTERN,
  MODEL_ONESHOT_PATTERN,
  POLL_INTERVAL,
  SESSION_IDLE_RESET_HOURS,
  SESSION_SWEEP_INTERVAL,
  THREAD_DEBOUNCE_MS,
  THREAD_SESSION_IDLE_HOURS,
  buildTriggerPattern,
  getParentJid,
  parseThreadJid,
  resolveAssistantName,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { cleanupOldAttachments } from './attachment-downloader.js';
import {
  ContainerAttachment,
  ContainerOutput,
  cleanupOrphanWorktrees,
  cleanupThreadWorkspace,
  runContainerAgent,
  withGroupMutex,
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
  getBotResponsesSince,
  getIdleSessions,
  getMessageById,
  getMessagesSince,
  getRecentMessages,
  getNewMessages,
  getRouterState,
  getSessionModel,
  initDatabase,
  pruneThreadOrigins,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setSessionModel,
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
import { indexSingleThread, indexThreadSummaries } from './thread-search.js';
import { checkUserOverride, shouldResetSession } from './topic-classifier.js';
import { Attachment, Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions = new Map<string, string>(); // V2: composite session keys
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// In-memory cache for message attachments.
// Attachments are ephemeral (not stored in DB) — they travel through this cache
// from onMessage() to processGroupMessages() and are cleaned up after processing.
const attachmentCache = new Map<string, Attachment[]>(); // key: message ID

const channels: Channel[] = [];
const queue = new GroupQueue();

// Thread creation debounce: batch rapid messages before enqueuing
// Key: parentJid, Value: debounce timer
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  const parsed = parseThreadJid(jid);
  if (parsed) {
    const parentJid = `${parsed.channel}:${parsed.parentId}`;
    const parent = registeredGroups[parentJid];
    if (parent) return { group: parent, threadId: parsed.threadId };
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

interface ModelOverrideResult {
  model: string; // full model ID
  sticky: boolean; // persist for rest of session?
  reset?: boolean; // clear sticky override (-m default/-m reset)
}

/**
 * Extract a per-message model override from raw message content.
 * Checks (in priority order):
 *   1. One-shot flag: "-m1 opus" — this invocation only, doesn't persist
 *   2. Sticky flag: "-m opus" — persists for rest of session; "-m default" clears
 */
function extractModelOverride(
  messages: NewMessage[],
): ModelOverrideResult | undefined {
  for (const msg of messages) {
    // One-shot flag: highest priority
    const oneshotMatch = MODEL_ONESHOT_PATTERN.exec(msg.content);
    if (oneshotMatch) {
      return {
        model: MODEL_ALIASES[oneshotMatch[1].toLowerCase()],
        sticky: false,
      };
    }

    // Sticky flag
    const flagMatch = MODEL_FLAG_PATTERN.exec(msg.content);
    if (flagMatch) {
      const alias = flagMatch[1].toLowerCase();
      if (alias === 'default' || alias === 'reset') {
        return { model: '', sticky: true, reset: true };
      }
      return { model: MODEL_ALIASES[alias], sticky: true };
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
 * Priority: per-message override > session sticky > per-group config > global default.
 */
function resolveModel(
  group: RegisteredGroup,
  messageOverride?: string,
  sessionModel?: string,
): string {
  if (messageOverride) return messageOverride; // already resolved from alias
  if (sessionModel) return sessionModel; // sticky from a previous "-m opus"
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
  const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
  const groupAssistantName = resolveAssistantName(group.containerConfig);
  const triggerPattern = buildTriggerPattern(groupAssistantName);

  const sinceTimestamp =
    lastAgentTimestamp[chatJid] || lastAgentTimestamp[parentJid] || '';
  let missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    groupAssistantName,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (needsTrigger) {
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
    // Each @trigger on the base channel is a separate conversation (possibly
    // from different people asking unrelated questions). Anchor on the first
    // trigger and truncate the batch before the next trigger so each gets its
    // own thread/container. Remaining triggers are picked up on the next cycle.
    const firstIdx = needsTrigger
      ? missedMessages.findIndex((m) => triggerPattern.test(m.content.trim()))
      : 0;
    const anchorIdx = firstIdx >= 0 ? firstIdx : 0;
    effectiveThreadId = missedMessages[anchorIdx].id;

    if (needsTrigger) {
      const nextTriggerIdx = missedMessages.findIndex(
        (m, i) => i > anchorIdx && triggerPattern.test(m.content.trim()),
      );
      if (nextTriggerIdx >= 0) {
        missedMessages = missedMessages.slice(0, nextTriggerIdx);
      }
    }
  }

  // For thread sessions on first invocation (no existing session),
  // prepend the parent message that started the thread for context.
  // The parent message is stored under the parent JID with id = threadId (Slack ts).
  // Falls back to fetching from the channel API when the message isn't in the DB
  // (e.g. external bot messages like dbt Cloud, GitHub, etc. that were never stored).
  if (effectiveThreadId && threadId) {
    const sessionKey = buildSessionKey(group.folder, effectiveThreadId);
    const existingSession = sessions.get(sessionKey);
    if (!existingSession) {
      let parentMsg = getMessageById(effectiveThreadId, parentJid);
      if (!parentMsg) {
        const channel = findChannel(channels, parentJid);
        if (channel?.fetchMessage) {
          parentMsg = await channel.fetchMessage(parentJid, effectiveThreadId);
        }
      }
      if (parentMsg && !missedMessages.some((m) => m.id === parentMsg!.id)) {
        missedMessages.unshift(parentMsg);
      }
    }
  }

  // Reattach cached attachments to messages read from DB
  for (const msg of missedMessages) {
    const cached = attachmentCache.get(msg.id);
    if (cached) {
      msg.attachments = cached;
    }
  }

  // Interleave bot responses so the agent has context of what it said.
  // Bot responses are stored separately (not in getMessagesSince) to avoid
  // re-trigger loops. Both arrays are already sorted by timestamp (ORDER BY
  // in SQL), so merge them in O(n) rather than concat+sort.
  const botResponses = getBotResponsesSince(chatJid, sinceTimestamp);
  if (botResponses.length > 0) {
    const merged: typeof missedMessages = [];
    let i = 0;
    let j = 0;
    while (i < missedMessages.length && j < botResponses.length) {
      if (missedMessages[i].timestamp <= botResponses[j].timestamp) {
        merged.push(missedMessages[i++]);
      } else {
        merged.push(botResponses[j++]);
      }
    }
    while (i < missedMessages.length) merged.push(missedMessages[i++]);
    while (j < botResponses.length) merged.push(botResponses[j++]);
    missedMessages = merged;
  }

  const sessionKey = buildSessionKey(group.folder, effectiveThreadId);

  // Model resolution: per-message flag > session sticky > per-group > default
  const overrideResult = extractModelOverride(missedMessages);
  const sessionModel = getSessionModel(sessionKey);

  let model: string;
  if (overrideResult?.reset) {
    // "-m default" / "-m reset" — clear sticky, revert to group/global default
    setSessionModel(sessionKey, null);
    model = resolveModel(group);
    logger.info(
      { group: group.name, model, sessionKey },
      'Model override cleared, reverted to default',
    );
  } else if (overrideResult) {
    model = overrideResult.model;
    if (overrideResult.sticky) {
      setSessionModel(sessionKey, overrideResult.model);
      logger.info(
        { group: group.name, model: overrideResult.model, sessionKey },
        'Model override persisted for session',
      );
    } else {
      logger.info(
        { group: group.name, model: overrideResult.model, sessionKey },
        'One-shot model override (not persisted)',
      );
    }
  } else {
    model = resolveModel(group, undefined, sessionModel);
  }

  const prompt = formatMessages(missedMessages);

  // Collect attachments from messages and remap paths for container mount
  const containerAttachments: ContainerAttachment[] = [];
  for (const msg of missedMessages) {
    if (!msg.attachments) continue;
    for (const att of msg.attachments) {
      // Remap host path to container path:
      // host: data/attachments/{group}/{msgId}/file.png
      // container: /workspace/attachments/{msgId}/file.png
      const msgDir = path.basename(path.dirname(att.localPath));
      const containerPath = `/workspace/attachments/${msgDir}/${att.filename}`;
      containerAttachments.push({
        filename: att.filename,
        mimeType: att.mimeType,
        containerPath,
        messageId: msg.id,
      });
    }
  }

  // Advance cursor in-memory so concurrent checks for this group won't
  // re-fetch these messages while the container is running. We deliberately
  // do NOT call saveState() here — persisting happens only after the container
  // completes. This way a SIGTERM/crash mid-run leaves the DB cursor at the
  // previous value, allowing startup recovery to re-process the messages.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
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
      queue.closeStdin(parentJid, effectiveThreadId);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    model,
    effectiveThreadId,
    containerAttachments.length > 0 ? containerAttachments : undefined,
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
          await channel.sendMessage(chatJid, text);
          // Persist bot response so the agent has context of what it said
          storeMessage({
            id: `bot-${crypto.randomUUID()}`,
            chat_jid: chatJid,
            sender: 'bot',
            sender_name: groupAssistantName,
            content: text,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
          });
          await channel.setTyping?.(chatJid, false);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      // Throttled activity touch for session sweep
      throttledTouchActivity(sessionKey);

      if (result.status === 'success') {
        queue.notifyIdle(parentJid, effectiveThreadId);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Clear stale thread redirect state so the next conversation (or scheduled
  // task) for this channel doesn't accidentally send into the old thread.
  // Pass effectiveThreadId so only that thread's state is cleared — other
  // concurrent threads in the same channel keep their emoji tracking intact.
  channel.clearThreadState?.(parentJid, effectiveThreadId);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      for (const msg of missedMessages) {
        attachmentCache.delete(msg.id);
      }
      saveState();
      return true;
    }
    // Roll back in-memory cursor so retries can re-process these messages.
    // No saveState() needed — we never persisted the advance.
    lastAgentTimestamp[chatJid] = previousCursor;
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // Clean up attachment cache for processed messages
  for (const msg of missedMessages) {
    attachmentCache.delete(msg.id);
  }

  // Success — persist the cursor advance now that the container has completed.
  saveState();
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  model?: string,
  threadId?: string,
  attachments?: ContainerAttachment[],
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

  // Persist session ID to both in-memory cache and SQLite (V1 + V2)
  const persistSession = (newSessionId: string) => {
    sessions.set(sessionKey, newSessionId);
    setSessionV2(sessionKey, group.folder, newSessionId, threadId);
    if (!threadId) setSession(group.folder, newSessionId);
  };

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) persistSession(output.newSessionId);
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
        attachments,
      },
      (proc, containerName) =>
        queue.registerProcess(
          parentJid,
          threadId,
          proc,
          containerName,
          group.folder,
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) persistSession(output.newSessionId);

    // Clean up worktree workspace (if one was created).
    // Must use withGroupMutex to serialize against prepareThreadWorkspace —
    // both touch .git/worktrees/ and CLAUDE.md merge-back.
    if (threadId) {
      withGroupMutex(group.folder, () =>
        cleanupThreadWorkspace(group.folder, threadId),
      ).catch((err) =>
        logger.warn(
          { group: group.name, threadId, err },
          'Worktree cleanup error',
        ),
      );

      // Index this thread's summary (if PreCompact wrote one).
      // Only indexes the single thread that just completed — not a full scan.
      setImmediate(() => {
        try {
          indexSingleThread(group.folder, threadId);
        } catch (err) {
          logger.warn({ err }, 'Post-run thread indexing failed (non-fatal)');
        }
      });
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
              attachments,
            },
            (proc, containerName) =>
              queue.registerProcess(
                parentJid,
                threadId,
                proc,
                containerName,
                group.folder,
              ),
            wrappedOnOutput,
          );

          if (retryOutput.newSessionId)
            persistSession(retryOutput.newSessionId);

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
          const groupAssistantName = resolveAssistantName(
            group.containerConfig,
          );

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const groupTrigger = buildTriggerPattern(groupAssistantName);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                groupTrigger.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Thread-aware piping: check if this specific thread already has
          // an active container. If so, pipe into it. Otherwise enqueue new.
          const isThreadEnabled = isThreadSessionEnabled(parentJid, group);
          const incomingThreadId = resolved.threadId || undefined;

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            groupAssistantName,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          // Collect attachments for piped messages
          const pipeAttachments: ContainerAttachment[] = [];
          for (const msg of messagesToSend) {
            const cached = attachmentCache.get(msg.id);
            if (!cached) continue;
            for (const att of cached) {
              const msgDir = path.basename(path.dirname(att.localPath));
              pipeAttachments.push({
                filename: att.filename,
                mimeType: att.mimeType,
                containerPath: `/workspace/attachments/${msgDir}/${att.filename}`,
                messageId: msg.id,
              });
            }
          }

          // Pipe into active container only if same thread has an active slot.
          // For thread-enabled channels, only pipe actual thread replies —
          // top-level triggers each deserve their own thread (different people
          // asking unrelated questions on the same channel).
          const canPipe =
            queue.isThreadActive(parentJid, incomingThreadId) &&
            (!isThreadEnabled || !!incomingThreadId);

          if (
            canPipe &&
            queue.sendMessage(
              parentJid,
              incomingThreadId,
              formatted,
              pipeAttachments.length > 0 ? pipeAttachments : undefined,
            )
          ) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Advance cursor in-memory only — the running container's
            // processGroupMessages will persist via saveState() on completion.
            // NOT calling saveState() here so a SIGTERM doesn't strand the cursor
            // past messages the container never responded to.
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            // Clean up attachment cache for piped messages
            for (const msg of messagesToSend) {
              attachmentCache.delete(msg.id);
            }
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
            debounceTimers.set(
              parentJid,
              setTimeout(() => {
                debounceTimers.delete(parentJid);
                queue.enqueueMessageCheck(parentJid, undefined, undefined);
              }, THREAD_DEBOUNCE_MS),
            );
            logger.debug(
              { chatJid, debounceMs: THREAD_DEBOUNCE_MS },
              'Debouncing thread creation for rapid messages',
            );
          } else {
            // No active container or thread mismatch — enqueue for a new one.
            // Pass chatJid as processJid and incomingThreadId so the queue
            // knows which JID and thread to process.
            queue.enqueueMessageCheck(parentJid, chatJid, incomingThreadId);
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

    // Thread recovery is intentionally skipped. Thread sessions are
    // user-initiated — if a restart interrupts a response, the user will
    // re-trigger by sending another message. Attempting to auto-recover
    // threads causes duplicate responses because:
    // 1. Discord bot messages aren't stored in DB (can't detect prior response)
    // 2. Cursor persistence is fragile (saveState writes entire map, can
    //    overwrite individually-fixed cursors)
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

      // Build folder→group map for O(1) lookups in the sweep loop
      const folderToGroup = new Map<string, RegisteredGroup>();
      for (const g of Object.values(registeredGroups)) {
        folderToGroup.set(g.folder, g);
      }

      for (const session of idleSessions) {
        // Skip if any container is active for this group
        if (activeFolders.has(session.group_folder)) continue;

        const group = folderToGroup.get(session.group_folder);

        // For thread sessions, use thread-specific idle hours if configured
        if (session.thread_id) {
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
      let maxIdleHours = Math.max(
        SESSION_IDLE_RESET_HOURS,
        THREAD_SESSION_IDLE_HOURS,
      );
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

      // Clean up old attachment files
      cleanupOldAttachments();

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
  // Clean up orphan worktrees from previous crash/restart
  await cleanupOrphanWorktrees();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Index thread summaries from previous runs (catches crash-orphaned summaries)
  try {
    const indexed = indexThreadSummaries();
    if (indexed > 0) logger.info({ indexed }, 'Startup thread index complete');
  } catch (err) {
    logger.warn({ err }, 'Startup thread indexing failed (non-fatal)');
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // Persist in-memory cursor positions before exiting. Containers that
    // advanced cursors (via processGroupMessages or pipe) but haven't
    // completed yet would otherwise lose those advances, causing message
    // re-processing on the next startup.
    saveState();
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
      // Cache attachments in-memory before storing (DB only keeps text)
      if (msg.attachments && msg.attachments.length > 0) {
        attachmentCache.set(msg.id, msg.attachments);
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
      queue.registerProcess(
        groupJid,
        undefined,
        proc,
        containerName,
        groupFolder,
      ),
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
