import type { Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../../../config.js';
import { getActiveLiveLocationContext } from '../../../live-location.js';
import { logger } from '../../../logger.js';
import type { ChannelOpts } from '../../registry.js';

const TELEGRAM_BOT_COMMANDS = new Set([
  'chatid',
  'ping',
  'model',
  'effort',
  'status',
  'compact',
  'clear',
  'tasks',
]);

export interface TextHandlerDeps {
  opts: ChannelOpts;
}

/**
 * Register the `message:text` handler. Skips texts starting with one
 * of the registered slash commands (so they don't get stored twice),
 * translates `@bot_username` mentions into the NanoClaw trigger
 * pattern, stores chat metadata, and forwards the message through
 * `opts.onMessage` for registered groups.
 */
export function registerTextHandler(bot: Bot, deps: TextHandlerDeps): void {
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) {
      const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
      if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
    }

    const chatJid = `tg:${ctx.chat.id}`;
    let content = ctx.message.text;
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const senderName =
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id.toString() ||
      'Unknown';
    const sender = ctx.from?.id.toString() || '';
    const msgId = ctx.message.message_id.toString();
    const threadId = ctx.message.message_thread_id;

    const replyTo = ctx.message.reply_to_message;
    const replyToMessageId = replyTo?.message_id?.toString();
    const replyToContent = replyTo?.text || replyTo?.caption;
    const replyToSenderName = replyTo
      ? replyTo.from?.first_name ||
        replyTo.from?.username ||
        replyTo.from?.id?.toString() ||
        'Unknown'
      : undefined;

    // Chat name for metadata store
    const chatName =
      ctx.chat.type === 'private'
        ? senderName
        : (ctx.chat as { title?: string }).title || chatJid;

    // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
    // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
    // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
    const botUsername = ctx.me?.username?.toLowerCase();
    if (botUsername) {
      const entities = ctx.message.entities || [];
      const isBotMentioned = entities.some((entity) => {
        if (entity.type === 'mention') {
          const mentionText = content
            .substring(entity.offset, entity.offset + entity.length)
            .toLowerCase();
          return mentionText === `@${botUsername}`;
        }
        return false;
      });
      if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    deps.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

    const group = deps.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Telegram chat',
      );
      return;
    }

    const locationContext = getActiveLiveLocationContext(chatJid);
    if (locationContext) content = locationContext + content;

    deps.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      thread_id: threadId ? threadId.toString() : undefined,
      reply_to_message_id: replyToMessageId,
      reply_to_message_content: replyToContent,
      reply_to_sender_name: replyToSenderName,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Telegram message stored',
    );
  });
}
