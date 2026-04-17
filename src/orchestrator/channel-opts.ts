import {
  ASSISTANT_NAME,
  MAX_MESSAGES_PER_PROMPT,
  TIMEZONE,
  getTriggerPattern,
} from '../config.js';
import {
  deleteSession,
  getMessagesSince,
  storeChatMetadata,
  storeMessage,
} from '../db.js';
import type { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import { findChannel, formatMessages } from '../router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from '../sender-allowlist.js';
import type { SessionGuard } from '../session-guard.js';
import type { Channel, NewMessage } from '../types.js';

import { getEffectiveModel } from './effective-model.js';
import { handleRemoteControl } from './remote-control-handler.js';
import type { OrchestratorState } from './state.js';
import { getOrRecoverCursor, saveState } from './state.js';

export interface ChannelOptsDeps {
  state: OrchestratorState;
  queue: GroupQueue;
  channels: Channel[];
  sessionGuard: SessionGuard;
}

/**
 * Build the `ChannelOpts` object that every registered channel consumes.
 * Holds the main inbound-message path, chat-metadata persistence, status
 * snapshot, outbound IPC, and session-clear callback. All live references
 * are captured via the `deps` closure so channels don't need to know
 * about the orchestrator's internal state shape.
 */
export function buildChannelOpts(deps: ChannelOptsDeps) {
  const { state, queue, channels, sessionGuard } = deps;
  const { compactPending, deferredCompact } = state;

  return {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg, {
          channels,
          registeredGroups: state.registeredGroups,
        }).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        state.registeredGroups[chatJid]
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

      // Event-driven: kick message processing immediately without waiting for poll
      const group = state.registeredGroups[chatJid];
      if (!group) return;

      const ch = findChannel(channels, chatJid);
      if (!ch) return;

      const isMainGroup = group.isMain === true;
      const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

      if (needsTrigger) {
        const triggerPattern = getTriggerPattern(group.trigger);
        const allowlistCfg = loadSenderAllowlist();
        const hasTrigger =
          triggerPattern.test(msg.content.trim()) &&
          (msg.is_from_me ||
            isTriggerAllowed(chatJid, msg.sender, allowlistCfg));
        if (!hasTrigger) return;
      }

      // Active container → pipe via IPC + typing indicator
      const allPending = getMessagesSince(
        chatJid,
        getOrRecoverCursor(state, chatJid, ASSISTANT_NAME),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (allPending.length > 0) {
        const formatted = formatMessages(
          allPending,
          TIMEZONE,
          group,
          getEffectiveModel(group).model,
        );
        if (queue.sendMessage(chatJid, formatted)) {
          state.lastAgentTimestamp[chatJid] =
            allPending[allPending.length - 1].timestamp;
          saveState(state);
          if (!queue.isRecentResponseSent(chatJid)) {
            ch.setTyping?.(chatJid, true)?.catch(() => {});
          }
          return;
        }
      }

      queue.enqueueMessageCheck(chatJid);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => state.registeredGroups,
    getStatus: () => ({
      activeContainers: queue.getStatus().activeContainers,
      uptimeSeconds: Math.floor(process.uptime()),
      sessions: { ...state.sessions },
      lastUsage: { ...state.lastUsage },
      compactCount: { ...state.compactCount },
      lastRateLimit: { ...state.lastRateLimit },
    }),
    sendIpcMessage: (chatJid: string, text: string) => {
      const sent = queue.sendMessage(chatJid, text);
      if (sent && text === '/compact') {
        compactPending.add(chatJid);
      }
      if (!sent && text === '/compact') {
        // No active container — defer compact to next container run if session exists
        const group = state.registeredGroups[chatJid];
        if (group && state.sessions[group.folder]) {
          deferredCompact.add(chatJid);
          return true;
        }
      }
      return sent;
    },
    clearSession: (groupFolder: string, chatJid: string) => {
      delete state.sessions[groupFolder];
      deleteSession(groupFolder);
      sessionGuard.markCleared(groupFolder);
      queue.closeStdin(chatJid);
    },
  };
}
