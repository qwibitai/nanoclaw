import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  InlineButton,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
  buttons?: InlineButton[][],
): Promise<number | undefined> {
  const replyMarkup = buttons?.length
    ? {
        inline_keyboard: buttons.map((row) =>
          row.map((btn) => ({
            text: btn.text,
            callback_data: btn.data.slice(0, 64),
          })),
        ),
      }
    : undefined;
  try {
    const msg = await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup,
    });
    return msg.message_id;
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    const msg = await api.sendMessage(chatId, text, {
      ...options,
      reply_markup: replyMarkup,
    });
    return msg.message_id;
  }
}

// --- Bot pool for agent teams ---
// Send-only Api instances, one per pool bot token
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool index for stable per-sender assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Call once at startup with the tokens from TELEGRAM_BOT_POOL.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the same
 * sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    logger.warn(
      { chatId, sender },
      'Pool message dropped: no pool bots initialized',
    );
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  // Last bot message ID per chat, used to detect 👎 reactions for retry
  private lastBotMessageId = new Map<string, number>();
  // Maps callback_data → human-readable button label for display in chat
  private buttonLabels = new Map<string, string>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
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

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

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

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle emoji reactions — 👎 on the last bot message triggers a retry
    this.bot.on('message_reaction', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const reactedMsgId = ctx.messageReaction.message_id;
      const lastBotMsgId = this.lastBotMessageId.get(chatJid);
      if (reactedMsgId !== lastBotMsgId) return;

      const hasThumbsDown = ctx.messageReaction.new_reaction.some(
        (r) => r.type === 'emoji' && r.emoji === '👎',
      );
      if (!hasThumbsDown) return;

      const user = ctx.messageReaction.user;
      const senderName =
        user?.first_name || user?.username || user?.id.toString() || 'User';
      const sender = user?.id.toString() || '';
      const timestamp = new Date().toISOString();

      logger.info({ chatJid }, 'Thumbs-down reaction — triggering retry');
      this.opts.onMessage(chatJid, {
        id: `reaction-retry-${Date.now()}`,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content:
          '[👎 on your last response — please try again with a different approach]',
        timestamp,
        is_from_me: false,
      });
    });

    // Handle inline button presses — deliver the button data as a user message
    this.bot.on('callback_query:data', async (ctx) => {
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.from.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      // Always answer the callback to remove the spinner
      await ctx.answerCallbackQuery().catch(() => {});

      // Remove the inline keyboard from the original message so it can't be pressed again
      await ctx
        .editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
        .catch(() => {});

      if (!group) return;

      const data = ctx.callbackQuery.data;
      const label = this.buttonLabels.get(data) ?? data;
      const user = ctx.callbackQuery.from;
      const senderName = user.first_name || user.username || user.id.toString();
      const timestamp = new Date().toISOString();

      logger.info({ chatJid, label }, 'Button pressed');
      this.opts.onMessage(chatJid, {
        id: `btn-${Date.now()}`,
        chat_jid: chatJid,
        sender: user.id.toString(),
        sender_name: senderName,
        content: data,
        timestamp,
        is_from_me: false,
      });
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
    buttons?: InlineButton[][],
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    // Store button label→data mapping so callback_query handler can display the label
    if (buttons) {
      for (const row of buttons) {
        for (const btn of row) {
          this.buttonLabels.set(btn.data.slice(0, 64), btn.text);
        }
      }
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed.
      // Buttons only attach to the last chunk.
      const MAX_LENGTH = 4096;
      let lastSentId: number | undefined;
      if (text.length <= MAX_LENGTH) {
        lastSentId = await sendTelegramMessage(
          this.bot.api,
          numericId,
          text,
          options,
          buttons,
        );
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const isLast = i + MAX_LENGTH >= text.length;
          lastSentId = await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
            isLast ? buttons : undefined,
          );
        }
      }
      if (lastSentId !== undefined) {
        this.lastBotMessageId.set(jid, lastSentId);
      }
      logger.info(
        { jid, length: text.length, threadId, hasButtons: !!buttons },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async setReaction(
    jid: string,
    messageId: string,
    emoji: string | null,
  ): Promise<void> {
    if (!this.bot) return;
    const numericId = parseInt(jid.replace(/^tg:/, ''), 10);
    const numericMsgId = parseInt(messageId, 10);
    // Use fetch directly to guarantee reaction:[] is sent as an explicit empty
    // array (some grammy versions omit falsy/empty parameters from the body).
    const body = JSON.stringify({
      chat_id: numericId,
      message_id: numericMsgId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    });
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/setMessageReaction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
      );
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) {
        logger.warn(
          { jid, messageId, emoji, description: json.description },
          'Telegram setMessageReaction failed',
        );
      } else {
        logger.info(
          { jid, messageId, emoji: emoji ?? 'cleared' },
          'Reaction updated',
        );
      }
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to set Telegram reaction',
      );
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
