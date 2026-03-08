import { JSONRPCErrorException } from 'json-rpc-2.0';

import { logger } from '../logger.js';
import {
  registerHandler,
  type HandlerContext,
  type HandlerDeps,
} from './registry.js';

// Application-level JSON-RPC error codes (reserved range: -32000 to -32099)
const ERR_UNAUTHORIZED = -32000;

// --- reaction ---
registerHandler(
  'reaction',
  async (
    params: { chatJid: string; emoji: string; messageId?: string },
    context: HandlerContext,
    deps: HandlerDeps,
  ) => {
    const registeredGroups = deps.registeredGroups();
    const targetGroup = registeredGroups[params.chatJid];

    if (
      !context.isMain &&
      (!targetGroup || targetGroup.folder !== context.sourceGroup)
    ) {
      logger.warn(
        { chatJid: params.chatJid, sourceGroup: context.sourceGroup },
        'Unauthorized reaction attempt blocked',
      );
      throw new JSONRPCErrorException(
        'Not authorized to react in this chat',
        ERR_UNAUTHORIZED,
      );
    }

    if (!deps.sendReaction) {
      throw new JSONRPCErrorException(
        'Reactions not supported by the current channel',
        -32601,
      );
    }

    await deps.sendReaction(params.chatJid, params.emoji, params.messageId);
    logger.info(
      { chatJid: params.chatJid, emoji: params.emoji, sourceGroup: context.sourceGroup },
      'Reaction sent via JSON-RPC',
    );
    return { ok: true };
  },
);
