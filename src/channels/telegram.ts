import { Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import {
  normalizeTelegramUserId,
  type TelegramAccessController,
} from './telegram-access-control.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onRegisterMain: (
    chatJid: string,
    chatName: string,
  ) => Promise<RegisterMainResult> | RegisterMainResult;
  registeredGroups: () => Record<string, RegisteredGroup>;
  accessControl?: TelegramAccessController;
}

export type RegisterMainResult =
  | { status: 'registered' }
  | { status: 'already-main' }
  | { status: 'main-exists'; existingJid: string; existingName: string };

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private unauthorizedNoticeAt = new Map<string, number>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

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

    // Command to get user ID for access control management
    this.bot.command('myid', (ctx) => {
      const senderId = normalizeTelegramUserId(ctx.from?.id);
      if (!senderId) {
        ctx.reply('Unable to detect your Telegram user ID.');
        return;
      }
      ctx.reply(`Your Telegram user ID: \`${senderId}\``, {
        parse_mode: 'Markdown',
      });
    });

    // Set or transfer admin user for Telegram access control
    this.bot.command('set_admin', (ctx) => {
      const accessControl = this.opts.accessControl;
      if (!accessControl) {
        ctx.reply('Telegram access control is not configured.');
        return;
      }

      const requesterId = normalizeTelegramUserId(ctx.from?.id);
      const requestedAdminId =
        this.extractCommandArg(ctx) || requesterId || undefined;
      if (!requesterId || !requestedAdminId) {
        ctx.reply('Usage: /set_admin <telegram_user_id>');
        return;
      }

      const result = accessControl.setAdmin(requesterId, requestedAdminId);
      ctx.reply(result.message);
    });

    // Allow another Telegram user to use the bot
    this.bot.command('allow_user', (ctx) => {
      const accessControl = this.opts.accessControl;
      if (!accessControl) {
        ctx.reply('Telegram access control is not configured.');
        return;
      }

      const requesterId = normalizeTelegramUserId(ctx.from?.id);
      const targetUserId = this.extractCommandArg(ctx);
      if (!requesterId || !targetUserId) {
        ctx.reply('Usage: /allow_user <telegram_user_id>');
        return;
      }

      const result = accessControl.allowUser(requesterId, targetUserId);
      ctx.reply(result.message);
    });

    // Remove a Telegram user from allowed list
    this.bot.command('remove_user', (ctx) => {
      const accessControl = this.opts.accessControl;
      if (!accessControl) {
        ctx.reply('Telegram access control is not configured.');
        return;
      }

      const requesterId = normalizeTelegramUserId(ctx.from?.id);
      const targetUserId = this.extractCommandArg(ctx);
      if (!requesterId || !targetUserId) {
        ctx.reply('Usage: /remove_user <telegram_user_id>');
        return;
      }

      const result = accessControl.removeUser(requesterId, targetUserId);
      ctx.reply(result.message);
    });

    // List current admin and allowed users
    this.bot.command('list_users', (ctx) => {
      const accessControl = this.opts.accessControl;
      if (!accessControl) {
        ctx.reply('Telegram access control is not configured.');
        return;
      }

      const requesterId = normalizeTelegramUserId(ctx.from?.id);
      if (!requesterId || !accessControl.isAdmin(requesterId)) {
        const adminUserId = accessControl.getAdminUserId();
        if (adminUserId) {
          ctx.reply(`Only admin (${adminUserId}) can view allowed users.`);
        } else {
          ctx.reply('Admin is not set. Run /set_admin <telegram_user_id> first.');
        }
        return;
      }

      const adminUserId = accessControl.getAdminUserId();
      const allowedUserIds = accessControl.getAllowedUserIds();
      if (!adminUserId) {
        ctx.reply('Admin is not set. Run /set_admin <telegram_user_id> first.');
        return;
      }

      const users = allowedUserIds.length > 0 ? allowedUserIds.join(', ') : '(none)';
      ctx.reply(`Admin: ${adminUserId}\nAllowed users: ${users}`);
    });

    // Register current Telegram chat as NanoClaw main channel
    this.bot.command('register_main', async (ctx) => {
      const accessControl = this.opts.accessControl;
      const requesterId = normalizeTelegramUserId(ctx.from?.id);
      if (
        accessControl?.isEnabled() &&
        (!requesterId || !accessControl.isUserAllowed(requesterId))
      ) {
        await ctx.reply('You are not authorized to register main chat.');
        return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      const chatName =
        ctx.chat.type === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      const result = await this.opts.onRegisterMain(chatJid, chatName);
      if (result.status === 'registered') {
        await ctx.reply(
          `Main chat registered: ${chatJid}\nYou can now talk to ${ASSISTANT_NAME} here.`,
        );
        return;
      }

      if (result.status === 'already-main') {
        await ctx.reply('This chat is already registered as the main channel.');
        return;
      }

      await ctx.reply(
        `Main channel already exists: ${result.existingJid} (${result.existingName}).\n` +
          'Update that registration first if you want to switch main chat.',
      );
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = normalizeTelegramUserId(ctx.from?.id) || '';
      const msgId = ctx.message.message_id.toString();

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
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      if (!this.isUserAllowed(sender)) {
        await this.replyUnauthorized(ctx, chatJid, sender);
        logger.info(
          { chatJid, chatName, sender },
          'Blocked Telegram message from unauthorized user',
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
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = async (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const sender = normalizeTelegramUserId(ctx.from?.id) || '';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      if (!this.isUserAllowed(sender)) {
        await this.replyUnauthorized(ctx, chatJid, sender);
        logger.info(
          { chatJid, sender },
          'Blocked Telegram media message from unauthorized user',
        );
        return;
      }
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
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
            `  Send /chatid for chat ID and /register_main to set this chat as main\n`,
          );
          resolve();
        },
      });
    });
  }

  private extractCommandArg(ctx: any): string | null {
    const fromMatch = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (fromMatch) {
      const [first] = fromMatch.split(/\s+/);
      const normalized = normalizeTelegramUserId(first);
      return normalized || null;
    }

    const rawText = ctx.message?.text || '';
    const parts = rawText.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const normalized = normalizeTelegramUserId(parts[1]);
    return normalized || null;
  }

  private isUserAllowed(senderUserId: string): boolean {
    const accessControl = this.opts.accessControl;
    if (!accessControl) return true;
    return accessControl.isUserAllowed(senderUserId);
  }

  private shouldNotifyUnauthorized(chatJid: string, senderUserId: string): boolean {
    const key = `${chatJid}:${senderUserId}`;
    const now = Date.now();
    const lastNoticeAt = this.unauthorizedNoticeAt.get(key) || 0;
    if (now - lastNoticeAt < 60_000) {
      return false;
    }
    this.unauthorizedNoticeAt.set(key, now);
    return true;
  }

  private async replyUnauthorized(
    ctx: any,
    chatJid: string,
    senderUserId: string,
  ): Promise<void> {
    if (!this.shouldNotifyUnauthorized(chatJid, senderUserId)) return;
    const adminUserId = this.opts.accessControl?.getAdminUserId();
    const adminHint = adminUserId
      ? ` Ask admin (${adminUserId}) to run /allow_user ${senderUserId}.`
      : ' Ask admin to run /set_admin <telegram_user_id> first.';
    try {
      await ctx.reply(
        `Access denied for user ${senderUserId}. Use /myid to get your ID.${adminHint}`,
      );
    } catch (err) {
      logger.debug({ err, chatJid, senderUserId }, 'Failed to send unauthorized notice');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
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
}
