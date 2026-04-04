// Copyright (c) 2026 Botler 360 SAS. All rights reserved.
// See LICENSE.md for license terms.

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { getAllTasks, getMessagesSince, setSession } from './db.js';
import { GroupQueue } from './group-queue.js';
import { findChannel } from './router.js';
import { formatMessages } from './router.js';
import {
  isRateLimitError,
  markErrorNotified,
  resetErrorCooldown,
  shouldNotifyError,
} from './anti-spam.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import { logger } from './logger.js';
import { incCounter } from './metrics.js';
import { Channel, RegisteredGroup } from './types.js';
import {
  lastAgentTimestamp,
  lastGchatReplyTarget,
  registeredGroups,
  sessions,
  saveState,
  getAvailableGroups,
  setSessionForGroup,
} from './state.js';

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
export async function processGroupMessages(
  chatJid: string,
  channels: Channel[],
  queue: GroupQueue,
): Promise<boolean> {
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
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
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

  incCounter('nanoclaw_messages_processed_total', { group: group.folder });
  incCounter('nanoclaw_containers_spawned_total');

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
    channels,
    queue,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );

        // Anti-spam: intercept rate-limit errors
        if (text && isRateLimitError(text)) {
          if (shouldNotifyError(chatJid)) {
            await channel.sendMessage(
              chatJid,
              '\u23f8\ufe0f Je suis temporairement indisponible. Je reviens d\u00e8s que possible.',
            );
            markErrorNotified(chatJid);
            outputSentToUser = true;
          } else {
            logger.warn(
              { group: group.name, chatJid },
              'Rate limit error suppressed (cooldown active)',
            );
          }
          hadError = true;
        } else if (text) {
          // Normal output — reset error cooldown on success
          resetErrorCooldown(chatJid);
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;

          // Cross-post to Google Chat if the triggering message came from Chat
          const gchatChannel = channels.find(
            (c) => c.name === 'google-chat' && c.isConnected(),
          );
          if (gchatChannel && lastGchatReplyTarget[group.folder]) {
            const gchatJid = lastGchatReplyTarget[group.folder];
            try {
              await gchatChannel.sendMessage(gchatJid, text);
            } catch (err) {
              logger.warn(
                { err, gchatJid },
                'Failed to cross-post to Google Chat',
              );
            }
            delete lastGchatReplyTarget[group.folder];
          }
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
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    incCounter('nanoclaw_container_errors_total');
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
  channels: Channel[],
  queue: GroupQueue,
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
          setSessionForGroup(group.folder, output.newSessionId);
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
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      setSessionForGroup(group.folder, output.newSessionId);
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
