import {
  ASSISTANT_NAME,
  MAX_MESSAGES_PER_PROMPT,
  TIMEZONE,
} from '../config.js';
import { getMessagesSince, storeMessage } from '../db.js';
import type { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import { formatMessages } from '../router.js';
import type { NewMessage } from '../types.js';
import { startWebhookServer } from '../webhook.js';

import { getEffectiveModel } from './effective-model.js';
import type { OrchestratorState } from './state.js';
import { getOrRecoverCursor, saveState } from './state.js';

export interface WebhookBridgeDeps {
  state: OrchestratorState;
  queue: GroupQueue;
  port: number;
}

/**
 * Start the incoming-webhook HTTP server. Each POST is stored as if it
 * came from the connected channel, then either piped to an active
 * container or queued for a new one. Failures to start are logged but
 * non-fatal — NanoClaw continues without the webhook.
 */
export function startWebhookBridge(deps: WebhookBridgeDeps): void {
  const { state, queue, port } = deps;
  startWebhookServer(port, {
    getMainGroupJid: () =>
      Object.keys(state.registeredGroups).find(
        (jid) => state.registeredGroups[jid].isMain === true,
      ),
    onWebhookMessage: (chatJid: string, text: string) => {
      const msg: NewMessage = {
        id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: chatJid,
        sender: 'webhook',
        sender_name: 'Webhook',
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
      };
      storeMessage(msg);

      // Event-driven: pipe to active container or enqueue for a new one
      const allPending = getMessagesSince(
        chatJid,
        getOrRecoverCursor(state, chatJid, ASSISTANT_NAME),
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (allPending.length > 0) {
        const grp = state.registeredGroups[chatJid];
        const formatted = formatMessages(
          allPending,
          TIMEZONE,
          grp,
          grp ? getEffectiveModel(grp).model : undefined,
        );
        if (queue.sendMessage(chatJid, formatted)) {
          state.lastAgentTimestamp[chatJid] =
            allPending[allPending.length - 1].timestamp;
          saveState(state);
          return;
        }
      }
      queue.enqueueMessageCheck(chatJid);
    },
  }).catch((err) => {
    logger.warn(
      { err },
      'Webhook server failed to start, continuing without it',
    );
  });
}
