import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
  getTriggerPattern,
} from '../config.js';
import {
  deleteOutboxMessage,
  getMessagesSince,
  getNewMessages,
  getOutboxMessages,
  incrementOutboxAttempts,
} from '../db.js';
import type { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import { findChannel, formatMessages } from '../router.js';
import { isTriggerAllowed, loadSenderAllowlist } from '../sender-allowlist.js';
import type { Channel, NewMessage } from '../types.js';

import { getEffectiveModel } from './effective-model.js';
import type { OrchestratorState } from './state.js';
import { getOrRecoverCursor, saveState } from './state.js';

export interface MessageLoopDeps {
  state: OrchestratorState;
  queue: GroupQueue;
  channels: Channel[];
}

/**
 * Main polling loop: every POLL_INTERVAL ms, fetch new messages for
 * every registered group, pipe them into an already-running container
 * via `queue.sendMessage`, or enqueue a fresh container via
 * `queue.enqueueMessageCheck`.
 */
export async function startMessageLoop(deps: MessageLoopDeps): Promise<void> {
  const { state, queue, channels } = deps;

  if (state.messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  state.messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(state.registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        state.lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        state.lastTimestamp = newTimestamp;
        saveState(state);

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
          const group = state.registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

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

          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(state, chatJid, ASSISTANT_NAME),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          if (allPending.length === 0) continue;
          const formatted = formatMessages(
            allPending,
            TIMEZONE,
            group,
            getEffectiveModel(group).model,
          );

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: allPending.length },
              'Piped messages to active container',
            );
            state.lastAgentTimestamp[chatJid] =
              allPending[allPending.length - 1].timestamp;
            saveState(state);

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
 * Recover any messages that arrived while the orchestrator was down by
 * enqueueing a fresh container for each group with a non-empty backlog.
 */
export function recoverPendingMessages(deps: MessageLoopDeps): void {
  const { state, queue } = deps;
  for (const [chatJid, group] of Object.entries(state.registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(state, chatJid, ASSISTANT_NAME),
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
 * Retry delivery of messages that failed to send at runtime — they
 * were persisted to the outbox table and get another chance on boot.
 */
export async function recoverOutbox(deps: {
  channels: Channel[];
}): Promise<void> {
  const pending = getOutboxMessages();
  if (pending.length === 0) return;
  logger.info(
    { count: pending.length },
    'Recovering unsent messages from outbox',
  );
  for (const msg of pending) {
    const channel = findChannel(deps.channels, msg.chatJid);
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
