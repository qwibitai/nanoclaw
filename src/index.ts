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
  MAX_MESSAGES_PER_PROMPT,
  NOSTR_DM_ALLOWLIST,
  ONECLI_URL,
  POLL_INTERVAL,
  MCP_SERVER_ENABLED,
  SIGNAL_PHONE_NUMBER,
  TIMEZONE,
  TRIGGER_PATTERN,
  WATCH_JID,
  WATCH_SIGNAL_MIRROR_JID,
  WN_ACCOUNT_PUBKEY,
  messageHasTrigger,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  buildAllowedTools,
  buildContainerSecurityRules,
  isSenderTrusted,
  loadSecurityPolicy,
  readKillswitch,
  SecurityPolicy,
} from './security-policy.js';
import { NostrDMChannel } from './channels/nostr-dm.js';
import { SignalChannel } from './channels/signal.js';
import { WhiteNoiseChannel } from './channels/whitenoise.js';
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
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  logTokenUsage,
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
import { initHealthMonitor, reportError } from './health.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let cursorBeforePipe: Record<string, string> = {};
let messageLoopRunning = false;
// JIDs of unregistered contacts Scott has already been notified about
let notifiedContacts: Set<string> = new Set();

/** Filter messages to only authorized senders. No-op when owner_ids is empty. */
function filterAuthorized(messages: NewMessage[]): NewMessage[] {
  const { owner_ids, trusted_members } = securityPolicy.trust;
  if (owner_ids.length === 0) return messages;
  return messages.filter(
    (m) =>
      m.is_from_me ||
      owner_ids.includes(m.sender) ||
      trusted_members.includes(m.sender),
  );
}

