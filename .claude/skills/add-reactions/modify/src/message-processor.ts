import { getMessagesSince } from './db.js';
import { logger } from './logger.js';
import { formatMessages } from './router.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import type { Channel, RegisteredGroup } from './types.js';

export interface AgentOutput {
  status: string;
  result?: string | null;
  error?: string | null;
}

export interface MessageProcessorDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  findChannel: (chatJid: string) => Channel | undefined;
  getAgentCursor: (chatJid: string) => string;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  runAgent: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: AgentOutput) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  queue: {
    closeStdin: (chatJid: string) => void;
    notifyIdle: (chatJid: string) => void;
    enqueueMessageCheck: (chatJid: string) => void;
    registerOnPiped: (chatJid: string, callback: () => void) => void;
  };

  assistantName: string;
  triggerPattern: RegExp;
  idleTimeout: number;
  timezone: string;

  statusCallbacks?: {
    markReceived(id: string, chatJid: string, fromMe: boolean): void;
    markThinking(id: string): void;
    markWorking(id: string): void;
    markAllDone(chatJid: string): void;
    markAllFailed(chatJid: string, error: string): void;
  };
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
export async function processGroupMessages(
  chatJid: string,
  deps: MessageProcessorDeps,
): Promise<boolean> {
  const groups = deps.registeredGroups();
  const group = groups[chatJid];
  if (!group) return true;

  const channel = deps.findChannel(chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = deps.getAgentCursor(chatJid);
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    deps.assistantName,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        deps.triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Ensure all user messages are tracked — recovery messages enter processGroupMessages
  // directly via the queue, bypassing startMessageLoop where markReceived normally fires.
  // markReceived is idempotent (rejects duplicates), so this is safe for normal-path messages too.
  for (const msg of missedMessages) {
    deps.statusCallbacks?.markReceived(msg.id, chatJid, false);
  }

  // Mark all user messages as thinking (container is spawning)
  const userMessages = missedMessages.filter(
    (m) => !m.is_from_me && !m.is_bot_message,
  );
  for (const msg of userMessages) {
    deps.statusCallbacks?.markThinking(msg.id);
  }

  const prompt = formatMessages(missedMessages, deps.timezone);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = sinceTimestamp;
  deps.setAgentCursor(
    chatJid,
    missedMessages[missedMessages.length - 1].timestamp,
  );

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
      deps.queue.closeStdin(chatJid);
    }, deps.idleTimeout);
  };

  const cancelIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  // Track whether new input was piped after the last user-visible output.
  // If the agent fails after piped input but before responding to it,
  // we must roll back the cursor so those messages are retried.
  let pipedAfterLastOutput = false;

  // Cancel idle timer when a follow-up message is piped to the container,
  // since the agent is no longer idle. A fresh timer starts when the agent
  // finishes the next query and emits another success.
  deps.queue.registerOnPiped(chatJid, () => {
    cancelIdleTimer();
    pipedAfterLastOutput = true;
  });

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let firstOutputSeen = false;

  const output = await deps.runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      if (!firstOutputSeen) {
        firstOutputSeen = true;
        for (const um of userMessages) {
          deps.statusCallbacks?.markWorking(um.id);
        }
      }

      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
        pipedAfterLastOutput = false;
      }
    }

    if (result.status === 'success') {
      deps.statusCallbacks?.markAllDone(chatJid);
      deps.queue.notifyIdle(chatJid);
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output and no follow-up was piped since, don't
    // roll back — the user got their response and re-processing would
    // send duplicates.
    if (outputSentToUser && !pipedAfterLastOutput) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      deps.statusCallbacks?.markAllDone(chatJid);
      return true;
    }
    // Roll back cursor so retries can re-process these messages.
    // When output was sent but a follow-up was piped after, we still
    // roll back to previousCursor — the retry will re-send the earlier
    // messages but the agent's session/context will deduplicate them.
    deps.setAgentCursor(chatJid, previousCursor);
    logger.warn(
      { group: group.name },
      pipedAfterLastOutput
        ? 'Agent error after piped follow-up, rolled back cursor to retry unanswered messages'
        : 'Agent error, rolled back message cursor for retry',
    );
    deps.statusCallbacks?.markAllFailed(chatJid, 'Task crashed — retrying.');
    return false;
  }

  return true;
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
export function recoverPendingMessages(deps: MessageProcessorDeps): void {
  const groups = deps.registeredGroups();
  for (const [chatJid, group] of Object.entries(groups)) {
    const sinceTimestamp = deps.getAgentCursor(chatJid);
    const pending = getMessagesSince(
      chatJid,
      sinceTimestamp,
      deps.assistantName,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      deps.queue.enqueueMessageCheck(chatJid);
    }
  }
}
