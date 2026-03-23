import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GOAL_TIMEOUT_DEFAULT,
  GOAL_TIMEOUT_MAX,
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
  getConversationContext,
  getNewMessages,
  getRegisteredGroup,
  getUnprocessedMessages,
  initDatabase,
  markMessagesProcessed,
  markMessagesUnprocessed,
  setRegisteredGroup,
  deleteSession,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  createThreadContext,
  getThreadContextById,
  getThreadContextByThreadId,
  updateThreadContext,
  ThreadContext,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { sendDebugQuery } from './debug-query.js';
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
import './features/index.js';

import { migrateSessionDirs } from './migrate-sessions.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let messageLoopRunning = false;

// In-memory map: message key → image attachments (populated by onMessage, consumed by processGroupMessages)
const messageImages = new Map<
  string,
  { data: string; mediaType: string; name?: string }[]
>();

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
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
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(
  chatJid: string,
  threadId?: string,
): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const priority = queue.getThreadPriority(chatJid, threadId || 'default');
  const goalTimeoutMs = queue.getGoalTimeoutMs(chatJid, threadId || 'default');

  const isMainGroup = group.isMain === true;

  const missedMessages = getUnprocessedMessages(chatJid, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // Collect images from in-memory cache (they're not stored in DB)
  const allImages: { data: string; mediaType: string; name?: string }[] = [];
  for (const m of missedMessages) {
    const key = `${m.id}:${m.chat_jid}`;
    const imgs = messageImages.get(key);
    if (imgs) {
      allImages.push(...imgs);
      messageImages.delete(key);
    }
  }

  // Build message refs for marking processed/unprocessed
  const messageRefs = missedMessages.map((m) => ({
    id: m.id,
    chat_jid: m.chat_jid,
  }));

  // For non-main groups, check if trigger is required and present.
  // Thread messages (ctx-* threadId) skip this — they're already in a bot thread.
  const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
  const isThreadContext = threadId !== undefined && threadId.startsWith('ctx-');
  if (needsTrigger && !isThreadContext) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      // No trigger found — mark all as processed to prevent hot loop
      markMessagesProcessed(messageRefs);
      return true;
    }
  }

  // Look up thread context if threadId is provided
  let threadContext: ThreadContext | undefined;
  if (threadId) {
    // threadId is now ctx-{id} format from the message loop
    if (threadId.startsWith('ctx-')) {
      const ctxId = parseInt(threadId.replace('ctx-', ''), 10);
      threadContext = getThreadContextById(ctxId);
    } else if (threadId !== 'default') {
      threadContext = getThreadContextByThreadId(threadId);
    }
  }

  // Convert to stable ctx-{id} for filesystem paths and container identity
  const containerThreadId = threadContext
    ? `ctx-${threadContext.id}`
    : threadId;

  // Use thread-specific session if available.
  // For new thread contexts (no session yet), start fresh — don't fall back
  // to the group session, which belongs to a different conversation.
  let sessionId = threadContext
    ? threadContext.session_id || undefined
    : sessions[group.folder];

  // Verify the session's .jsonl file actually exists on disk before trying
  // to resume. If the file is missing (container killed, dir not migrated),
  // the SDK will fail with "No conversation found". Start fresh instead.
  if (sessionId) {
    const sessionDir = containerThreadId
      ? path.join(
          DATA_DIR,
          'sessions',
          group.folder,
          containerThreadId,
          '.claude',
          'projects',
          '-workspace-group',
        )
      : path.join(
          DATA_DIR,
          'sessions',
          group.folder,
          '.claude',
          'projects',
          '-workspace-group',
        );
    const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(sessionFile)) {
      logger.debug(
        { sessionId, sessionFile },
        'Session file missing on disk, starting fresh',
      );
      sessionId = undefined;
    }
  }

  // Include recent conversation history (with bot messages) so the agent
  // has context even when session resume fails or a new container is spawned.
  const conversationHistory = getConversationContext(chatJid);
  const newMessageIds = new Set(missedMessages.map((m) => m.id));
  const contextMessages = conversationHistory.filter(
    (m) => !newMessageIds.has(m.id),
  );

  const prompt = formatMessages(
    missedMessages,
    TIMEZONE,
    channel,
    contextMessages.length > 0 ? contextMessages : undefined,
  );

  // Mark messages as processed BEFORE running the container to prevent
  // a concurrent container from picking up the same messages.
  markMessagesProcessed(messageRefs);

  logger.info(
    { group: group.name, messageCount: missedMessages.length, threadId },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (priority === 'goal') return; // Goals don't idle out
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid, containerThreadId);
    }, IDLE_TIMEOUT);
  };

  // Set thread context on channel before streaming
  if (threadContext && containerThreadId) {
    channel.setCurrentThreadContext?.(
      chatJid,
      containerThreadId,
      threadContext,
    );
  }

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const threadSessionId = threadContext?.session_id || undefined;
  const output = await runAgent({
    group,
    prompt,
    chatJid,
    onOutput: async (result) => {
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
          await channel.sendMessage(chatJid, text, threadContext?.id);
          outputSentToUser = true;
          // Store bot response so future containers have conversation context
          storeMessageDirect({
            id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            chat_jid: chatJid,
            sender: ASSISTANT_NAME,
            sender_name: ASSISTANT_NAME,
            content: text,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
          });
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid, containerThreadId);
      }

      if (result.status === 'error') {
        hadError = true;
      }

      // Update thread context with new session ID if available
      if (result.newSessionId && threadContext) {
        updateThreadContext(threadContext.id, {
          sessionId: result.newSessionId,
        });
      }
    },
    threadId: containerThreadId,
    sessionOverride: threadSessionId,
    images: allImages.length > 0 ? allImages : undefined,
    priority,
    goalTimeoutMs,
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Don't eagerly clear send target — let it persist so messages arriving
  // between container completion and next container start still route to
  // the correct thread. The next processGroupMessages call will overwrite it.

  if (output === 'error' || hadError) {
    // If we already sent output to the user, keep messages marked processed —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, keeping messages processed to prevent duplicates',
      );
      return true;
    }
    // Roll back processed flag so retries can re-process these messages
    markMessagesUnprocessed(messageRefs);
    logger.warn(
      { group: group.name },
      'Agent error, marked messages unprocessed for retry',
    );
    return false;
  }

  return true;
}

