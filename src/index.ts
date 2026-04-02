import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { isError, isSyntaxError } from './error-utils.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { writeGroupsSnapshot, writeTasksSnapshot } from './container-runner.js';
import { PROXY_BIND_HOST } from './container-runtime.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  getAllChats,
  getAllGroupsForJid,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredAgentTypesForJid,
  getUndeliveredWorkItems,
  isGroupPaused,
  isPairedRoomJid,
  getRouterState,
  initDatabase,
  markWorkItemDelivered,
  markWorkItemFailed,
  setRegisteredGroup,
  setRouterState,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  buildRestartAnnouncement,
  consumeRestartContext,
  InterruptedGroup,
  writeShutdownContext,
} from './restart-context.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  findChannelForAgent,
  formatMessages,
  formatOutbound,
} from './router.js';
import { ensureRequiredRuntimes } from './runtimes/index.js';
import { restoreRemoteControl } from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { dbAgentSessionRepository } from './repositories/agent-session-repository.js';
import { AgentExecutionService } from './services/agent-execution-service.js';
import { AgentSessionService } from './services/agent-session-service.js';
import { createChannelCommandService } from './services/channel-command-service.js';
import { PairedRoomService } from './services/paired-room-service.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
const sessionService = new AgentSessionService(
  dbAgentSessionRepository,
  sessions,
);
let agentExecutionService: AgentExecutionService;
let pairedRoomService: PairedRoomService;

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
  } catch (err) {
    if (!isSyntaxError(err)) throw err;
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  // Load all groups so NanoClaw (single-process) can route messages to any agent type.
  // Paired rooms (jids with multiple agent_types) are detected separately because
  // getAllRegisteredGroups() returns one representative group per JID.
  registeredGroups = getAllRegisteredGroups();
  const pairedRoomCount = Object.keys(registeredGroups).filter((jid) =>
    isPairedRoomJid(jid),
  ).length;
  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      pairedRooms: pairedRoomCount,
    },
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
    if (!isError(err)) throw err;
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

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
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
    const isDedicatedDiscordAgentRoom =
      chatJid.startsWith('dc:') &&
      getRegisteredAgentTypesForJid(chatJid).length === 1;
    if (!hasTrigger && !isDedicatedDiscordAgentRoom) return true;
  }

  // ── Pause check: skip processing if agent(s) are paused ──────────────
  if (isPairedRoomJid(chatJid)) {
    const allGroups = getAllGroupsForJid(chatJid);
    const allPaused = allGroups.every((g) =>
      isGroupPaused(chatJid, g.agentType ?? 'claude-code'),
    );
    if (allPaused) {
      logger.info({ chatJid }, 'All agents paused in paired room, skipping');
      return true;
    }
  } else {
    const agentType = group.agentType ?? 'claude-code';
    if (isGroupPaused(chatJid, agentType)) {
      logger.info({ chatJid, agentType }, 'Agent paused, skipping');
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // ── Paired room: discussion loop (Claude → Copilot → Gemini, repeat) ────
  if (isPairedRoomJid(chatJid)) {
    await channel.setTyping?.(chatJid, true);
    let typingInterval: ReturnType<typeof setInterval> | null = setInterval(
      () => {
        channel.setTyping?.(chatJid, true)?.catch(() => {});
      },
      8000,
    );
    const clearTyping = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
        channel.setTyping?.(chatJid, false)?.catch(() => {});
      }
    };

    try {
      const result = await pairedRoomService.process(chatJid, prompt);
      if (result !== 'success') {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name },
          'Paired-room agent error, rolled back message cursor for retry',
        );
        return false;
      }
      return result === 'success';
    } finally {
      clearTyping();
    }
  }
  // ── End paired room ───────────────────────────────────────────────────

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
  // Refresh typing indicator every 8s (WhatsApp/Telegram expire it after ~10s)
  let typingInterval: ReturnType<typeof setInterval> | null = setInterval(
    () => {
      channel.setTyping?.(chatJid, true)?.catch(() => {});
    },
    8000,
  );

  const clearTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
      channel.setTyping?.(chatJid, false)?.catch(() => {});
    }
  };

  let hadError = false;
  let outputSentToUser = false;

  const output = await agentExecutionService.runForGroup(
    group,
    prompt,
    chatJid,
    async (result) => {
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
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
        clearTyping();
      }

      if (result.status === 'error') {
        hadError = true;
        clearTyping();
      }
    },
  );

  clearTyping();
  if (idleTimer) clearTimeout(idleTimer);

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
            // Note: paired room sequential agents (Gemini/Copilot) will be triggered
            // via processGroupMessages when the enqueued task runs — no extra fire needed.
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      if (!isError(err)) throw err;
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

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();
  ensureRequiredRuntimes(registeredGroups);

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Persist restart context for any groups currently being processed
    const interruptedGroups: InterruptedGroup[] = Object.keys(registeredGroups)
      .filter((jid) => queue.isGroupBusy(jid))
      .map((jid) => ({
        chatJid: jid,
        groupName: registeredGroups[jid]?.name || jid,
        status: 'processing' as const,
      }));
    writeShutdownContext(interruptedGroups, signal);

    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const commandService = createChannelCommandService({
    channels,
    getRegisteredGroups: () => registeredGroups,
    queue,
    sessionService,
  });
  agentExecutionService = new AgentExecutionService({
    assistantName: ASSISTANT_NAME,
    queue,
    sessionService,
    getAvailableGroups,
    getRegisteredJids: () => new Set(Object.keys(registeredGroups)),
  });
  pairedRoomService = new PairedRoomService({
    channels,
    executeAgent: agentExecutionService,
    queue,
  });

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      commandService
        .handleInboundCommand(chatJid, msg)
        .then((handled) => {
          if (handled) return;

          // Sender allowlist drop mode: discard messages from denied senders before storing
          if (
            !msg.is_from_me &&
            !msg.is_bot_message &&
            registeredGroups[chatJid]
          ) {
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
        })
        .catch((err) =>
          logger.error({ err, chatJid }, 'Inbound command handling error'),
        );
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
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Announce restart to any groups that were interrupted at last shutdown
  const restartCtx = consumeRestartContext();
  if (restartCtx) {
    logger.info(
      { interruptedCount: restartCtx.groups.length },
      'Announcing restart recovery',
    );
    for (const group of restartCtx.groups) {
      const ch = findChannel(channels, group.chatJid);
      if (ch?.isConnected()) {
        const msg = buildRestartAnnouncement(group, restartCtx.signal);
        ch.sendMessage(group.chatJid, msg).catch((err) =>
          logger.warn(
            { chatJid: group.chatJid, err },
            'Failed to send restart announcement',
          ),
        );
      }
    }
  }

  // Retry any work_items that failed to deliver before the last shutdown
  const undelivered = getUndeliveredWorkItems();
  if (undelivered.length > 0) {
    logger.info(
      { count: undelivered.length },
      'Retrying undelivered work items',
    );
    for (const item of undelivered) {
      const ch = findChannelForAgent(channels, item.agent_type);
      if (!ch?.isConnected()) continue;
      ch.sendMessage(item.chat_jid, item.result_payload).then(
        () => markWorkItemDelivered(item.id),
        (err) => markWorkItemFailed(item.id, String(err)),
      );
    }
  }

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
