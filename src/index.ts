import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  HOST_MODE,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  WEBHOOK_ENABLED,
  WEBHOOK_PORT,
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
import { runHostAgent } from './host-runner.js';
import {
  deleteOutboxMessage,
  enqueueOutbox,
  deleteSession,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getOutboxMessages,
  incrementOutboxAttempts,
  initDatabase,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { getEffectiveModel } from './orchestrator/effective-model.js';
import {
  ensureOneCLIAgent as ensureOneCLIAgentFn,
  getAvailableGroups as getAvailableGroupsFn,
  registerGroup,
} from './orchestrator/group-registry.js';
import {
  createState,
  getOrRecoverCursor,
  loadState,
  saveState,
} from './orchestrator/state.js';
import { startIpcWatcher } from './ipc.js';
import {
  extractImages,
  findChannel,
  formatMessages,
  formatOutbound,
  sendImages,
  stripInternalTags,
} from './router.js';
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
import { SessionGuard } from './session-guard.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { createStreamEditLoop } from './stream-edit-loop.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { startWebhookServer, stopWebhookServer } from './webhook.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

const state = createState();
const sessionGuard = new SessionGuard();

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

// Aliases that keep the rest of src/index.ts readable without fully
// rewriting every state access. Each points at the same object/set as
// the canonical state, so mutations flow back.
const { compactPending, deferredCompact } = state;

function loadStateHere(): void {
  loadState(state);
}
function saveStateHere(): void {
  saveState(state);
}
function getOrRecoverCursorHere(chatJid: string): string {
  return getOrRecoverCursor(state, chatJid, ASSISTANT_NAME);
}
function registerGroupHere(jid: string, group: RegisteredGroup): void {
  registerGroup(
    { onecli, registeredGroups: state.registeredGroups },
    jid,
    group,
  );
}

/** Available groups list for the agent (barrel export). */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  return getAvailableGroupsFn(state.registeredGroups);
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  state.registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = state.registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursorHere(chatJid),
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

  // Resolve effective model (checks agent override + timeout)
  const {
    model: effectiveModel,
    reverted,
    revertedFrom,
  } = getEffectiveModel(group);
  if (reverted) {
    channel
      .sendMessage(
        chatJid,
        `Model override expired — reverted from ${revertedFrom} to ${effectiveModel}`,
      )
      .catch((err) =>
        logger.warn(
          { chatJid, err },
          'Failed to send model revert notification',
        ),
      );
  }

  const prompt = formatMessages(
    missedMessages,
    TIMEZONE,
    group,
    effectiveModel,
  );

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = state.lastAgentTimestamp[chatJid] || '';
  state.lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveStateHere();

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

  await channel.setTyping?.(chatJid, true);
  // Keep typing indicator alive (Telegram clears it after ~5s).
  // Use a flag instead of clearInterval so the keepalive survives across
  // multiple IPC queries within the same agent process (#26).
  let typingActive = true;
  const typingKeepalive = setInterval(() => {
    if (typingActive) channel.setTyping?.(chatJid, true).catch(() => {});
  }, 2000);

  let hadError = false;
  let outputSentToUser = false;
  let lastSentText: string | null = null;
  let streamMessageId: number | null = null;
  // Deferred compact: tracks whether a /compact IPC message is in-flight
  let compactInFlight = false;
  let compactSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  let streamingFailed = false;

  // Buffered streaming loop — update() is synchronous and non-blocking,
  // so it never stalls the outputChain in host-runner/container-runner.
  const streamLoop = createStreamEditLoop({
    throttleMs: 500,
    async sendOrEdit(text) {
      // Strip image tags before streaming — they must never appear in chat as raw text
      const { cleanText: streamText } = extractImages(text);
      if (!streamText) return false; // image-only chunk — skip, keep buffered
      // Conversation moved on — stop editing the old message
      if (queue.hasPendingMessages(chatJid)) {
        streamMessageId = null;
        streamingFailed = true;
        throw new Error('pending messages');
      }
      if (streamMessageId === null) {
        // First send — create the streaming message
        const msgId = await channel.sendStreamMessage!(chatJid, streamText);
        if (!msgId || typeof msgId !== 'number') {
          streamingFailed = true;
          throw new Error('sendStreamMessage failed');
        }
        streamMessageId = msgId;
        lastSentText = streamText;
        // Telegram clears typing indicator on sendMessage — re-enable it
        await channel.setTyping?.(chatJid, true).catch(() => {});
      } else {
        // Subsequent edit
        if (streamText.length > 4000) {
          streamingFailed = true;
          throw new Error('text too long for streaming edit');
        }
        try {
          await channel.editMessage!(chatJid, streamMessageId, streamText);
          lastSentText = streamText;
        } catch (err) {
          logger.warn(
            { group: group.name, error: err },
            'Stream edit failed, falling back to final send',
          );
          streamingFailed = true;
          throw err;
        }
      }
    },
  });

  let output: 'success' | 'error';
  try {
    output = await runAgent(
      group,
      prompt,
      chatJid,
      effectiveModel,
      async (result) => {
        // Streaming output callback — called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = stripInternalTags(raw);

          if (result.partial) {
            // --- Streaming partial chunk ---
            // Re-enable typing if it was paused after a previous query's final result (#26)
            if (!typingActive) {
              typingActive = true;
              await channel.setTyping?.(chatJid, true).catch(() => {});
            }
            if (!text || streamingFailed || !channel.sendStreamMessage) {
              resetIdleTimer();
              return;
            }
            streamLoop.update(text);
            resetIdleTimer();
            return;
          }

          // --- Final result ---
          // Flush any buffered streaming text before handling the final result
          await streamLoop.flush();
          await streamLoop.waitForInFlight();

          logger.info(
            { group: group.name },
            `Agent output: ${raw.length} chars`,
          );

          const { cleanText, images } = extractImages(text);

          if (streamMessageId !== null) {
            // Streaming was active — accumulated text already displayed.
            if (cleanText && cleanText !== lastSentText) {
              try {
                if (
                  !streamingFailed &&
                  cleanText.length <= 4096 &&
                  !queue.hasPendingMessages(chatJid)
                ) {
                  await channel.editMessage!(
                    chatJid,
                    streamMessageId,
                    cleanText,
                  );
                } else {
                  await channel.sendMessage(chatJid, cleanText);
                }
                // eslint-disable-next-line no-catch-all/no-catch-all
              } catch (err) {
                logger.error(
                  { group: group.name, error: err },
                  'Failed to send final message, queuing for retry',
                );
                enqueueOutbox(chatJid, cleanText);
              }
            } else if (!cleanText) {
              // No text content in final result — delete the streaming placeholder
              await channel
                .deleteMessage?.(chatJid, streamMessageId)
                .catch(() => {});
            }
            await sendImages(channel, chatJid, images);
            outputSentToUser = true;
            queue.markResponseSent(chatJid);
            lastSentText = cleanText;
          } else if (cleanText && cleanText !== lastSentText) {
            // No streaming — use normal send
            try {
              await channel.sendMessage(chatJid, cleanText);
              // eslint-disable-next-line no-catch-all/no-catch-all
            } catch (err) {
              logger.error(
                { group: group.name, error: err },
                'Failed to send message, queuing for retry',
              );
              enqueueOutbox(chatJid, cleanText);
            }
            await sendImages(channel, chatJid, images);
            outputSentToUser = true;
            queue.markResponseSent(chatJid);
            lastSentText = cleanText;
          } else if (cleanText && cleanText === lastSentText) {
            logger.warn({ group: group.name }, 'Duplicate output suppressed');
          }

          // Non-streaming, image-only response — send images even without cleanText
          if (streamMessageId === null && !cleanText && images.length > 0) {
            await sendImages(channel, chatJid, images);
            outputSentToUser = true;
            queue.markResponseSent(chatJid);
            lastSentText = cleanText;
          }
          // Reset streaming state for next IPC query — the onOutput callback
          // persists across multiple queries within the same agent process.
          streamLoop.resetForNextQuery();
          streamMessageId = null;
          streamingFailed = false;
          lastSentText = null;
          // Only reset idle timer on actual results, not session-update markers (result: null)
          resetIdleTimer();
        }

        // Stop typing indicator for any non-partial result — covers empty text,
        // duplicate suppression, and null-result (session update marker) paths.
        if (!result.partial) {
          typingActive = false;
        }

        if (result.status === 'success' && !result.partial) {
          if (deferredCompact.has(chatJid)) {
            // Deferred compact: send /compact via IPC now that container is idle
            deferredCompact.delete(chatJid);
            const compactSent = queue.sendMessage(chatJid, '/compact');
            if (compactSent) {
              compactPending.add(chatJid);
              compactInFlight = true;
              // Safety timeout: clear in-flight flag if compact doesn't complete
              compactSafetyTimer = setTimeout(() => {
                if (compactInFlight) {
                  compactInFlight = false;
                  queue.notifyIdle(chatJid);
                }
              }, 60000);
            } else {
              queue.notifyIdle(chatJid);
            }
          } else if (compactInFlight) {
            // Don't call notifyIdle while compact is being processed —
            // prevents container closure by pending tasks
            if (result.compacted) {
              compactInFlight = false;
              if (compactSafetyTimer) {
                clearTimeout(compactSafetyTimer);
                compactSafetyTimer = null;
              }
              queue.notifyIdle(chatJid);
            }
          } else {
            queue.notifyIdle(chatJid);
          }
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
    );
  } finally {
    streamLoop.stop();
    clearInterval(typingKeepalive);
    await channel.setTyping?.(chatJid, false).catch(() => {});
    if (idleTimer) clearTimeout(idleTimer);
    if (compactSafetyTimer) clearTimeout(compactSafetyTimer);
  }

  if (output === 'error' || hadError) {
    deferredCompact.delete(chatJid);
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
    state.lastAgentTimestamp[chatJid] = previousCursor;
    saveStateHere();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

// getEffectiveModel lives in ./orchestrator/effective-model.ts
export {
  getEffectiveModel,
  type EffectiveModelResult,
} from './orchestrator/effective-model.js';

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  effectiveModel: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  // Allow session saves for this new agent run (previous clear is consumed)
  sessionGuard.startRun(group.folder);
  const sessionId = state.sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      name: t.name,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      context_mode: t.context_mode,
      silent: t.silent,
      model: t.model,
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
    new Set(Object.keys(state.registeredGroups)),
  );

  // Wrap onOutput to track session ID and usage from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId && !sessionGuard.isCleared(group.folder)) {
          state.sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);

          if (compactPending.has(chatJid)) {
            compactPending.delete(chatJid);
            const ch = findChannel(channels, chatJid);
            if (ch) {
              ch.sendMessage(chatJid, 'Compact completed.').catch(() => {});
            }
          }
        }
        if (output.usage) {
          state.lastUsage[group.folder] = {
            ...output.usage,
            contextWindow:
              output.contextWindow ?? state.lastUsage[group.folder]?.contextWindow,
          };
        }
        if (output.compacted) {
          state.compactCount[group.folder] = (state.compactCount[group.folder] || 0) + 1;
        }
        if (output.rateLimit) {
          state.lastRateLimit[group.folder] = output.rateLimit;
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const runAgent_ = HOST_MODE ? runHostAgent : runContainerAgent;
    const output = await runAgent_(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        model: effectiveModel,
        effort: group.effort,
        thinking_budget: group.thinking_budget,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId && !sessionGuard.isCleared(group.folder)) {
      state.sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
    if (output.usage) {
      state.lastUsage[group.folder] = {
        ...output.usage,
        contextWindow:
          output.contextWindow ?? state.lastUsage[group.folder]?.contextWindow,
      };
    }
    if (output.compacted) {
      state.compactCount[group.folder] = (state.compactCount[group.folder] || 0) + 1;
    }
    if (output.rateLimit) {
      state.lastRateLimit[group.folder] = output.rateLimit;
    }

    if (output.status === 'error') {
      compactPending.delete(chatJid);
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
        delete state.sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (state.messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  state.messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(state.registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        state.lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        state.lastTimestamp = newTimestamp;
        saveStateHere();

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
          const group = state.registeredGroups[chatJid];
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

          // Pull all messages since state.lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursorHere(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          // Skip if cursor already covers these messages (event-driven
          // onMessage handler already piped them to the active container).
          if (allPending.length === 0) continue;
          const formatted = formatMessages(
            allPending,
            TIMEZONE,
            group,
            getEffectiveModel(group).model,
          );

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: allPending.length },
              'Piped messages to active container',
            );
            // Advance cursor so the next poll/event doesn't re-send these messages.
            // advanceCursorFn on container exit also advances as a safety net.
            state.lastAgentTimestamp[chatJid] =
              allPending[allPending.length - 1].timestamp;
            saveStateHere();

            // Show typing indicator while the container processes the piped message
            // Skip if agent sent a response recently — prevents typing reappearing on Telegram
            if (!queue.isRecentResponseSent(chatJid)) {
              channel
                .setTyping?.(chatJid, true)
                ?.catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'Failed to set typing indicator',
                  ),
                );
            }
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing state.lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(state.registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursorHere(chatJid),
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

/**
 * Startup recovery: retry sending messages that failed to deliver.
 * Messages are persisted to the outbox table when channel.sendMessage() fails.
 */
async function recoverOutbox(): Promise<void> {
  const pending = getOutboxMessages();
  if (pending.length === 0) return;
  logger.info(
    { count: pending.length },
    'Recovering unsent messages from outbox',
  );
  for (const msg of pending) {
    const channel = findChannel(channels, msg.chatJid);
    if (!channel) {
      logger.warn(
        { id: msg.id, chatJid: msg.chatJid },
        'Outbox: no channel for JID, skipping',
      );
      continue;
    }
    try {
      await channel.sendMessage(msg.chatJid, msg.text);
      deleteOutboxMessage(msg.id);
      logger.info(
        { id: msg.id, chatJid: msg.chatJid },
        'Outbox message delivered',
      );
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      incrementOutboxAttempts(msg.id);
      logger.error(
        { id: msg.id, chatJid: msg.chatJid, error: err },
        'Outbox recovery failed, will retry next restart',
      );
    }
  }
}

function ensureContainerSystemRunning(): void {
  if (HOST_MODE) {
    logger.info('Host mode enabled — skipping container runtime check');
    return;
  }
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadStateHere();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(state.registeredGroups)) {
    ensureOneCLIAgentFn(onecli, jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // Advance cursor for all groups before killing containers so piped
    // messages are not re-delivered on restart (Issue #10).
    for (const chatJid of Object.keys(state.registeredGroups)) {
      const pending = getMessagesSince(
        chatJid,
        getOrRecoverCursorHere(chatJid),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (pending.length > 0) {
        state.lastAgentTimestamp[chatJid] = pending[pending.length - 1].timestamp;
      }
    }
    saveStateHere();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    await stopWebhookServer();
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
    const group = state.registeredGroups[chatJid];
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
      if (!msg.is_from_me && !msg.is_bot_message && state.registeredGroups[chatJid]) {
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

      // Event-driven: kick message processing immediately without waiting for poll
      const group = state.registeredGroups[chatJid];
      if (!group) return;

      const ch = findChannel(channels, chatJid);
      if (!ch) return;

      const isMainGroup = group.isMain === true;
      const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

      if (needsTrigger) {
        const triggerPattern = getTriggerPattern(group.trigger);
        const allowlistCfg = loadSenderAllowlist();
        const hasTrigger =
          triggerPattern.test(msg.content.trim()) &&
          (msg.is_from_me ||
            isTriggerAllowed(chatJid, msg.sender, allowlistCfg));
        if (!hasTrigger) return;
      }

      // Active container → pipe via IPC + typing indicator
      const allPending = getMessagesSince(
        chatJid,
        getOrRecoverCursorHere(chatJid),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (allPending.length > 0) {
        const formatted = formatMessages(
          allPending,
          TIMEZONE,
          group,
          getEffectiveModel(group).model,
        );
        if (queue.sendMessage(chatJid, formatted)) {
          // Advance cursor so the next pipe doesn't re-send these messages
          state.lastAgentTimestamp[chatJid] =
            allPending[allPending.length - 1].timestamp;
          saveStateHere();
          if (!queue.isRecentResponseSent(chatJid)) {
            ch.setTyping?.(chatJid, true)?.catch(() => {});
          }
          return;
        }
      }

      // No active container → enqueue for a new one
      queue.enqueueMessageCheck(chatJid);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => state.registeredGroups,
    getStatus: () => ({
      activeContainers: queue.getStatus().activeContainers,
      uptimeSeconds: Math.floor(process.uptime()),
      sessions: { ...state.sessions },
      lastUsage: { ...state.lastUsage },
      compactCount: { ...state.compactCount },
      lastRateLimit: { ...state.lastRateLimit },
    }),
    sendIpcMessage: (chatJid: string, text: string) => {
      const sent = queue.sendMessage(chatJid, text);
      if (sent && text === '/compact') {
        compactPending.add(chatJid);
      }
      if (!sent && text === '/compact') {
        // No active container — defer compact to next container run if session exists
        const group = state.registeredGroups[chatJid];
        if (group && state.sessions[group.folder]) {
          deferredCompact.add(chatJid);
          return true;
        }
      }
      return sent;
    },
    clearSession: (groupFolder: string, chatJid: string) => {
      delete state.sessions[groupFolder];
      deleteSession(groupFolder);
      sessionGuard.markCleared(groupFolder);
      queue.closeStdin(chatJid);
    },
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
    registeredGroups: () => state.registeredGroups,
    getSessions: () => state.sessions,
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
      if (!text) return;
      const { cleanText, images } = extractImages(text);
      if (cleanText) await channel.sendMessage(jid, cleanText);
      await sendImages(channel, jid, images);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const { cleanText, images } = extractImages(text);
      if (cleanText) await channel.sendMessage(jid, cleanText);
      await sendImages(channel, jid, images);
    },
    registeredGroups: () => state.registeredGroups,
    registerGroup: registerGroupHere,
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
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        name: t.name,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        context_mode: t.context_mode,
        silent: t.silent,
        model: t.model,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(state.registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  queue.advanceCursorFn = (chatJid) => {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursorHere(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      state.lastAgentTimestamp[chatJid] = pending[pending.length - 1].timestamp;
      saveStateHere();
    }
  };
  queue.onMaxRetriesExceeded = (groupJid) => {
    const ch = findChannel(channels, groupJid);
    if (ch) {
      ch.sendMessage(
        groupJid,
        'Sorry, I was unable to process your message after several attempts. Please try again.',
      ).catch(() => {});
    }
  };
  await recoverOutbox();
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  // Incoming webhook: external systems can trigger the agent via HTTP POST
  if (WEBHOOK_ENABLED) {
    startWebhookServer(WEBHOOK_PORT, {
      getMainGroupJid: () =>
        Object.keys(state.registeredGroups).find(
          (jid) => state.registeredGroups[jid].isMain === true,
        ),
      onWebhookMessage: (chatJid: string, text: string) => {
        const msg: NewMessage = {
          id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: chatJid,
          sender: 'webhook',
          sender_name: 'Webhook',
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
        };
        storeMessage(msg);

        // Event-driven: pipe to active container or enqueue for a new one
        const allPending = getMessagesSince(
          chatJid,
          getOrRecoverCursorHere(chatJid),
          ASSISTANT_NAME,
          MAX_MESSAGES_PER_PROMPT,
        );
        if (allPending.length > 0) {
          const grp = state.registeredGroups[chatJid];
          const formatted = formatMessages(
            allPending,
            TIMEZONE,
            grp,
            grp ? getEffectiveModel(grp).model : undefined,
          );
          if (queue.sendMessage(chatJid, formatted)) {
            state.lastAgentTimestamp[chatJid] =
              allPending[allPending.length - 1].timestamp;
            saveStateHere();
            return;
          }
        }
        queue.enqueueMessageCheck(chatJid);
      },
    }).catch((err) => {
      logger.warn(
        { err },
        'Webhook server failed to start, continuing without it',
      );
    });
  }
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
