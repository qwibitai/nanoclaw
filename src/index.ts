import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { MessageChunker, detectChannelFromJid } from './message-chunker.js';
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
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllUnifiedSessionIds,
  setUnifiedSessionId,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getMessagesSinceForJids,
  getNewMessages,
  getRouterState,
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
  findChannel,
  formatMessages,
  formatOutbound,
  stripModelArtifacts,
  stripUnclosedInternalTag,
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
import {
  Channel,
  ContainerConfig,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import { MessageDebouncer } from './message-debouncer.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let unifiedSessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
// Pending model switch notification to inject into the next prompt
const pendingModelNotification: Record<string, string> = {};
// Groups that should force compaction on their next agent run
const pendingForceCompact: Set<string> = new Set();
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

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

/**
 * Get all JIDs that share the same group folder.
 * Used for unified sessions across multiple channels.
 */
function getJidsForFolder(folder: string): string[] {
  return Object.entries(registeredGroups)
    .filter(([, group]) => group.folder === folder)
    .map(([jid]) => jid);
}

/**
 * Get the group info for a folder (all jids share the same group info).
 * Returns the first matching group, or undefined if none found.
 */
function getGroupForFolder(folder: string): RegisteredGroup | undefined {
  for (const group of Object.values(registeredGroups)) {
    if (group.folder === folder) return group;
  }
  return undefined;
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
  sessions = getAllSessions();
  unifiedSessions = getAllUnifiedSessionIds();
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
 * Now takes groupFolder instead of chatJid to support unified sessions.
 */
async function processGroupMessages(groupFolder: string): Promise<boolean> {
  const group = getGroupForFolder(groupFolder);
  if (!group) return true;

  // Get all JIDs that share this folder (for unified sessions)
  const jids = getJidsForFolder(groupFolder);
  if (jids.length === 0) return true;

  // Find the primary channel for sending replies
  // Use the JID that has the most recent message
  let primaryJid = jids[0];
  let primaryChannel = findChannel(channels, primaryJid);

  const isMainGroup = group.isMain === true;

  // Collect messages from all JIDs sharing this folder
  // Use the earliest cursor among all JIDs to avoid missing messages
  const cursors = jids.map((jid) => getOrRecoverCursor(jid));
  const earliestCursor = cursors.reduce((a, b) => (a < b ? a : b));

  const missedMessages = getMessagesSinceForJids(
    jids,
    earliestCursor,
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // Stable active channel: track which channel the user is actively using
  // Key: active_jid:<folder>, Value: the JID of the active channel
  const activeJidKey = `active_jid:${groupFolder}`;
  let activeJid = getRouterState(activeJidKey);

  // Check if any message in the bundle is from a different channel
  // Switch to that channel (only for non-bot messages)
  for (const msg of missedMessages) {
    if (msg.is_bot_message) continue; // Don't switch on bot messages
    const msgChannel = findChannel(channels, msg.chat_jid);
    const currentChannel = activeJid ? findChannel(channels, activeJid) : null;

    // If this message is from a different channel than current, switch
    if (
      msgChannel &&
      (!currentChannel || msgChannel.name !== currentChannel.name)
    ) {
      activeJid = msg.chat_jid;
      setRouterState(activeJidKey, activeJid);
      logger.info(
        { group: group.name, newChannel: msgChannel.name, newJid: activeJid },
        'Active channel switched',
      );
      break; // Only switch once per bundle
    }
  }

  // If no active JID set yet (first time), use the last message's JID
  if (!activeJid) {
    const lastMessage = missedMessages[missedMessages.length - 1];
    activeJid = lastMessage.chat_jid;
    setRouterState(activeJidKey, activeJid);
  }

  primaryJid = activeJid;
  primaryChannel = findChannel(channels, primaryJid);

  if (!primaryChannel) {
    logger.warn(
      { primaryJid },
      'No channel owns primary JID, skipping messages',
    );
    return true;
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(primaryJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor for ALL jids to avoid re-processing
  // Use the timestamp of the last message processed
  const lastTimestamp = missedMessages[missedMessages.length - 1].timestamp;
  for (const jid of jids) {
    lastAgentTimestamp[jid] = lastTimestamp;
  }
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length, jids },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle.
  // Groups with HEARTBEAT.md stay alive indefinitely — heartbeats act as keepalive.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const hasHeartbeat = fs.existsSync(
    path.join(GROUPS_DIR, group.folder, 'HEARTBEAT.md'),
  );

  const resetIdleTimer = () => {
    if (hasHeartbeat) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(groupFolder);
    }, IDLE_TIMEOUT);
  };

  await primaryChannel.setTyping?.(primaryJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Streaming state for edit-in-place
  let streamingMessageId: string | null = null;
  let editDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEditText: string | null = null;
  // completedText holds finalized text from prior streaming rounds + tool calls.
  // Each new Ollama partial (which is the full accumulated text for the current round)
  // is appended to completedText for display.
  let completedText = '';
  // Track the latest partial text from the current streaming round
  let currentRoundText = '';

  // Message chunking for long streaming output
  const chunker = new MessageChunker(detectChannelFromJid(primaryJid));
  // splitPoint: character offset in fullText where current message started
  // When 0, we're on the first message; when > 0, we're on a continuation message
  // For editing, we send fullText.slice(splitPoint) to only include new content
  let splitPoint = 0;

  const flushEdit = async () => {
    if (pendingEditText && streamingMessageId && primaryChannel?.editMessage) {
      const fullText = pendingEditText;
      pendingEditText = null;

      // The continuation content (what we're editing into the current message)
      const continuationText = fullText.slice(splitPoint);

      // Check if continuation is approaching the threshold
      const check = chunker.checkThreshold('', continuationText);

      if (check.needsChunk) {
        // Need to split the continuation and start a new message
        const { first, rest } = chunker.splitAtBoundary(
          continuationText,
          chunker.getThreshold(),
        );

        // Finalize current message with first chunk
        const finalText = fullText.slice(0, splitPoint) + first;
        await primaryChannel.editMessage(primaryJid, streamingMessageId, first);
        logger.info(
          { length: first.length, totalChunks: 1 },
          'Stream chunk finalized (threshold reached)',
        );

        // Start a new message with rest
        if (rest && primaryChannel.sendMessageReturningId) {
          streamingMessageId = await primaryChannel.sendMessageReturningId(
            primaryJid,
            rest,
          );
          splitPoint = fullText.length - rest.length;

          // Update tracking variables for the new chunk
          // completedText stays the same (it's before splitPoint)
          // currentRoundText becomes the rest (will be updated on next partial)
        }
      } else {
        // Normal edit - send the continuation to current message
        await primaryChannel.editMessage(
          primaryJid,
          streamingMessageId,
          continuationText,
        );
      }
    }
  };

  const debouncedEdit = (text: string) => {
    pendingEditText = text;
    if (!editDebounceTimer) {
      editDebounceTimer = setTimeout(async () => {
        editDebounceTimer = null;
        await flushEdit();
      }, 300);
    }
  };

  const output = await runAgent(group, prompt, primaryJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip model artifacts — special tokens always, unclosed <internal> only on final output
      let text = stripModelArtifacts(raw, !result.isPartial);

      // Prepend thinking layer if enabled and present
      if (result.thinking && group.containerConfig?.showThinking) {
        text = text
          ? `_${result.thinking}_\n\n${text}`
          : `_${result.thinking}_`;
      }

      if (!text) return;

      if (result.isPartial) {
        // Streaming partial update
        if (result.isTooling) {
          // Skip display for communication tools — the user sees the result directly
          const hiddenTools = ['send_message', 'send_image'];
          if (hiddenTools.some((t) => text.includes(t))) {
            return;
          }
          // Tool execution — finalize current streaming text + append tool info.
          if (editDebounceTimer) {
            clearTimeout(editDebounceTimer);
            editDebounceTimer = null;
          }
          // Finalize: completedText = prior completed + current round + tool info.
          // Strip unclosed <internal> tags from currentRoundText before baking in,
          // since this text is being permanently finalized.
          const safeCurrentRound = currentRoundText
            ? stripUnclosedInternalTag(currentRoundText)
            : '';
          if (safeCurrentRound) {
            completedText = completedText
              ? `${completedText}\n\n${safeCurrentRound}\n\n${text}`
              : `${safeCurrentRound}\n\n${text}`;
          } else {
            completedText = completedText
              ? `${completedText}\n\n${text}`
              : text;
          }
          currentRoundText = '';
          if (streamingMessageId && primaryChannel?.editMessage) {
            await primaryChannel.editMessage(
              primaryJid,
              streamingMessageId,
              completedText,
            );
          } else if (primaryChannel?.sendMessageReturningId) {
            streamingMessageId = await primaryChannel.sendMessageReturningId(
              primaryJid,
              completedText,
            );
            outputSentToUser = true;
          }
        } else if (streamingMessageId && primaryChannel?.editMessage) {
          // Streaming partial — text is the full accumulated text for this round.
          // Prepend completedText (prior rounds + tool calls) for full display.
          currentRoundText = text;
          const fullText = completedText ? `${completedText}\n\n${text}` : text;
          debouncedEdit(fullText);
        } else if (primaryChannel?.sendMessageReturningId) {
          // First partial — send initial message and track its ID
          currentRoundText = text;
          streamingMessageId = await primaryChannel.sendMessageReturningId(
            primaryJid,
            text,
          );
          outputSentToUser = true;
        }
        // Channels without editing: skip partials silently
      } else {
        // Final complete output
        // Flush any pending debounced edit first
        if (editDebounceTimer) {
          clearTimeout(editDebounceTimer);
          editDebounceTimer = null;
        }
        if (streamingMessageId && primaryChannel?.editMessage) {
          // Edit the streaming message one final time with complete text,
          // including any accumulated text from before tool calls
          const fullText = completedText ? `${completedText}\n\n${text}` : text;
          await primaryChannel.editMessage(
            primaryJid,
            streamingMessageId,
            fullText,
          );
          streamingMessageId = null;
          completedText = '';
          currentRoundText = '';
          splitPoint = 0;
        } else {
          // No streaming happened, or channel doesn't support it
          await primaryChannel?.sendMessage(primaryJid, text);
        }
        outputSentToUser = true;
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        resetIdleTimer();
      }
    }

    if (result.status === 'success' && !result.isPartial) {
      // Reset streaming state on any final output so the next user turn
      // starts a fresh message (even if this output had no text).
      streamingMessageId = null;
      completedText = '';
      currentRoundText = '';
      splitPoint = 0;
      queue.notifyIdle(groupFolder);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await primaryChannel?.setTyping?.(primaryJid, false);
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
    // Roll back cursor for all jids so retries can re-process these messages
    for (const jid of jids) {
      lastAgentTimestamp[jid] = earliestCursor;
    }
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
  const sessionId = sessions[group.folder] || undefined;

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

  // Wrap onOutput to track session IDs from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        if (output.unifiedSessionId) {
          unifiedSessions[group.folder] = output.unifiedSessionId;
          setUnifiedSessionId(group.folder, output.unifiedSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Inject pending model switch notification into the prompt
  let finalPrompt = prompt;
  if (pendingModelNotification[chatJid]) {
    logger.info(
      {
        group: group.name,
        notification: pendingModelNotification[chatJid].slice(0, 80),
      },
      'Injecting model switch notification',
    );
    finalPrompt = `${pendingModelNotification[chatJid]}\n\n${prompt}`;
    delete pendingModelNotification[chatJid];
  }

  // Consume the force-compact flag if set
  const forceCompact = pendingForceCompact.has(chatJid);
  if (forceCompact) {
    pendingForceCompact.delete(chatJid);
  }

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: finalPrompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        modelProvider: group.containerConfig?.modelProvider,
        claudeModel: group.containerConfig?.claudeModel,
        ollamaModel: group.containerConfig?.ollamaModel,
        unifiedSessionId: unifiedSessions[group.folder],
        forceCompact,
      },
      (proc, containerName) =>
        queue.registerProcess(group.folder, proc, containerName),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
    if (output.unifiedSessionId) {
      unifiedSessions[group.folder] = output.unifiedSessionId;
      setUnifiedSessionId(group.folder, output.unifiedSessionId);
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

        // Deduplicate by group folder (unified sessions: multiple jids may share one folder)
        const messagesByFolder = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const group = registeredGroups[msg.chat_jid];
          if (!group) continue;
          const existing = messagesByFolder.get(group.folder);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByFolder.set(group.folder, [msg]);
          }
        }

        for (const [groupFolder, groupMessages] of messagesByFolder) {
          const group = getGroupForFolder(groupFolder);
          if (!group) continue;

          // Get all jids for this folder
          const jids = getJidsForFolder(groupFolder);

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some((m) => {
              const msgJid = m.chat_jid;
              return (
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(msgJid, m.sender, allowlistCfg))
              );
            });
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          // Use earliest cursor among all jids for this folder.
          const cursors = jids.map((jid) => getOrRecoverCursor(jid));
          const earliestCursor = cursors.reduce((a, b) => (a < b ? a : b));
          const allPending = getMessagesSinceForJids(
            jids,
            earliestCursor,
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Intercept /stop and /stop! interrupt commands. These never go to
          // the agent — they signal the container directly and an ack is sent
          // back via the channel that received the command.
          const interruptMessages = messagesToSend.filter((m) => {
            const t = m.content.trim();
            return t === '/stop' || t === '/stop!';
          });
          const normalMessages = messagesToSend.filter((m) => {
            const t = m.content.trim();
            return t !== '/stop' && t !== '/stop!';
          });

          if (interruptMessages.length > 0) {
            const lastInterrupt =
              interruptMessages[interruptMessages.length - 1];
            const isHardKill = interruptMessages.some(
              (m) => m.content.trim() === '/stop!',
            );
            const ackChannel = findChannel(channels, lastInterrupt.chat_jid);

            if (isHardKill) {
              const killed = queue.killContainer(groupFolder);
              logger.info(
                { groupFolder, killed },
                'Hard-kill requested via /stop!',
              );
              await ackChannel?.sendMessage(
                lastInterrupt.chat_jid,
                killed
                  ? 'Container killed. Next message spawns a fresh one.'
                  : 'No active container to kill.',
              );
            } else {
              const sent = queue.sendInterrupt(groupFolder);
              logger.info(
                { groupFolder, sent },
                'Cooperative interrupt requested via /stop',
              );
              await ackChannel?.sendMessage(
                lastInterrupt.chat_jid,
                sent ? 'Interrupting...' : 'No active container to interrupt.',
              );
            }
          }

          // If the bundle was nothing but interrupt commands, advance cursors
          // past them and skip the agent send entirely.
          if (normalMessages.length === 0) {
            if (interruptMessages.length > 0) {
              const lastTs =
                messagesToSend[messagesToSend.length - 1].timestamp;
              for (const jid of jids) {
                lastAgentTimestamp[jid] = lastTs;
              }
              saveState();
            }
            continue;
          }

          const formatted = formatMessages(normalMessages, TIMEZONE);

          if (queue.sendMessage(groupFolder, formatted)) {
            logger.debug(
              { groupFolder, count: normalMessages.length },
              'Piped messages to active container',
            );
            // Update cursors for all jids — advance past the WHOLE bundle
            // (including any interrupt commands we filtered out) so we don't
            // re-process them next poll cycle.
            const lastTs = messagesToSend[messagesToSend.length - 1].timestamp;
            for (const jid of jids) {
              lastAgentTimestamp[jid] = lastTs;
            }
            saveState();
            // Show typing indicator on the channel of the last normal message
            const lastMsgJid =
              normalMessages[normalMessages.length - 1].chat_jid;
            const lastChannel = findChannel(channels, lastMsgJid);
            lastChannel
              ?.setTyping?.(lastMsgJid, true)
              ?.catch((err) =>
                logger.warn(
                  { chatJid: lastMsgJid, err },
                  'Failed to set typing indicator',
                ),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(groupFolder);
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
  // Group by folder to handle unified sessions
  const folders = new Set<string>();
  for (const group of Object.values(registeredGroups)) {
    folders.add(group.folder);
  }

  for (const folder of folders) {
    const jids = getJidsForFolder(folder);
    const cursors = jids.map((jid) => getOrRecoverCursor(jid));
    const earliestCursor = cursors.reduce((a, b) => (a < b ? a : b));
    const pending = getMessagesSinceForJids(
      jids,
      earliestCursor,
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      const group = getGroupForFolder(folder);
      logger.info(
        { group: group?.name, folder, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(folder);
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

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    debouncer.flushAll(); // flush any pending multipart messages before exit
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  async function handleThinkToggle(
    command: string,
    chatJid: string,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const arg = command.trim().split(/\s+/)[1]?.toLowerCase();

    if (arg !== 'on' && arg !== 'off') {
      const current = group.containerConfig?.showThinking ? 'on' : 'off';
      await channel.sendMessage(
        chatJid,
        `Thinking display: ${current}\nUsage: /think on  or  /think off`,
      );
      return;
    }

    const showThinking = arg === 'on';
    const updatedConfig: ContainerConfig = {
      ...group.containerConfig,
      showThinking,
    };
    group.containerConfig = updatedConfig;
    setRegisteredGroup(chatJid, group);

    await channel.sendMessage(chatJid, `Thinking display: ${arg}`);

    logger.info(
      { chatJid, showThinking, group: group.name },
      'Thinking display toggled',
    );
  }

  async function handleContextReport(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    // Find the most recent unified session file for this group
    const sessionsDir = path.join(GROUPS_DIR, group.folder, '.sessions');
    let estimatedTokens = 0;
    let messageCount = 0;
    let sessionId = 'none';
    let lastProvider = 'unknown';

    try {
      if (fs.existsSync(sessionsDir)) {
        const files = fs
          .readdirSync(sessionsDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => ({
            name: f,
            mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
          const latest = files[0].name;
          const session = JSON.parse(
            fs.readFileSync(path.join(sessionsDir, latest), 'utf-8'),
          );
          sessionId = session.id || latest.replace('.json', '');
          lastProvider = session.lastProvider || 'unknown';
          messageCount = session.messages?.length || 0;

          // Estimate tokens: ~4 chars per token (matches container-side estimate)
          let chars = 0;
          for (const m of session.messages || []) {
            chars += (m.content || '').length;
            if (m.thinking) chars += m.thinking.length;
            if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
          }
          estimatedTokens = Math.ceil(chars / 4);
        }
      }
    } catch (err) {
      logger.error(
        { err, chatJid },
        'Failed to read session for context report',
      );
    }

    // Try to detect the model's effective context window
    let contextWindow = 0;
    let contextSource = '';
    const provider = group.containerConfig?.modelProvider || 'claude';
    if (provider === 'ollama') {
      const model = group.containerConfig?.ollamaModel || 'unknown';
      try {
        const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
        const resp = await fetch(`${ollamaHost}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model }),
        });
        if (resp.ok) {
          const info = (await resp.json()) as {
            model_info?: Record<string, unknown>;
          };
          if (info.model_info) {
            for (const [key, value] of Object.entries(info.model_info)) {
              if (
                key.endsWith('.context_length') &&
                typeof value === 'number'
              ) {
                contextWindow = value;
                break;
              }
            }
          }
        }
        // Cloud models capped at 131072
        if (model.endsWith(':cloud') && contextWindow > 131072) {
          contextWindow = 131072;
          contextSource = ' (capped for cloud)';
        }
      } catch {
        contextWindow = 131072;
        contextSource = ' (default — could not query)';
      }
    } else {
      // Claude — best-effort defaults
      const claudeModel = group.containerConfig?.claudeModel || 'sonnet';
      contextWindow = claudeModel.includes('opus') ? 1_000_000 : 200_000;
      contextSource = ' (model default)';
    }

    const pct =
      contextWindow > 0
        ? Math.round((estimatedTokens / contextWindow) * 100)
        : 0;
    const compactionThreshold = Math.round(contextWindow * 0.8);
    const willCompactSoon = estimatedTokens > compactionThreshold;

    const lines = [
      `Context report:`,
      `  Provider: ${provider}`,
      `  Messages: ${messageCount}`,
      `  Estimated tokens: ${estimatedTokens.toLocaleString()}`,
      `  Context window: ${contextWindow.toLocaleString()}${contextSource}`,
      `  Usage: ${pct}%`,
      `  Compaction threshold: ${compactionThreshold.toLocaleString()} (80%)`,
      willCompactSoon ? `  ⚠ Will compact on next turn` : `  ✓ Below threshold`,
      `  Last provider: ${lastProvider}`,
      `  Session: ${sessionId}`,
    ];
    await channel.sendMessage(chatJid, lines.join('\n'));
  }

  async function handleForceCompact(chatJid: string): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const provider = group.containerConfig?.modelProvider || 'claude';
    if (provider !== 'ollama') {
      await channel.sendMessage(
        chatJid,
        'Compaction is only available for Ollama models. Claude manages its own context via the SDK.',
      );
      return;
    }

    // Mark for force-compaction and restart the container so the new run picks up the flag
    pendingForceCompact.add(group.folder);
    queue.forceCloseAndDeactivate(group.folder);

    await channel.sendMessage(
      chatJid,
      'Compaction queued. It will run on the next message you send.',
    );

    logger.info({ chatJid, group: group.name }, 'Force compaction queued');
  }

  async function handleModelSwitch(
    command: string,
    chatJid: string,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    // Parse: /model claude [model]  OR  /model ollama [model]
    // Claude models: sonnet, opus, haiku, or full ID like claude-opus-4-5
    // Ollama models: glm-5:cloud, gemma4:31b, etc.
    const parts = command.trim().split(/\s+/);
    const provider = parts[1]?.toLowerCase();

    if (provider !== 'claude' && provider !== 'ollama') {
      const current = group.containerConfig?.modelProvider || 'claude';
      const claudeModel = group.containerConfig?.claudeModel || 'default';
      const ollamaModel = group.containerConfig?.ollamaModel || '';
      const display =
        current === 'ollama'
          ? `ollama/${ollamaModel}`
          : `claude/${claudeModel}`;
      await channel.sendMessage(
        chatJid,
        `Current model: ${display}\nUsage: /model claude [sonnet|opus|haiku]  or  /model ollama [model-name]`,
      );
      return;
    }

    const modelName = parts[2] || undefined;

    // Validate Claude model name
    if (provider === 'claude' && modelName) {
      const validClaude = [
        'sonnet',
        'opus',
        'haiku',
        'claude-sonnet-4-6',
        'claude-opus-4-6',
        'claude-haiku-4-5',
        'claude-sonnet-4-5',
        'claude-opus-4-5',
      ];
      if (!validClaude.includes(modelName.toLowerCase())) {
        await channel.sendMessage(
          chatJid,
          `Unknown Claude model "${modelName}". Available: ${validClaude.join(', ')}`,
        );
        return;
      }
    }

    // Validate Ollama model exists before switching
    if (provider === 'ollama' && modelName) {
      try {
        const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
        const resp = await fetch(`${ollamaHost}/api/tags`);
        if (resp.ok) {
          const data = (await resp.json()) as {
            models?: Array<{ name: string }>;
          };
          const available = data.models?.map((m) => m.name) || [];
          // Match with or without :latest tag
          const found = available.some(
            (n) =>
              n === modelName ||
              n === `${modelName}:latest` ||
              n.replace(':latest', '') === modelName,
          );
          if (!found) {
            const list = available
              .map((n) => n.replace(':latest', ''))
              .join(', ');
            await channel.sendMessage(
              chatJid,
              `Model "${modelName}" not found. Available: ${list}`,
            );
            return;
          }
        }
      } catch {
        // Can't reach Ollama — let it fail at container time
      }
    }

    const previousProvider = group.containerConfig?.modelProvider || 'claude';
    const providerChanged = previousProvider !== provider;

    // Close the active container and deactivate immediately so new messages
    // don't get piped to the dying container. Next message spawns a fresh one.
    queue.forceCloseAndDeactivate(group.folder);

    // Only clear the SDK session when switching providers (Claude ↔ Ollama).
    // Claude-to-Claude model changes preserve the SDK session since the SDK
    // supports model changes within a session.
    if (providerChanged) {
      delete sessions[group.folder];
      setSession(group.folder, '');
    }

    // Update the group's containerConfig
    const updatedConfig: ContainerConfig = {
      ...group.containerConfig,
      modelProvider: provider,
      claudeModel:
        provider === 'claude' ? modelName : group.containerConfig?.claudeModel,
      ollamaModel:
        provider === 'ollama'
          ? modelName || group.containerConfig?.ollamaModel || 'llama3.2'
          : group.containerConfig?.ollamaModel,
    };
    group.containerConfig = updatedConfig;
    setRegisteredGroup(chatJid, group);

    const modelDisplay =
      provider === 'ollama'
        ? `ollama/${updatedConfig.ollamaModel}`
        : `claude/${modelName || 'default'}`;

    // Queue a notification for the next prompt so the agent knows about the switch
    pendingModelNotification[chatJid] =
      `[SYSTEM NOTIFICATION — Model switch has occurred. You are now running on ${modelDisplay}. This message was injected automatically by the NanoClaw infrastructure, not sent by a user.]`;

    await channel.sendMessage(chatJid, `Switched to ${modelDisplay}`);

    logger.info(
      { chatJid, provider, modelName, group: group.name },
      'Model provider switched',
    );
  }

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

  // Debounce buffer: reassembles multipart messages before they reach the DB.
  // Telegram splits long messages into separate events arriving milliseconds apart.
  // Without this, the agent can read a partial message before all fragments arrive.
  // The buffer holds user messages for 1 second after the last fragment; bot and
  // self messages pass through immediately since their splits are intentional.
  const debouncer = new MessageDebouncer(
    (chatJid: string, msg: NewMessage) => storeMessage(msg),
    1000,
  );

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Host-side commands — intercept before debounce/storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }
      if (/^\/model\s/i.test(trimmed) || trimmed === '/model') {
        handleModelSwitch(trimmed, chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Model switch command error'),
        );
        return;
      }
      if (/^\/think\s/i.test(trimmed) || trimmed === '/think') {
        handleThinkToggle(trimmed, chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Think toggle error'),
        );
        return;
      }
      if (trimmed === '/context') {
        handleContextReport(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Context report error'),
        );
        return;
      }
      if (trimmed === '/compact') {
        handleForceCompact(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Force compact error'),
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

      // Route through debouncer — merges multipart fragments before storing
      debouncer.push(chatJid, msg);
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
    getUnifiedSessions: () => unifiedSessions,
    queue,
    onProcess: (groupFolder, proc, containerName) =>
      queue.registerProcess(groupFolder, proc, containerName),
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
    sendImage: async (jid, imagePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendImage) {
        await channel.sendImage(jid, imagePath, caption);
      } else {
        await channel.sendMessage(
          jid,
          caption
            ? `[Image: ${imagePath}] ${caption}`
            : `[Image: ${imagePath}]`,
        );
      }
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
