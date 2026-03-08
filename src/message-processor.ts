import { getMessagesSince } from './db.js';
import { logger } from './logger.js';
import { formatMessages } from './router.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { Channel, RegisteredGroup } from './types.js';

export { extractSessionCommand, isSessionCommandAllowed };

export interface AgentOutput {
  status: 'success' | 'error';
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

  // Session command interception (before trigger check)
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: deps.triggerPattern,
    timezone: deps.timezone,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        deps.runAgent(group, prompt, chatJid, (output) =>
          onOutput({ status: output.status, result: output.result }),
        ),
      closeStdin: () => deps.queue.closeStdin(chatJid),
      advanceCursor: (ts) => deps.setAgentCursor(chatJid, ts),
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = deps.triggerPattern.test(msg.content.trim());
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

  // Cancel idle timer when a follow-up message is piped to the container,
  // since the agent is no longer idle. A fresh timer starts when the agent
  // finishes the next query and emits another success.
  deps.queue.registerOnPiped(chatJid, cancelIdleTimer);

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await deps.runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
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
      }
    }

    if (result.status === 'success') {
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
    deps.setAgentCursor(chatJid, previousCursor);
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
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
