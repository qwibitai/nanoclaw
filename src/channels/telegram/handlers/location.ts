import type { Bot } from 'grammy';

import {
  buildLocationPrefix,
  type LiveLocationManager,
} from '../../../live-location.js';
import type { ChannelOpts } from '../../registry.js';

import { createMediaStore, type MediaHandlerDeps } from './media.js';

export interface LocationHandlerDeps extends MediaHandlerDeps {
  opts: ChannelOpts;
  liveLocation: LiveLocationManager;
  sendMessage: (
    jid: string,
    text: string,
    threadId?: string,
  ) => Promise<void>;
}

export function registerLocationHandlers(
  bot: Bot,
  deps: LocationHandlerDeps,
): void {
  const storeMedia = createMediaStore(deps);

  bot.on('message:location', async (ctx) => {
    const chatJid = `tg:${ctx.chat.id}`;
    const group = deps.opts.registeredGroups()[chatJid];
    if (!group) return;

    const loc = ctx.message.location;
    if (!loc) return;

    const threadId = ctx.message.message_thread_id?.toString();
    const livePeriod = loc.live_period ?? 0;

    if (livePeriod > 0) {
      const logPath = deps.liveLocation.startSession(
        chatJid,
        ctx.message.message_id,
        loc.latitude,
        loc.longitude,
        livePeriod,
        loc.horizontal_accuracy,
        loc.heading,
      );

      await deps.sendMessage(
        chatJid,
        '📍 Live location sharing start.',
        threadId,
      );

      const agentContent = buildLocationPrefix(
        '[Live location sharing start]',
        loc.latitude,
        loc.longitude,
        logPath,
        loc.horizontal_accuracy,
        loc.heading,
      );
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      deps.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      deps.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: agentContent,
        timestamp,
        is_from_me: false,
        thread_id: threadId,
      });
    } else {
      storeMedia(ctx, '[Location]');
    }
  });

  bot.on('edited_message:location', async (ctx) => {
    const loc = ctx.editedMessage?.location;
    if (!loc) return;

    const chatJid = `tg:${ctx.chat.id}`;
    const group = deps.opts.registeredGroups()[chatJid];
    if (!group) return;

    const result = deps.liveLocation.updateSession(
      chatJid,
      ctx.editedMessage.message_id,
      loc.latitude,
      loc.longitude,
      loc.horizontal_accuracy,
      loc.heading,
      loc.live_period,
    );

    if (result === 'stopped') {
      deps.liveLocation.stopSession(chatJid);
      // onStopped callback fires inside stopSession
    }
    // 'updated' / 'recovery-created': log already appended, no agent notification
  });
}
