import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_MODEL,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  HOST_MODE,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
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
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getOutboxMessages,
  getRouterState,
  incrementOutboxAttempts,
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
import {
  extractImages,
  findChannel,
  formatMessages,
  formatOutbound,
  sendImages,
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
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const lastUsage: Record<
  string,
  { inputTokens: number; outputTokens: number; numTurns: number }
> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();
const compactPending = new Set<string>(); // chatJids with pending compact

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
    // eslint-disable-next-line no-catch-all/no-catch-all
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
    // eslint-disable-next-line no-catch-all/no-catch-all
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

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
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
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  // Keep typing indicator alive (Telegram clears it after ~5s)
  const typingKeepalive = setInterval(() => {
    channel.setTyping?.(chatJid, true).catch(() => {});
  }, 2000);

  let hadError = false;
  let outputSentToUser = false;
  let lastSentText: string | null = null;
  let streamMessageId: number | null = null;
  let lastEditTime = 0;
  let streamingFailed = false;
  const EDIT_THROTTLE_MS = 1500;

  let output: 'success' | 'error';
  try {
    output = await runAgent(group, prompt, chatJid, async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

        if (result.partial) {
          // --- Streaming partial chunk ---
          if (!text || streamingFailed || !channel.sendStreamMessage) {
            resetIdleTimer();
            return;
          }

          if (streamMessageId === null) {
            // First partial: send initial streaming message
            const msgId = await channel.sendStreamMessage(chatJid, text);
            if (!msgId || typeof msgId !== 'number') {
              streamingFailed = true;
              resetIdleTimer();
              return;
            }
            streamMessageId = msgId;
            lastEditTime = Date.now();
            lastSentText = text;
            // Telegram clears typing indicator on sendMessage — re-enable it
            await channel.setTyping?.(chatJid, true).catch(() => {});
          } else {
            // Subsequent partial: throttle + edit
            const now = Date.now();
            if (now - lastEditTime < EDIT_THROTTLE_MS) return;
            if (text === lastSentText) return;
            if (text.length > 4000) {
              // Too long for streaming edits — let final sendMessage handle it
              streamingFailed = true;
              resetIdleTimer();
              return;
            }
            try {
              await channel.editMessage!(chatJid, streamMessageId, text);
              lastEditTime = now;
              lastSentText = text;
              // eslint-disable-next-line no-catch-all/no-catch-all
            } catch (err) {
              logger.warn(
                { group: group.name, error: err },
                'Stream edit failed, falling back to final send',
              );
              streamingFailed = true;
            }
          }
          resetIdleTimer();
          return;
        }

        // --- Final result ---
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);

        const { cleanText, images } = extractImages(text);

        if (streamMessageId !== null) {
          // Streaming was active — accumulated text already displayed.
          clearInterval(typingKeepalive);
          if (cleanText && cleanText !== lastSentText) {
            try {
              if (!streamingFailed && cleanText.length <= 4096) {
                await channel.editMessage!(chatJid, streamMessageId, cleanText);
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
          }
          await sendImages(channel, chatJid, images);
          outputSentToUser = true;
          queue.markResponseSent(chatJid);
          lastSentText = cleanText;
        } else if (cleanText && cleanText !== lastSentText) {
          // No streaming — use normal send
          clearInterval(typingKeepalive);
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
        // Reset streaming state for next IPC query — the onOutput callback
        // persists across multiple queries within the same agent process.
        streamMessageId = null;
        lastEditTime = 0;
        streamingFailed = false;
        lastSentText = null;
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success' && !result.partial) {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });
  } finally {
    clearInterval(typingKeepalive);
    await channel.setTyping?.(chatJid, false).catch(() => {});
    if (idleTimer) clearTimeout(idleTimer);
  }

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
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
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
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
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
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID and usage from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
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
          lastUsage[group.folder] = output.usage;
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
        model: group.model || DEFAULT_MODEL,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
    if (output.usage) {
      lastUsage[group.folder] = output.usage;
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
        delete sessions[group.folder];
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
          // Skip if cursor already covers these messages (event-driven
          // onMessage handler already piped them to the active container).
          if (allPending.length === 0) continue;
          const formatted = formatMessages(allPending, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: allPending.length },
              'Piped messages to active container',
            );
            // Advance cursor so the next poll/event doesn't re-send these messages.
            // advanceCursorFn on container exit also advances as a safety net.
            lastAgentTimestamp[chatJid] =
              allPending[allPending.length - 1].timestamp;
            saveState();

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
    // Advance cursor for all groups before killing containers so piped
    // messages are not re-delivered on restart (Issue #10).
    for (const chatJid of Object.keys(registeredGroups)) {
      const pending = getMessagesSince(
        chatJid,
        getOrRecoverCursor(chatJid),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (pending.length > 0) {
        lastAgentTimestamp[chatJid] = pending[pending.length - 1].timestamp;
      }
    }
    saveState();
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

      // Event-driven: kick message processing immediately without waiting for poll
      const group = registeredGroups[chatJid];
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
        getOrRecoverCursor(chatJid),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (allPending.length > 0) {
        const formatted = formatMessages(allPending, TIMEZONE);
        if (queue.sendMessage(chatJid, formatted)) {
          // Advance cursor so the next pipe doesn't re-send these messages
          lastAgentTimestamp[chatJid] =
            allPending[allPending.length - 1].timestamp;
          saveState();
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
    registeredGroups: () => registeredGroups,
    getStatus: () => ({
      activeContainers: queue.getStatus().activeContainers,
      uptimeSeconds: Math.floor(process.uptime()),
      sessions: { ...sessions },
      lastUsage: { ...lastUsage },
    }),
    sendIpcMessage: (chatJid: string, text: string) => {
      const sent = queue.sendMessage(chatJid, text);
      if (sent && text === '/compact') {
        compactPending.add(chatJid);
      }
      return sent;
    },
    clearSession: (groupFolder: string) => {
      delete sessions[groupFolder];
      deleteSession(groupFolder);
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
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        silent: t.silent,
        model: t.model,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  queue.advanceCursorFn = (chatJid) => {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      lastAgentTimestamp[chatJid] = pending[pending.length - 1].timestamp;
      saveState();
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