interface RunAgentOpts {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  onOutput?: (output: ContainerOutput) => Promise<void>;
  retried?: boolean;
  threadId?: string;
  sessionOverride?: string;
  images?: { data: string; mediaType: string; name?: string }[];
  priority?: 'interactive' | 'goal' | 'scheduled';
  goalTimeoutMs?: number;
}

async function runAgent(opts: RunAgentOpts): Promise<'success' | 'error'> {
  const {
    group,
    prompt,
    chatJid,
    onOutput,
    retried = false,
    threadId,
    sessionOverride,
    images,
    priority,
    goalTimeoutMs,
  } = opts;
  const isMain = group.isMain === true;
  const sessionId =
    sessionOverride !== undefined ? sessionOverride : sessions[group.folder];

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
          if (!sessionOverride) {
            sessions[group.folder] = output.newSessionId;
            setSession(group.folder, output.newSessionId);
          }
          // Thread context session update happens in processGroupMessages via onOutput callback
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        images: images?.length ? images : undefined,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        threadId,
        priority,
        goalTimeoutMs,
      },
      (proc, containerName) =>
        queue.registerProcess(
          chatJid,
          proc,
          containerName,
          group.folder,
          threadId,
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId && !sessionOverride) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // If session expired/invalid, clear it and retry with a fresh session
      if (
        sessionId &&
        output.error?.includes('No conversation found with session ID')
      ) {
        logger.warn(
          { group: group.name },
          'Session expired, clearing and retrying with fresh session',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
        // Also clear thread-level session so retry uses a fresh one
        if (threadId) {
          const ctx = getThreadContextByThreadId(threadId);
          if (ctx) {
            updateThreadContext(ctx.id, { sessionId: null });
          }
        }
        if (retried) {
          logger.error(
            { group: group.name },
            'Session expired again after retry, giving up',
          );
          return 'error';
        }
        return runAgent({
          ...opts,
          retried: true,
          sessionOverride: undefined,
        });
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
      const { messages } = getNewMessages(jids, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Group by (chatJid, threadContextId) — each thread-group is independent
        const threadGroups = new Map<
          string,
          {
            chatJid: string;
            threadCtxId: number | undefined;
            messages: NewMessage[];
          }
        >();
        for (const msg of messages) {
          const threadKey = msg.thread_context_id
            ? `${msg.chat_jid}:ctx-${msg.thread_context_id}`
            : `${msg.chat_jid}:default`;
          const existing = threadGroups.get(threadKey);
          if (existing) {
            existing.messages.push(msg);
          } else {
            threadGroups.set(threadKey, {
              chatJid: msg.chat_jid,
              threadCtxId: msg.thread_context_id ?? undefined,
              messages: [msg],
            });
          }
        }

        for (const [
          _key,
          { chatJid, threadCtxId, messages: groupMessages },
        ] of threadGroups) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const threadId = threadCtxId ? `ctx-${threadCtxId}` : 'default';

          // Trigger check: thread messages skip (already have context),
          // non-thread messages need trigger unless main group or container active
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
          if (needsTrigger && !threadCtxId) {
            if (!queue.isActive(chatJid, threadId)) {
              const allowlistCfg = loadSenderAllowlist();
              const hasTrigger = groupMessages.some(
                (m) =>
                  TRIGGER_PATTERN.test(m.content.trim()) &&
                  (m.is_from_me ||
                    isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
              );
              if (!hasTrigger) {
                markMessagesProcessed(
                  groupMessages.map((m) => ({
                    id: m.id,
                    chat_jid: m.chat_jid,
                  })),
                );
                continue;
              }
            }
          }

          // Detect /goal prefix
          let priority: 'interactive' | 'goal' | 'scheduled' = 'interactive';
          let goalTimeoutMs: number | undefined;
          for (const msg of groupMessages) {
            const goalMatch = msg.content
              .trim()
              .match(/^\/goal(?:\s+(\d+)([hm]))?\s*/i);
            if (goalMatch) {
              priority = 'goal';
              if (goalMatch[1] && goalMatch[2]) {
                const value = parseInt(goalMatch[1], 10);
                const unit = goalMatch[2].toLowerCase();
                goalTimeoutMs = Math.min(
                  unit === 'h' ? value * 3600000 : value * 60000,
                  GOAL_TIMEOUT_MAX,
                );
              } else {
                goalTimeoutMs = GOAL_TIMEOUT_DEFAULT;
              }
              msg.content = msg.content.replace(
                /^\/goal(?:\s+\d+[hm])?\s*/i,
                '',
              );
              break;
            }
          }

          // Try IPC to active container for this specific thread
          const allPending = getUnprocessedMessages(chatJid, ASSISTANT_NAME);
          // Filter to this thread's messages only
          const threadPending = threadCtxId
            ? allPending.filter((m) => m.thread_context_id === threadCtxId)
            : allPending.filter((m) => !m.thread_context_id);
          const messagesToSend =
            threadPending.length > 0 ? threadPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE, channel);
          const pipedMessageRefs = messagesToSend.map((m) => ({
            id: m.id,
            chat_jid: m.chat_jid,
          }));

          if (queue.sendMessage(chatJid, threadId, formatted)) {
            logger.debug(
              { chatJid, threadId, count: messagesToSend.length },
              'Piped messages to active container',
            );
            markMessagesProcessed(pipedMessageRefs);
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            logger.info(
              { chatJid, threadId },
              'No active container, enqueuing for new container',
            );
            queue.enqueueThreadMessageCheck(
              chatJid,
              threadId,
              priority,
              goalTimeoutMs,
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

function acquirePidLock(): void {
  const pidFile = path.join(DATA_DIR, 'nanoclaw.pid');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Check if an existing process is still running
  if (fs.existsSync(pidFile)) {
    const oldPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // Check if process exists
        // Old process is still alive — kill it
        logger.warn(
          { oldPid },
          'Killing previous NanoClaw process to prevent double responses',
        );
        try {
          process.kill(oldPid, 'SIGTERM');
        } catch {
          // Already gone
        }
      } catch {
        // Process doesn't exist, stale pidfile
      }
    }
  }

  fs.writeFileSync(pidFile, String(process.pid));

  // Clean up pidfile on exit
  const removePid = () => {
    try {
      const current = fs.readFileSync(pidFile, 'utf-8').trim();
      if (current === String(process.pid)) fs.unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', removePid);
}

async function main(): Promise<void> {
  acquirePidLock();
  logger.info(
    {
      logFile: path.join(process.cwd(), 'logs', 'nanoclaw.log'),
      errorLogFile: path.join(process.cwd(), 'logs', 'nanoclaw.error.log'),
      containerLogsDir: 'groups/{folder}/logs/',
      ipcAuditDir: 'data/ipc/{folder}/audit/',
    },
    'NanoClaw starting — log locations',
  );
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  migrateSessionDirs();
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
  const handleSignal = (signal: string) => {
    shutdown(signal).catch((err) => {
      logger.error({ err }, 'Shutdown error');
      process.exit(1);
    });
    // Hard kill if graceful shutdown hangs
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

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
      if (msg.images?.length) {
        messageImages.set(`${msg.id}:${msg.chat_jid}`, msg.images);
      }
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
    onProcess: (groupJid, proc, containerName, groupFolder, threadId) =>
      queue.registerProcess(
        groupJid,
        proc,
        containerName,
        groupFolder,
        threadId,
      ),
    sendMessage: async (jid, rawText, taskId?, sessionId?) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) {
        let messageId: string | undefined;
        if (channel.sendChannelMessage) {
          messageId = await channel.sendChannelMessage(jid, text);
        } else {
          await channel.sendMessage(jid, text);
        }
        if (messageId && taskId) {
          createThreadContext({
            chatJid: jid,
            threadId: null,
            sessionId: sessionId || null,
            originMessageId: messageId,
            source: 'scheduled_task',
            taskId: parseInt(taskId, 10),
          });
        }
      }
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendChannelMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendChannelMessage) {
        return channel.sendChannelMessage(jid, text);
      } else {
        await channel.sendMessage(jid, text);
        return undefined;
      }
    },
    sendFile: (jid, files, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile)
        throw new Error(
          `Channel ${channel.name} does not support file sending`,
        );
      return channel.sendFile(jid, files, caption);
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
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    setThreadContext: (jid: string, threadId: string) => {
      const channel = findChannel(channels, jid);
      if (channel) {
        const ctx = getThreadContextByThreadId(threadId);
        if (ctx) {
          channel.setCurrentThreadContext?.(jid, threadId, ctx);
        }
      }
    },
    onDebugQuery: (sourceGroup, queryId, question) => {
      sendDebugQuery(
        sourceGroup,
        question,
        queue,
        registeredGroups,
        queryId,
      ).catch((err) =>
        logger.error({ err, sourceGroup, queryId }, 'Debug query failed'),
      );
    },
    onEscalateToGoal: (groupFolder, threadId) => {
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (group.folder === groupFolder) {
          queue.escalateToGoal(jid, threadId);
          break;
        }
      }
    },
    onContainerPaused: (groupFolder, threadId) => {
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (group.folder === groupFolder) {
          queue.handlePausedNotification(jid, threadId);
          break;
        }
      }
    },
    onContainerResumed: (_groupFolder, _threadId) => {
      // No-op on host side — container handles its own resume
    },
  });
  queue.setProcessMessagesFn(async (groupJid: string, threadId?: string) => {
    return processGroupMessages(groupJid, threadId);
  });
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