const channels: Channel[] = [];
const queue = new GroupQueue();
let securityPolicy: SecurityPolicy;

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
  const pipeCursor = getRouterState('cursor_before_pipe');
  try {
    cursorBeforePipe = pipeCursor ? JSON.parse(pipeCursor) : {};
  } catch {
    logger.warn('Corrupted cursor_before_pipe in DB, resetting');
    cursorBeforePipe = {};
  }
  const notifiedRaw = getRouterState('notified_contacts');
  try {
    notifiedContacts = new Set(notifiedRaw ? JSON.parse(notifiedRaw) : []);
  } catch {
    notifiedContacts = new Set();
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
  setRouterState('cursor_before_pipe', JSON.stringify(cursorBeforePipe));
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

  // Killswitch check for interactive messages
  const ks = readKillswitch(securityPolicy, group.folder);
  if (!ks.canRun) {
    logger.info(
      { chatJid, folder: group.folder },
      'Killswitch active, refusing interactive message',
    );
    await channel.sendMessage(chatJid, ks.message);
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = filterAuthorized(
    getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    ),
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        messageHasTrigger(m.content) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Trust only when ALL non-bot senders are owners (prevent untrusted piggyback)
  const externalMessages = missedMessages.filter((m) => !m.is_from_me);
  const senderTrusted =
    externalMessages.length > 0 &&
    externalMessages.every((m) => isSenderTrusted(securityPolicy, m.sender));

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  cursorBeforePipe[chatJid] = previousCursor;
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
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
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
        const text = formatOutbound(raw);
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      // Only mark idle on session-update signals (result=null), not on text
      // output during an active query. The agent-runner emits
      // {status:'success', result:'...'} when the model produces text mid-query,
      // but tool calls may still follow. Premature notifyIdle makes the host
      // classify a busy container as idle-warm, causing piped messages to race
      // with the idle close timer and get lost.
      if (result.status === 'success' && !result.result) {
        delete cursorBeforePipe[chatJid];
        saveState();
        queue.notifyIdle(chatJid);
        // Reset idle timer when the query truly finishes (not on mid-query text
        // output). Without this, the timer started on the last text output can
        // fire immediately after the query ends, closing the container before it
        // can accept input.
        resetIdleTimer();
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    senderTrusted,
  );

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
  senderTrusted?: boolean,
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
        senderTrusted,
        securityRules: buildContainerSecurityRules(securityPolicy),
        allowedTools: buildAllowedTools(securityPolicy),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      securityPolicy,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if ((output.inputTokens || 0) + (output.outputTokens || 0) > 0) {
      logTokenUsage(
        group.folder,
        chatJid,
        output.inputTokens || 0,
        output.outputTokens || 0,
      );
      logger.debug(
        {
          group: group.name,
          inputTokens: output.inputTokens,
          outputTokens: output.outputTokens,
        },
        'Token usage logged',
      );
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
      const errMsg = output.error || 'Unknown error';
      if (
        errMsg.includes('401') ||
        errMsg.includes('authentication') ||
        errMsg.includes('token')
      ) {
        await reportError(
          'auth-failure',
          `Authentication error in ${group.name}: ${errMsg.slice(0, 200)}`,
        );
      } else {
        await reportError(
          `agent-error:${group.folder}`,
          `Agent error in ${group.name}: ${errMsg.slice(0, 200)}`,
        );
      }
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    await reportError(
      `agent-crash:${group.folder}`,
      `Agent crashed in ${group.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'error';
  }
}

/**
 * Check for DMs from unregistered contacts and notify the admin once per contact.
 * The admin (main group) can then approve contacts via the agent's register_group IPC.
 */
async function checkNewContactDMs(): Promise<void> {
  const registeredJids = new Set(Object.keys(registeredGroups));
  const adminJid = Object.entries(registeredGroups).find(
    ([, g]) => g.isMain,
  )?.[0];
  if (!adminJid) return;

  const allChats = getAllChats();
  for (const chat of allChats) {
    // Only notify for Signal/Nostr individual contacts — not WhatsApp history,
    // not groups (is_group may be 0/null for old data), not our own number
    const isSignalContact =
      chat.channel === 'signal' &&
      chat.jid.startsWith('signal:') &&
      !chat.jid.includes('group.') &&
      chat.jid !== `signal:${SIGNAL_PHONE_NUMBER}`;
    const isNostrContact =
      chat.channel === 'nostr' && chat.jid.startsWith('nostr:');
    if (
      (!isSignalContact && !isNostrContact) ||
      registeredJids.has(chat.jid) ||
      notifiedContacts.has(chat.jid)
    )
      continue;

    notifiedContacts.add(chat.jid);
    setRouterState('notified_contacts', JSON.stringify([...notifiedContacts]));

    const adminChannel = findChannel(channels, adminJid);
    if (!adminChannel) continue;

    const displayName = chat.name || chat.jid;
    await adminChannel.sendMessage(
      adminJid,
      `New Signal DM from *${displayName}*\nJID: ${chat.jid}\n\nTell me "approve contact ${displayName}" to allow them to chat with Jorgenclaw.`,
    );
    logger.info(
      { jid: chat.jid, name: chat.name },
      'Notified admin of new contact DM',
    );
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
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                messageHasTrigger(m.content) &&
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
          const messagesToSend = filterAuthorized(
            allPending.length > 0 ? allPending : groupMessages,
          );
          if (messagesToSend.length === 0) continue;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Killswitch check for message piping to active containers
          const ksLoop = readKillswitch(securityPolicy, group.folder);
          if (!ksLoop.canRun) {
            await channel.sendMessage(chatJid, ksLoop.message);
            continue;
          }

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
    // Check for DMs from new (unregistered) contacts and notify admin
    await checkNewContactDMs().catch((err) =>
      logger.warn({ err }, 'Error checking new contact DMs'),
    );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  let rolledBack = false;
  for (const [chatJid, savedCursor] of Object.entries(cursorBeforePipe)) {
    if (queue.isActive(chatJid)) {
      logger.debug(
        { chatJid },
        'Recovery: skipping piped-cursor rollback, container still active',
      );
      continue;
    }
    logger.info(
      { chatJid, rolledBackTo: savedCursor },
      'Recovery: rolling back piped-message cursor',
    );
    lastAgentTimestamp[chatJid] = savedCursor;
    delete cursorBeforePipe[chatJid];
    rolledBack = true;
  }
  if (rolledBack) saveState();

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

/**
 * Retry connecting a channel with exponential backoff (5s -> 10s -> 20s ... cap 5min).
 * Once connected, pushes into the live channels array so message routing picks it up.
 */
function retryChannelConnect(channel: Channel, liveChannels: Channel[]): void {
  const MAX_DELAY_MS = 5 * 60 * 1000;
  let delay = 5000;

  const attempt = () => {
    setTimeout(async () => {
      try {
        await channel.connect();
        liveChannels.push(channel);
        logger.info({ channel: channel.name }, 'Channel connected after retry');
      } catch (err) {
        logger.warn(
          {
            channel: channel.name,
            err,
            nextRetryMs: Math.min(delay * 2, MAX_DELAY_MS),
          },
          'Channel retry failed -- will try again',
        );
        delay = Math.min(delay * 2, MAX_DELAY_MS);
        attempt();
      }
    }, delay);
  };

  attempt();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  securityPolicy = loadSecurityPolicy();
  logger.info('Security policy loaded');
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    cursorBeforePipe = {};
    saveState();
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
  // Channels that fail to connect are retried in the background with exponential backoff
  // so the service stays alive even if the network is temporarily down.
  let configuredChannelCount = 0;
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
    configuredChannelCount++;
    try {
      await channel.connect();
      channels.push(channel);
    } catch (err) {
      logger.warn(
        { channel: channelName, err },
        'Channel failed to connect -- will retry in background',
      );
      retryChannelConnect(channel, channels);
    }
  }
  if (configuredChannelCount === 0) {
    logger.fatal('No channels configured');
    process.exit(1);
  }

  // Initialize health monitor — sends alerts to admin (main group) on errors
  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  if (mainEntry) {
    const signalChannel = channels.find((c) => c.name === 'signal');
    if (signalChannel) {
      initHealthMonitor({ adminJid: mainEntry[0], channel: signalChannel });
    }
  }

  // Wire optional Signal mirror for the watch channel. When
  // WATCH_SIGNAL_MIRROR_JID is configured AND both watch and signal channels
  // are running, the watch channel will forward each user message and agent
  // reply to that Signal JID so Scott can read watch conversations on his
  // phone.
  if (WATCH_SIGNAL_MIRROR_JID) {
    const watchChannel = channels.find((c) => c.name === 'watch');
    const signalChannel = channels.find((c) => c.name === 'signal');
    if (watchChannel && signalChannel && 'setMirrorTarget' in watchChannel) {
      (
        watchChannel as unknown as {
          setMirrorTarget: (ch: typeof signalChannel, jid: string) => void;
        }
      ).setMirrorTarget(signalChannel, WATCH_SIGNAL_MIRROR_JID);
    } else {
      logger.warn(
        {
          hasWatch: !!watchChannel,
          hasSignal: !!signalChannel,
        },
        'WATCH_SIGNAL_MIRROR_JID set but cannot wire mirror — channel(s) missing',
      );
    }
  }

  // Start paid MCP server if enabled
  if (MCP_SERVER_ENABLED) {
    try {
      const { startMcpServer } = await import('./mcp-server.js');
      await startMcpServer();
    } catch (err) {
      logger.error(
        { err },
        'Failed to start MCP server (continuing without it)',
      );
    }
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
    sendMessage: (jid, rawText, media) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text, media);
    },
    sendReaction: (jid, messageId, emoji, targetAuthor) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendReaction) return Promise.resolve();
      return channel.sendReaction(jid, messageId, emoji, targetAuthor);
    },
    sendImage: (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendImage) {
        logger.warn({ jid }, 'Channel does not support sendImage');
        return Promise.resolve();
      }
      return channel.sendImage(jid, filePath, caption);
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
