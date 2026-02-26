import fs from 'fs';
import path from 'path';

import { syncBrain } from './brain-sync.js';
import {
  ASSISTANT_NAME,
  CONTAINER_NAME_PREFIX,
  IDLE_TIMEOUT,
  INSTANCE_ID,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  STORE_DIR,
  TRIGGER_PATTERN,
} from './config.js';
import { GitHubChannel } from './channels/github.js';
import { SlackChannel } from './channels/slack.js';
import { WebChannel } from './channels/web.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning, probeRootlessDocker } from './container-runtime.js';
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
import { readEnvFile } from './env.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
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

let whatsapp: WhatsAppChannel | null = null;
const channels: Channel[] = [];
const queue = new GroupQueue();

// Track Slack threads where the bot has replied (trigger bypass)
const botRepliedThreads = new Set<string>();

// Track active runs for shutdown rollback
interface ActiveRunState {
  chatJid: string;
  threadTs?: string;
  previousCursor: string;
  outputSentToUser: boolean;
}
const activeRunState = new Map<string, ActiveRunState>();

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
 * Cursor key for per-thread tracking.
 * Plain chatJid for top-level, chatJid#threadTs for threads.
 */
function cursorKey(chatJid: string, threadTs?: string): string {
  return threadTs ? `${chatJid}#${threadTs}` : chatJid;
}

