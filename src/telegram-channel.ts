/**
 * Telegram Channel for NanoClaw
 *
 * Connects to Telegram via Grammy bot framework using long polling.
 * Receives messages and routes them through the standard message pipeline.
 */
import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';

import { TRIGGER_PATTERN, TELEGRAM_OWNER_ID } from './config.js';
import { logger } from './logger.js';

export interface TelegramButton {
  text: string;
  callback?: string;
  url?: string;
}

export interface TelegramChannelDeps {
  onMessage: (
    chatJid: string,
    chatName: string,
    senderId: string,
    senderName: string,
    content: string,
    messageId: string,
  ) => void;
}

export class TelegramChannel {
  private bot: Bot;
  private botUsername = '';

  constructor(
    token: string,
    private deps: TelegramChannelDeps,
  ) {
    this.bot = new Bot(token);
  }

  getBotUsername(): string {
    return this.botUsername;
  }

  async start(): Promise<void> {
    const me = await this.bot.api.getMe();
    this.botUsername = me.username || '';
    logger.info(
      { username: this.botUsername },
      'Telegram bot identity resolved',
    );

    this.bot.on('message:text', (ctx) => {
      // Only accept messages from the configured owner
      if (TELEGRAM_OWNER_ID && String(ctx.from.id) !== TELEGRAM_OWNER_ID) {
        return;
      }

      const chatId = ctx.chat.id;
      const chatJid = `tg:${chatId}`;
      const isPrivate = ctx.chat.type === 'private';
      const content = ctx.message.text;

      // In groups, only process messages that mention the bot or match the trigger
      if (!isPrivate) {
        const mentionsBot = (ctx.message.entities || []).some(
          (e) =>
            e.type === 'mention' &&
            content.slice(e.offset, e.offset + e.length).toLowerCase() ===
              `@${this.botUsername.toLowerCase()}`,
        );
        if (!mentionsBot && !TRIGGER_PATTERN.test(content)) return;
      }

      const senderId = `tg:${ctx.from.id}`;
      const senderName =
        ctx.from.first_name +
        (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
      const messageId = String(ctx.message.message_id);
      const chatName = isPrivate
        ? senderName
        : ctx.chat.title || `Group ${chatId}`;

      this.deps.onMessage(
        chatJid,
        chatName,
        senderId,
        senderName,
        content,
        messageId,
      );
    });

    this.bot.on('callback_query:data', async (ctx) => {
      if (TELEGRAM_OWNER_ID && String(ctx.from.id) !== TELEGRAM_OWNER_ID) {
        await ctx.answerCallbackQuery();
        return;
      }

      const callbackData = ctx.callbackQuery.data;
      const chatId = ctx.callbackQuery.message?.chat.id;
      const messageId = ctx.callbackQuery.message?.message_id;

      await ctx.answerCallbackQuery();

      // Edit the original message: remove buttons, show selection
      if (chatId && messageId) {
        const originalText = ctx.callbackQuery.message?.text || '';
        try {
          await this.bot.api.editMessageText(
            chatId,
            messageId,
            `${originalText}\n\n_Selected: ${callbackData}_`,
            { parse_mode: 'Markdown' },
          );
        } catch {
          try {
            await this.bot.api.editMessageReplyMarkup(chatId, messageId);
          } catch {
            // Best effort
          }
        }
      }

      // Route callback to message pipeline
      if (chatId) {
        const chatJid = `tg:${chatId}`;
        const senderId = `tg:${ctx.from.id}`;
        const senderName =
          ctx.from.first_name +
          (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
        const cbMessageId = `cb-${messageId}-${Date.now()}`;
        const isPrivate = ctx.callbackQuery.message?.chat.type === 'private';
        const chatName = isPrivate
          ? senderName
          : (ctx.callbackQuery.message?.chat as { title?: string }).title ||
            `Group ${chatId}`;

        this.deps.onMessage(
          chatJid,
          chatName,
          senderId,
          `${senderName} [button]`,
          callbackData,
          cbMessageId,
        );
      }
    });

    this.bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) {
        logger.error({ description: e.description }, 'Telegram API error');
      } else if (e instanceof HttpError) {
        logger.error({ err: e }, 'Telegram network error');
      } else {
        logger.error({ err: e }, 'Telegram handler error');
      }
    });

    // Long polling — Grammy handles reconnection automatically
    this.bot.start({
      onStart: () => logger.info('Telegram bot polling started'),
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(Number(chatId), text, {
        parse_mode: 'Markdown',
      });
    } catch {
      // Markdown parsing can fail on unescaped special characters — fall back to plain text
      await this.bot.api.sendMessage(Number(chatId), text);
    }
  }

  async sendMessageWithButtons(
    chatId: string,
    text: string,
    buttons: TelegramButton[][],
  ): Promise<void> {
    const keyboard = new InlineKeyboard();
    for (const row of buttons) {
      for (const btn of row) {
        if (btn.callback) {
          keyboard.text(btn.text, btn.callback);
        } else if (btn.url) {
          keyboard.url(btn.text, btn.url);
        }
      }
      keyboard.row();
    }

    try {
      await this.bot.api.sendMessage(Number(chatId), text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch {
      await this.bot.api.sendMessage(Number(chatId), text, {
        reply_markup: keyboard,
      });
    }
  }

  async setTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(chatId), 'typing');
  }

  stop(): void {
    this.bot.stop();
  }
}
