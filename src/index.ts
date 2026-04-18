import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  HOST_GID,
  HOST_UID,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
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
  deleteAllSessions,
  deleteSession,
  deleteSessionName,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessageById,
  getMessagesSince,
  getTaskById,
  createTask,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  DEFAULT_SESSION_NAME,
  GroupQueue,
  MAINTENANCE_SESSION_NAME,
} from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { initBotPool } from './channels/telegram.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { ChannelType } from './text-styles.js';
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
import { startSessionCleanup } from './session-cleanup.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/** Check if a message is a reply to or quote of a bot message. */
function isReplyToBot(msg: NewMessage): boolean {
  // Check content prefix — resolveReply adds [Replying to SenderName: "..."]
  if (msg.content.startsWith(`[Replying to ${ASSISTANT_NAME}:`)) return true;
  // Check reply_to_message_id in DB — covers cases where prefix format differs
  if (msg.reply_to_message_id) {
    const original = getMessageById(msg.reply_to_message_id, msg.chat_jid);
    if (original?.is_from_me) return true;
  }
  return false;
}

let lastTimestamp = '';
// Nested by groupFolder → sessionName → sessionId. The `default` and
// `maintenance` slots each maintain their own SDK session chain so that
// maintenance tasks can resume THEIR prior run rather than inheriting the
// user-facing container's sessionId (which wouldn't exist in maintenance's
// per-session .claude/ mount).
let sessions: Record<string, Record<string, string>> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Per-chat reply-to tracking: updated when follow-up messages are piped,
// consumed by the output callback to quote-reply the latest message.
const pendingReplyTo: Record<string, string | undefined> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// Circuit breaker: pause groups that fail repeatedly to avoid burning credits.
const MAX_CONSECUTIVE_FAILURES = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const consecutiveFailures: Record<string, number> = {};
const circuitBreakerUntil: Record<string, number> = {};

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
  // Main: full admin template. Trusted: global template. Untrusted: dedicated template.
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const isUntrusted = !group.isMain && !group.containerConfig?.trusted;
    let templateFile: string;
    if (group.isMain) {
      templateFile = path.join(GROUPS_DIR, 'main', 'CLAUDE.md');
    } else if (isUntrusted) {
      templateFile = path.join(GROUPS_DIR, 'global', 'CLAUDE-untrusted.md');
    } else {
      templateFile = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    }
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

  // Chown group folder to the container user so the agent can write to it.
  // In DooD the orchestrator runs as root — files it creates are root-owned.
  const effectiveUid = HOST_UID ?? process.getuid?.();
  const effectiveGid = HOST_GID ?? process.getgid?.();
  if (effectiveUid != null && effectiveUid !== 0) {
    try {
      chownRecursive(groupDir, effectiveUid, effectiveGid ?? effectiveUid);
    } catch (err) {
      logger.warn(
        { folder: group.folder, err },
        'Failed to chown group folder',
      );
    }
  }

  // Auto-create a lightweight heartbeat for trigger-required groups.
  // These groups have their own container and can only send to their own chat,
  // preventing cross-group message routing bugs from the main heartbeat.
  if (group.requiresTrigger !== false && !group.isMain) {
    const heartbeatId = `heartbeat-${group.folder}`;
    if (!getTaskById(heartbeatId)) {
      createTask({
        id: heartbeatId,
        group_folder: group.folder,
        chat_jid: jid,
        prompt:
          'Run the check-unanswered script only: python3 /home/node/.claude/skills/tessl__check-unanswered/scripts/check-unanswered.py — then react and reply to each unanswered message. Do NOT query the database directly. Do NOT check email, calendar, or system health.',
        schedule_type: 'cron',
        schedule_value: '*/15 * * * *',
        context_mode: 'group',
        next_run: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
      logger.info(
        { jid, folder: group.folder },
        'Auto-created heartbeat for trigger-required group',
      );
    }
  }

  // Auto-create the parallel-maintenance heartbeat for every main group.
  // Mirrors the non-main auto-registration above, but runs in the
  // `maintenance` session slot so it doesn't block user-facing Andy.
  // The task-scheduler fires this every 15 minutes via
  // `MAINTENANCE_SESSION_NAME`; the prompt keeps the defensive preamble
  // as belt-and-suspenders against improvisation.
  if (group.isMain) {
    const heartbeatId = `heartbeat-${group.folder}`;
    if (!getTaskById(heartbeatId)) {
      createTask({
        id: heartbeatId,
        group_folder: group.folder,
        chat_jid: jid,
        prompt:
          'MANDATORY FIRST ACTION: Call Skill(skill: "tessl__heartbeat") BEFORE doing anything else. Do NOT improvise checks. Do NOT query databases. Do NOT invent thresholds. Load and execute the skill exactly as written.\n\n' +
          'This is a scheduled heartbeat — no ACK reaction, no reply_to.\n' +
          'Workspace: /workspace/group/\n' +
          'Telegram HTML ONLY: <b>, <i>, <code>, <a href="url">text</a>, • for bullets. NEVER Markdown.\n' +
          'CRITICAL: NEVER set the "sender" parameter on send_message. Always call send_message with only "text" and optionally "pin". The sender parameter routes through pool bots and bypasses the database — messages become ghosts.\n' +
          'If nothing actionable → produce NO output at all. Silence = success.',
        schedule_type: 'interval',
        schedule_value: '900000', // 15 minutes in ms
        context_mode: 'group',
        next_run: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
      logger.info(
        { jid, folder: group.folder },
        'Auto-created maintenance heartbeat for main group',
      );
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function chownRecursive(dir: string, uid: number, gid: number): void {
  fs.chownSync(dir, uid, gid);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    fs.chownSync(fullPath, uid, gid);
    if (entry.isDirectory()) {
      chownRecursive(fullPath, uid, gid);
    }
  }
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
      containerConfig: registeredGroups[c.jid]?.containerConfig,
      requiresTrigger: registeredGroups[c.jid]?.requiresTrigger,
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
  let group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  // Circuit breaker: skip groups that have failed too many times in a row
  const breakerExpiry = circuitBreakerUntil[group.folder];
  if (breakerExpiry) {
    if (Date.now() < breakerExpiry) {
      logger.warn({ group: group.name }, 'Circuit breaker active — skipping');
      return true;
    }
    // Cooldown expired — reset and let the group try again
    delete circuitBreakerUntil[group.folder];
    consecutiveFailures[group.folder] = 0;
    logger.info(
      { group: group.name },
      'Circuit breaker cooldown expired — resuming',
    );
  }

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: getTriggerPattern(group.trigger),
    timezone: TIMEZONE,
    deps: {
      sendMessage: async (text) => {
        await channel.sendMessage(chatJid, text);
      },
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = getTriggerPattern(group.trigger).test(
          msg.content.trim(),
        );
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        (triggerPattern.test(m.content.trim()) || isReplyToBot(m)) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
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
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing container stdin',
        );
        queue.closeStdin(chatJid);
      },
      group.isMain || group.containerConfig?.trusted ? IDLE_TIMEOUT : 300_000,
    );
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Progressive streaming disabled — causes message override bugs when
  // multiple messages are piped to the same container.

  // Track which message triggered the response — first reply quotes it.
  // Uses shared pendingReplyTo map so follow-up messages piped via
  // queue.sendMessage() can update the reply target for the output callback.
  pendingReplyTo[chatJid] = missedMessages[missedMessages.length - 1]?.id;
  logger.info(
    {
      replyToMessageId: pendingReplyTo[chatJid],
      messageIds: missedMessages.map((m) => m.id),
      group: group.name,
    },
    'Reply-to tracking',
  );

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
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          const replyId = pendingReplyTo[chatJid];
          await channel.sendMessage(chatJid, text, replyId);
          // Store bot response in DB so heartbeat can track answered messages
          storeMessage({
            id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            chat_jid: chatJid,
            sender: ASSISTANT_NAME,
            sender_name: ASSISTANT_NAME,
            content: text,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
            reply_to_message_id: replyId,
          });
          // Consume after first reply — prevents replying to the wrong message
          // when user sends follow-ups while background agent is working.
          pendingReplyTo[chatJid] = undefined;
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
    },
    pendingReplyTo[chatJid],
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // Track consecutive failures for circuit breaker
    consecutiveFailures[group.folder] =
      (consecutiveFailures[group.folder] || 0) + 1;
    if (consecutiveFailures[group.folder] >= MAX_CONSECUTIVE_FAILURES) {
      circuitBreakerUntil[group.folder] =
        Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      logger.error(
        { group: group.name, failures: consecutiveFailures[group.folder] },
        `Circuit breaker tripped — pausing group for ${CIRCUIT_BREAKER_COOLDOWN_MS / 60_000} minutes`,
      );
      // Notify via main group if this isn't the main group
      if (!isMainGroup) {
        const mainJid = Object.keys(registeredGroups).find(
          (jid) => registeredGroups[jid].isMain,
        );
        if (mainJid) {
          const mainChannel = findChannel(channels, mainJid);
          mainChannel?.sendMessage(
            mainJid,
            `Circuit breaker tripped for "${group.name}" — ${consecutiveFailures[group.folder]} consecutive failures. Paused for 30 minutes. Check logs.`,
          );
        }
      }
    }

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

  // Reset failure counter on success
  consecutiveFailures[group.folder] = 0;
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  replyToMessageId?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  // User-facing path always uses the `default` slot's session chain.
  const sessionId = sessions[group.folder]?.[DEFAULT_SESSION_NAME];

  // Update tasks snapshot for container to read (filtered by group)
  const isTrusted = !!group.containerConfig?.trusted;
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
    isTrusted,
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
    isTrusted,
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          if (!sessions[group.folder]) sessions[group.folder] = {};
          sessions[group.folder][DEFAULT_SESSION_NAME] = output.newSessionId;
          setSession(group.folder, DEFAULT_SESSION_NAME, output.newSessionId);
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
        isTrusted: !!group.containerConfig?.trusted,
        assistantName: ASSISTANT_NAME,
        replyToMessageId,
        // User-facing path. Invariant: inbound messages always route to
        // `default`. `src/task-scheduler.ts` is the sole writer of
        // `'maintenance'` — maintenance-Andy never reaches this code path.
        sessionName: DEFAULT_SESSION_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(
          chatJid,
          DEFAULT_SESSION_NAME,
          proc,
          containerName,
          group.folder,
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      if (!sessions[group.folder]) sessions[group.folder] = {};
      sessions[group.folder][DEFAULT_SESSION_NAME] = output.newSessionId;
      setSession(group.folder, DEFAULT_SESSION_NAME, output.newSessionId);
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
        // Only clear the DEFAULT slot — this path runs the user-facing
        // container, so a stale session here is default's problem, not
        // maintenance's. Wiping both would force maintenance to restart
        // its own session chain for no reason.
        if (sessions[group.folder])
          delete sessions[group.folder][DEFAULT_SESSION_NAME];
        deleteSessionName(group.folder, DEFAULT_SESSION_NAME);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      // Detect stale session — clear so next invocation starts fresh.
      // Same scope: user-facing path, only touch the default slot.
      if (
        output.error &&
        /session|conversation not found|resume/i.test(output.error)
      ) {
        if (sessions[group.folder])
          delete sessions[group.folder][DEFAULT_SESSION_NAME];
        deleteSessionName(group.folder, DEFAULT_SESSION_NAME);
        logger.info(
          { group: group.name },
          'Cleared stale default session after resume error',
        );
      }
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

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) =>
              extractSessionCommand(
                m.content,
                getTriggerPattern(group.trigger),
              ) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                (triggerPattern.test(m.content.trim()) || isReplyToBot(m)) &&
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

          const lastMsgId = messagesToSend[messagesToSend.length - 1]?.id;
          if (queue.sendMessage(chatJid, formatted, lastMsgId)) {
            // Update shared reply-to so the output callback quotes this message
            pendingReplyTo[chatJid] = lastMsgId;
            logger.debug(
              {
                chatJid,
                count: messagesToSend.length,
                replyToMessageId: lastMsgId,
              },
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

    if (!msg.is_from_me) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: sender is not the account owner',
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

  // Initialize Telegram bot pool for agent teams (swarm)
  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, sessionName, proc, containerName, groupFolder) =>
      queue.registerProcess(
        groupJid,
        sessionName,
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
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, rawText, replyToMessageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text, replyToMessageId);
    },
    sendReaction: async (jid, messageId, emoji) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      if (messageId) {
        await channel.sendReaction?.(jid, messageId, emoji);
      } else {
        await channel.reactToLatestMessage?.(jid, emoji);
      }
    },
    pinMessage: async (jid, messageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      await channel.pinMessage?.(jid, messageId);
    },
    sendFile: async (jid, filePath, caption, replyToMessageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      await channel.sendFile?.(jid, filePath, caption, replyToMessageId);
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
    nukeSession: (
      groupFolder: string,
      session: 'default' | 'maintenance' | 'all',
    ) => {
      // Granular nuke: `session` narrows which slot(s) to kill.
      //   'all'         → kill default + maintenance (pre-parallel default)
      //   'default'     → kill only user-facing container
      //   'maintenance' → kill only scheduled-task container
      // Useful when one session is wedged (e.g. a hung heartbeat in
      // maintenance) and we don't want to drop the user's default
      // conversation state as collateral damage.
      const jid =
        Object.entries(registeredGroups).find(
          ([, g]) => g.folder === groupFolder,
        )?.[0] || '';
      if (jid) {
        if (session === 'default' || session === 'all') {
          queue.closeStdin(jid, DEFAULT_SESSION_NAME);
        }
        if (session === 'maintenance' || session === 'all') {
          queue.closeStdin(jid, MAINTENANCE_SESSION_NAME);
        }
      }
      // Clear stored sessionIds for the killed slot(s). `deleteSession`
      // removes every row for the folder — reuse for 'all'. For
      // single-slot nukes we use the new `deleteSessionName` helper so
      // the surviving slot keeps its session chain.
      if (session === 'all') {
        delete sessions[groupFolder];
        deleteSession(groupFolder);
      } else {
        const sessionName =
          session === 'default'
            ? DEFAULT_SESSION_NAME
            : MAINTENANCE_SESSION_NAME;
        if (sessions[groupFolder]) delete sessions[groupFolder][sessionName];
        deleteSessionName(groupFolder, sessionName);
      }
      logger.info({ groupFolder, session }, 'Session nuked via IPC');
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
        writeTasksSnapshot(
          group.folder,
          group.isMain === true,
          taskRows,
          !!group.containerConfig?.trusted,
        );
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Write available_groups.json for all main/trusted groups on startup.
  // Otherwise the snapshot only updates when a container spawns, which can
  // leave it weeks stale if the group doesn't get traffic.
  const startupGroups = getAvailableGroups();
  const startupRegisteredJids = new Set(Object.keys(registeredGroups));
  for (const [, group] of Object.entries(registeredGroups)) {
    if (group.isMain || group.containerConfig?.trusted) {
      writeGroupsSnapshot(
        group.folder,
        group.isMain === true,
        startupGroups,
        startupRegisteredJids,
        !!group.containerConfig?.trusted,
      );
    }
  }


  // Periodic tile update from registry (every 15 min)
  // Heartbeat runs in the container and can't call tessl update.
  // This catches publishes that the post-promote timer missed.
  const { execFile: execTesslUpdate } = await import('child_process');
  setInterval(() => {
    execTesslUpdate(
      'bash',
      [
        '-c',
        'cd /app/tessl-workspace && tessl update --yes --dangerously-ignore-security --agent claude-code 2>&1',
      ],
      { timeout: 120_000 },
      (err, stdout) => {
        if (err) {
          logger.warn({ error: err.message }, 'Periodic tessl update failed');
        } else if (stdout.includes('Updated')) {
          const cleared = deleteAllSessions();
          logger.info(
            { sessionsCleared: cleared, output: stdout.trim().slice(-200) },
            'Periodic tessl update found new tiles — sessions cleared',
          );
        }
      },
    );
  }, 900_000);

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