/**
 * Process all pending messages for a group (thread-aware).
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string, threadTs?: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  // Thread-as-group isolation: derive a thread-specific group when threadTs is present
  let effectiveGroup = group;
  if (threadTs) {
    const sanitizedTs = threadTs.replace(/\./g, '-');
    const threadFolder = `${group.folder}-t-${sanitizedTs}`;
    const threadGroupDir = resolveGroupFolderPath(threadFolder);

    if (!fs.existsSync(threadGroupDir)) {
      fs.mkdirSync(path.join(threadGroupDir, 'logs'), { recursive: true });
      fs.writeFileSync(
        path.join(threadGroupDir, 'CLAUDE.md'),
        `# Thread workspace\n\nBase group context is loaded automatically from the channel group.\n`,
      );
    }

    effectiveGroup = { ...group, folder: threadFolder, name: `${group.name} (thread)` };
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const isBotThread = threadTs != null && botRepliedThreads.has(threadTs);
  const cKey = cursorKey(chatJid, threadTs);

  // Check for WIP recovery file from a previous interrupted run
  const groupDir = resolveGroupFolderPath(effectiveGroup.folder);
  const wipPath = path.join(groupDir, 'wip.md');
  let wipContent = '';
  if (fs.existsSync(wipPath)) {
    try {
      wipContent = fs.readFileSync(wipPath, 'utf-8');
      fs.unlinkSync(wipPath);
      logger.info({ group: group.name }, 'Recovered WIP context from previous run');
    } catch {
      // ignore
    }
  }

  const sinceTimestamp = lastAgentTimestamp[cKey] || '';
  // Pass null (not undefined) when no threadTs to filter to top-level messages only.
  // undefined means "no filter" which would include thread messages in top-level processing.
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME, threadTs ?? null);

  if (missedMessages.length === 0 && !wipContent) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false && !isBotThread) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger && !wipContent) return true;
  }

  // Multi-trigger splitting: find the first trigger, process up to there,
  // and re-enqueue the rest. This prevents batching multiple @mentions.
  let messagesToProcess = missedMessages;
  let hasRemainder = false;

  if (!isMainGroup && group.requiresTrigger !== false && !isBotThread && missedMessages.length > 1) {
    const firstTriggerIdx = missedMessages.findIndex((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (firstTriggerIdx >= 0) {
      // Find the next trigger after the first one
      const nextTriggerIdx = missedMessages.findIndex((m, i) =>
        i > firstTriggerIdx && TRIGGER_PATTERN.test(m.content.trim()),
      );
      if (nextTriggerIdx >= 0) {
        // Process up to (but not including) the next trigger
        messagesToProcess = missedMessages.slice(0, nextTriggerIdx);
        hasRemainder = true;
      }
    }
  }

  const prompt = wipContent
    ? `[CONTEXT FROM INTERRUPTED RUN]\n${wipContent}\n\n[NEW MESSAGES]\n${formatMessages(messagesToProcess)}`
    : formatMessages(messagesToProcess);

  // Determine reply thread for thread-aware channels
  const replyThreadTs = threadTs ?? messagesToProcess[0]?.thread_ts;

  // Advance cursor
  const previousCursor = lastAgentTimestamp[cKey] || '';
  if (messagesToProcess.length > 0) {
    lastAgentTimestamp[cKey] =
      messagesToProcess[messagesToProcess.length - 1].timestamp;
    saveState();
  }

  // Track run state for shutdown rollback
  const runKey = cKey;
  activeRunState.set(runKey, {
    chatJid,
    threadTs,
    previousCursor,
    outputSentToUser: false,
  });

  logger.info(
    { group: group.name, messageCount: messagesToProcess.length, threadTs },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid, threadTs);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;

  const output = await runAgent(effectiveGroup, prompt, chatJid, threadTs, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        const sentTs = await channel.sendMessage(chatJid, text, replyThreadTs ? { thread_ts: replyThreadTs } : undefined);
        if (replyThreadTs) botRepliedThreads.add(replyThreadTs);
        if (typeof sentTs === 'string') botRepliedThreads.add(sentTs);
        const rs = activeRunState.get(runKey);
        if (rs) rs.outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid, threadTs);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  const rs = activeRunState.get(runKey);
  const outputSentToUser = rs?.outputSentToUser ?? false;
  activeRunState.delete(runKey);

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[cKey] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  // Re-enqueue if there are remaining triggers to process
  if (hasRemainder) {
    queue.enqueueMessageCheck(chatJid, threadTs);
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  threadTs?: string,
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
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder, threadTs),
      wrappedOnOutput,
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

        // Deduplicate by group+thread
        const messagesByKey = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const key = GroupQueue.queueKey(msg.chat_jid, msg.thread_ts);
          const existing = messagesByKey.get(key);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByKey.set(key, [msg]);
          }
        }

        for (const [key, groupMessages] of messagesByKey) {
          const chatJid = GroupQueue.chatJidFromKey(key);
          const threadTs = GroupQueue.threadTsFromKey(key);
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const isBotThread = threadTs != null && botRepliedThreads.has(threadTs);
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false && !isBotThread;

          // For non-main groups, only act on trigger messages.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const cKey = cursorKey(chatJid, threadTs);
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[cKey] || '',
            ASSISTANT_NAME,
            threadTs ?? null,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted, threadTs)) {
            logger.debug(
              { chatJid, threadTs, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[cKey] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel.setTyping?.(chatJid, true)?.catch((err) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid, threadTs);
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
 * Startup recovery: check for unprocessed messages and WIP files.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Check for WIP file from interrupted run (base group)
    try {
      const groupDir = resolveGroupFolderPath(group.folder);
      const wipPath = path.join(groupDir, 'wip.md');
      if (fs.existsSync(wipPath)) {
        logger.info({ group: group.name }, 'Recovery: found WIP file from interrupted run');
        queue.enqueueMessageCheck(chatJid);
      }
    } catch {
      // ignore
    }

    // Check for WIP files in thread folders ({group.folder}-t-*)
    try {
      const groupDir = resolveGroupFolderPath(group.folder);
      const parentDir = path.dirname(groupDir);
      const threadPrefix = `${group.folder}-t-`;
      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(threadPrefix)) {
          const threadWip = path.join(parentDir, entry.name, 'wip.md');
          if (fs.existsSync(threadWip)) {
            // Extract threadTs from folder name: {folder}-t-{sanitizedTs}
            const sanitizedTs = entry.name.slice(threadPrefix.length);
            const threadTs = sanitizedTs.replace(/-/g, '.');
            logger.info({ group: group.name, threadTs }, 'Recovery: found thread WIP file');
            queue.enqueueMessageCheck(chatJid, threadTs);
          }
        }
      }
    } catch {
      // ignore
    }

    // Check for unprocessed messages, grouped by thread
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      const threadKeys = new Set<string | undefined>();
      for (const msg of pending) {
        threadKeys.add(msg.thread_ts ?? undefined);
      }

      for (const threadTs of threadKeys) {
        logger.info(
          { group: group.name, threadTs, pendingCount: pending.filter((m) => (m.thread_ts ?? undefined) === threadTs).length },
          'Recovery: found unprocessed messages',
        );
        queue.enqueueMessageCheck(chatJid, threadTs);
      }
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  probeRootlessDocker();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  logger.info({ instanceId: INSTANCE_ID, containerPrefix: CONTAINER_NAME_PREFIX }, 'Instance identity');
  initDatabase();
  logger.info('Database initialized');
  loadState();
  syncBrain();

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Roll back cursors for no-output runs, write WIP for partial runs
    for (const [, rs] of activeRunState) {
      if (!rs.outputSentToUser) {
        // No output sent — roll back cursor so messages are reprocessed
        const cKey = cursorKey(rs.chatJid, rs.threadTs);
        lastAgentTimestamp[cKey] = rs.previousCursor;
      } else {
        // Partial output — write WIP file so next run has context
        try {
          const group = registeredGroups[rs.chatJid];
          if (group) {
            const groupDir = resolveGroupFolderPath(group.folder);
            const wipPath = path.join(groupDir, 'wip.md');
            fs.writeFileSync(wipPath, `Interrupted run at ${new Date().toISOString()}. Agent was responding to messages.`);
          }
        } catch {
          // ignore
        }
      }
    }
    saveState();

    // Send "Restarting..." to active chats (skip GitHub — comments are permanent)
    const activeJids = queue.getActiveJids();
    const notifiedJids: string[] = [];
    for (const jid of activeJids) {
      if (jid.endsWith('@github')) continue; // Don't spam GitHub with restart notices
      const channel = findChannel(channels, jid);
      if (channel) {
        try {
          await channel.sendMessage(jid, 'Restarting...');
          notifiedJids.push(jid);
        } catch {
          // ignore
        }
      }
    }
    if (notifiedJids.length > 0) {
      setRouterState('restart_notified_jids', JSON.stringify(notifiedJids));
    }

    // Disconnect channels first to stop accepting new messages during shutdown
    for (const ch of channels) await ch.disconnect();
    await queue.shutdown(10000);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => {
      try {
        storeMessage(msg);
      } catch (err) {
        logger.warn({ err, chatJid: msg.chat_jid }, 'storeMessage failed, retrying once');
        try {
          storeMessage(msg);
        } catch (retryErr) {
          logger.error({ err: retryErr, chatJid: msg.chat_jid }, 'storeMessage retry failed, message lost');
        }
      }
    },
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Read env for optional channels
  const envTokens = readEnvFile([
    'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN',
    'GITHUB_TOKEN', 'GITHUB_USERNAME',
    'WEB_AUTH_TOKEN', 'WEB_API_PORT',
  ]);

  // WhatsApp: conditional on auth creds existing
  const authDir = path.join(STORE_DIR, 'auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  } else {
    logger.info('WhatsApp: no auth creds found, skipping');
  }

  // Slack: conditional on tokens in .env
  if (envTokens.SLACK_BOT_TOKEN && envTokens.SLACK_APP_TOKEN) {
    const slack = new SlackChannel({
      ...channelOpts,
      botToken: envTokens.SLACK_BOT_TOKEN,
      appToken: envTokens.SLACK_APP_TOKEN,
    });
    channels.push(slack);
    await slack.connect();
  } else {
    logger.info('Slack: no tokens in .env, skipping');
  }

  // GitHub: conditional on token + username in .env
  if (envTokens.GITHUB_TOKEN && envTokens.GITHUB_USERNAME) {
    const github = new GitHubChannel({
      ...channelOpts,
      token: envTokens.GITHUB_TOKEN,
      username: envTokens.GITHUB_USERNAME,
      registerGroup,
    });
    channels.push(github);
    await github.connect();
  } else {
    logger.info('GitHub: no token/username in .env, skipping');
  }

  // Web: conditional on auth token in .env
  if (envTokens.WEB_AUTH_TOKEN) {
    const web = new WebChannel({
      ...channelOpts,
      authToken: envTokens.WEB_AUTH_TOKEN,
      port: envTokens.WEB_API_PORT ? parseInt(envTokens.WEB_API_PORT, 10) : undefined,
      registerGroup,
      onDirectEnqueue: (jid) => queue.enqueueMessageCheck(jid),
    });
    channels.push(web);
    try {
      await web.connect();
    } catch (err) {
      logger.warn({ err }, 'Web channel failed to start, continuing without it');
    }
  } else {
    logger.info('Web: no WEB_AUTH_TOKEN in .env, skipping');
  }

  if (channels.length === 0) {
    logger.error('No channels configured. Run /setup to configure at least one channel.');
    process.exit(1);
  }

  // Send "back online" to chats that were notified of restart
  const notifiedRaw = getRouterState('restart_notified_jids');
  if (notifiedRaw) {
    try {
      const notifiedJids: string[] = JSON.parse(notifiedRaw);
      for (const jid of notifiedJids) {
        const channel = findChannel(channels, jid);
        if (channel) {
          channel.sendMessage(jid, 'Back online.').catch((err) =>
            logger.warn({ jid, err }, 'Failed to send back-online notification'),
          );
        }
      }
      setRouterState('restart_notified_jids', '[]');
    } catch {
      // ignore
    }
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
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
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      await channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Safety-net sweep: check for unprocessed messages every 30s
  // Catches race conditions where the polling loop missed a message
  setInterval(() => {
    for (const [chatJid, group] of Object.entries(registeredGroups)) {
      const cKey = cursorKey(chatJid);
      const pending = getMessagesSince(chatJid, lastAgentTimestamp[cKey] || '', ASSISTANT_NAME, null);
      if (pending.length > 0) {
        const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
        const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
        const hasTrigger = !needsTrigger || pending.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
        if (hasTrigger) {
          logger.info({ group: group.name, count: pending.length }, 'Sweep: found unprocessed messages');
          queue.enqueueMessageCheck(chatJid);
        }
      }
    }
  }, 30000);

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
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
