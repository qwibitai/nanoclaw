import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  TIMEZONE,
  getTriggerPattern,
} from '../config.js';
import type { ContainerOutput } from '../container-runner.js';
import { enqueueOutbox, getMessagesSince } from '../db.js';
import type { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import {
  extractImages,
  findChannel,
  formatMessages,
  sendImages,
  stripInternalTags,
} from '../router.js';
import { isTriggerAllowed, loadSenderAllowlist } from '../sender-allowlist.js';
import { createStreamEditLoop } from '../stream-edit-loop.js';
import type { Channel, RegisteredGroup } from '../types.js';

import { getEffectiveModel } from './effective-model.js';
import type { OrchestratorState } from './state.js';
import { getOrRecoverCursor, saveState } from './state.js';

export interface ProcessMessagesDeps {
  state: OrchestratorState;
  queue: GroupQueue;
  channels: Channel[];
  runAgent: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    effectiveModel: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ) => Promise<'success' | 'error'>;
}

/**
 * Build the `processGroupMessages` function that the GroupQueue calls
 * when a group's turn comes up. The returned function pulls every
 * missed message since the group's cursor, formats the prompt,
 * spawns the agent with streaming, and reconciles the response with
 * the outbound channel.
 */
export function createProcessGroupMessages(
  deps: ProcessMessagesDeps,
): (chatJid: string) => Promise<boolean> {
  const { state, queue, channels, runAgent } = deps;

  return async function processGroupMessages(
    chatJid: string,
  ): Promise<boolean> {
    const group = state.registeredGroups[chatJid];
    if (!group) return true;

    const channel = findChannel(channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.isMain === true;

    const missedMessages = getMessagesSince(
      chatJid,
      getOrRecoverCursor(state, chatJid, ASSISTANT_NAME),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );

    if (missedMessages.length === 0) return true;

    if (!isMainGroup && group.requiresTrigger !== false) {
      const triggerPattern = getTriggerPattern(group.trigger);
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = missedMessages.some(
        (m) =>
          triggerPattern.test(m.content.trim()) &&
          (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
      );
      if (!hasTrigger) return true;
    }

    const {
      model: effectiveModel,
      reverted,
      revertedFrom,
    } = getEffectiveModel(group);
    if (reverted) {
      channel
        .sendMessage(
          chatJid,
          `Model override expired — reverted from ${revertedFrom} to ${effectiveModel}`,
        )
        .catch((err) =>
          logger.warn(
            { chatJid, err },
            'Failed to send model revert notification',
          ),
        );
    }

    const prompt = formatMessages(
      missedMessages,
      TIMEZONE,
      group,
      effectiveModel,
    );

    const previousCursor = state.lastAgentTimestamp[chatJid] || '';
    state.lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState(state);

    logger.info(
      { group: group.name, messageCount: missedMessages.length },
      'Processing messages',
    );

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
    let typingActive = true;
    const typingKeepalive = setInterval(() => {
      if (typingActive) channel.setTyping?.(chatJid, true).catch(() => {});
    }, 2000);

    let hadError = false;
    let outputSentToUser = false;
    let lastSentText: string | null = null;
    let streamMessageId: number | null = null;
    let compactInFlight = false;
    let compactSafetyTimer: ReturnType<typeof setTimeout> | null = null;
    let streamingFailed = false;

    const streamLoop = createStreamEditLoop({
      throttleMs: 500,
      async sendOrEdit(text) {
        const { cleanText: streamText } = extractImages(text);
        if (!streamText) return false;
        if (queue.hasPendingMessages(chatJid)) {
          streamMessageId = null;
          streamingFailed = true;
          throw new Error('pending messages');
        }
        if (streamMessageId === null) {
          const msgId = await channel.sendStreamMessage!(chatJid, streamText);
          if (!msgId || typeof msgId !== 'number') {
            streamingFailed = true;
            throw new Error('sendStreamMessage failed');
          }
          streamMessageId = msgId;
          lastSentText = streamText;
          await channel.setTyping?.(chatJid, true).catch(() => {});
        } else {
          if (streamText.length > 4000) {
            streamingFailed = true;
            throw new Error('text too long for streaming edit');
          }
          try {
            await channel.editMessage!(chatJid, streamMessageId, streamText);
            lastSentText = streamText;
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Stream edit failed, falling back to final send',
            );
            streamingFailed = true;
            throw err;
          }
        }
      },
    });

    let output: 'success' | 'error';
    try {
      output = await runAgent(
        group,
        prompt,
        chatJid,
        effectiveModel,
        async (result) => {
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            const text = stripInternalTags(raw);

            if (result.partial) {
              if (!typingActive) {
                typingActive = true;
                await channel.setTyping?.(chatJid, true).catch(() => {});
              }
              if (!text || streamingFailed || !channel.sendStreamMessage) {
                resetIdleTimer();
                return;
              }
              streamLoop.update(text);
              resetIdleTimer();
              return;
            }

            await streamLoop.flush();
            await streamLoop.waitForInFlight();

            logger.info(
              { group: group.name },
              `Agent output: ${raw.length} chars`,
            );

            const { cleanText, images } = extractImages(text);

            if (streamMessageId !== null) {
              if (cleanText && cleanText !== lastSentText) {
                try {
                  if (
                    !streamingFailed &&
                    cleanText.length <= 4096 &&
                    !queue.hasPendingMessages(chatJid)
                  ) {
                    await channel.editMessage!(
                      chatJid,
                      streamMessageId,
                      cleanText,
                    );
                  } else {
                    await channel.sendMessage(chatJid, cleanText);
                  }
                  // eslint-disable-next-line no-catch-all/no-catch-all
                } catch (err) {
                  logger.error(
                    { group: group.name, error: err },
                    'Failed to send final message, queuing for retry',
                  );
                  enqueueOutbox(chatJid, cleanText);
                }
              } else if (!cleanText) {
                await channel
                  .deleteMessage?.(chatJid, streamMessageId)
                  .catch(() => {});
              }
              await sendImages(channel, chatJid, images);
              outputSentToUser = true;
              queue.markResponseSent(chatJid);
              lastSentText = cleanText;
            } else if (cleanText && cleanText !== lastSentText) {
              try {
                await channel.sendMessage(chatJid, cleanText);
                // eslint-disable-next-line no-catch-all/no-catch-all
              } catch (err) {
                logger.error(
                  { group: group.name, error: err },
                  'Failed to send message, queuing for retry',
                );
                enqueueOutbox(chatJid, cleanText);
              }
              await sendImages(channel, chatJid, images);
              outputSentToUser = true;
              queue.markResponseSent(chatJid);
              lastSentText = cleanText;
            } else if (cleanText && cleanText === lastSentText) {
              logger.warn({ group: group.name }, 'Duplicate output suppressed');
            }

            if (streamMessageId === null && !cleanText && images.length > 0) {
              await sendImages(channel, chatJid, images);
              outputSentToUser = true;
              queue.markResponseSent(chatJid);
              lastSentText = cleanText;
            }

            streamLoop.resetForNextQuery();
            streamMessageId = null;
            streamingFailed = false;
            lastSentText = null;
            resetIdleTimer();
          }

          if (!result.partial) {
            typingActive = false;
          }

          if (result.status === 'success' && !result.partial) {
            if (state.deferredCompact.has(chatJid)) {
              state.deferredCompact.delete(chatJid);
              const compactSent = queue.sendMessage(chatJid, '/compact');
              if (compactSent) {
                state.compactPending.add(chatJid);
                compactInFlight = true;
                compactSafetyTimer = setTimeout(() => {
                  if (compactInFlight) {
                    compactInFlight = false;
                    queue.notifyIdle(chatJid);
                  }
                }, 60000);
              } else {
                queue.notifyIdle(chatJid);
              }
            } else if (compactInFlight) {
              if (result.compacted) {
                compactInFlight = false;
                if (compactSafetyTimer) {
                  clearTimeout(compactSafetyTimer);
                  compactSafetyTimer = null;
                }
                queue.notifyIdle(chatJid);
              }
            } else {
              queue.notifyIdle(chatJid);
            }
          }

          if (result.status === 'error') {
            hadError = true;
          }
        },
      );
    } finally {
      streamLoop.stop();
      clearInterval(typingKeepalive);
      await channel.setTyping?.(chatJid, false).catch(() => {});
      if (idleTimer) clearTimeout(idleTimer);
      if (compactSafetyTimer) clearTimeout(compactSafetyTimer);
    }

    if (output === 'error' || hadError) {
      state.deferredCompact.delete(chatJid);
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      state.lastAgentTimestamp[chatJid] = previousCursor;
      saveState(state);
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    return true;
  };
}
