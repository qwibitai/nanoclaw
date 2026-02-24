import { Bot, Api } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Bot pool state for Agent Swarm
let poolApis: Api[] = [];
const senderBotMap: Map<string, { botIndex: number; botName: string }> = new Map();
let nextPoolIndex = 0;

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Whitelist: only allow specific user IDs
    const allowedUsers = (process.env.ALLOWED_TELEGRAM_USERS || '')
      .split(',')
      .map(id => parseInt(id.trim()))
      .filter(id => !isNaN(id));

    const isAllowed = (userId: number | undefined): boolean => {
      if (!userId) return false;
      if (allowedUsers.length === 0) return true; // No whitelist = allow all
      return allowedUsers.includes(userId);
    };

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      if (!isAllowed(ctx.from?.id)) {
        ctx.reply('Unauthorized');
        return;
      }
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'MarkdownV2' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      if (!isAllowed(ctx.from?.id)) {
        ctx.reply('Unauthorized');
        return;
      }
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to check system status
    this.bot.command('status', async (ctx) => {
      if (!isAllowed(ctx.from?.id)) {
        ctx.reply('Unauthorized');
        return;
      }
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const memory = process.memoryUsage();
      const memMB = Math.round(memory.heapUsed / 1024 / 1024);

      // Read Claude Code usage (if available)
      let claudeUsage = '';
      try {
        const usageFile = '/tmp/nanoclaw_claude_usage.txt';
        if (fs.existsSync(usageFile)) {
          claudeUsage = fs.readFileSync(usageFile, 'utf-8').trim();
        }
      } catch (e) {
        // Ignore errors
      }

      let statusMsg = `*${ASSISTANT_NAME} Status*\n\n` +
        `Uptime: ${hours}h ${minutes}m\n` +
        `Memory: ${memMB} MB\n` +
        `Node: ${process.version}`;

      if (claudeUsage) {
        statusMsg += `\nClaude: ${claudeUsage}`;
      }

      await ctx.reply(statusMsg, { parse_mode: 'MarkdownV2' });
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      // Check whitelist for messages
      if (!isAllowed(ctx.from?.id)) {
        logger.debug({ userId: ctx.from?.id }, 'Unauthorized Telegram user');
        return;
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

      this.opts.onChatMetadata(chatJid, timestamp);
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
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
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
        await this.bot.api.sendMessage(numericId, text, { parse_mode: 'MarkdownV2' });
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
            { parse_mode: 'MarkdownV2' },
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

/**
 * Initialize the bot pool for Agent Swarm.
 * Creates send-only Api instances for each pool token.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  poolApis = tokens.map((token) => new Api(token));
  senderBotMap.clear();
  nextPoolIndex = 0;
  logger.info({ poolSize: tokens.length }, 'Pool bots initialized');
}

/**
 * Send a message through a pool bot, assigning one per sender.
 * Falls back to main bot if no pool is configured.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    logger.warn('No pool bots available, using main bot');
    return;
  }

  try {
    const numericId = chatId.replace(/^tg:/, '');
    const senderKey = `${groupFolder}:${sender}`;

    // Assign pool bot to sender round-robin if not already assigned
    let botInfo = senderBotMap.get(senderKey);
    if (!botInfo) {
      const botIndex = nextPoolIndex % poolApis.length;
      botInfo = {
        botIndex,
        botName: sender, // Will be updated when we get the actual bot name
      };
      senderBotMap.set(senderKey, botInfo);
      nextPoolIndex++;
    }

    const poolApi = poolApis[botInfo.botIndex];

    // Attempt to rename bot to sender name
    try {
      await poolApi.setMyName(sender);
      logger.debug({ sender, chatId }, 'Pool bot renamed');
    } catch (err) {
      logger.debug({ sender, chatId, err }, 'Failed to rename pool bot (may not have permissions)');
    }

    // Send message through the assigned pool bot
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await poolApi.sendMessage(numericId, text, { parse_mode: 'MarkdownV2' });
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await poolApi.sendMessage(numericId, text.slice(i, i + MAX_LENGTH), { parse_mode: 'MarkdownV2' });
      }
    }
    logger.info({ jid: chatId, sender, poolIndex: botInfo.botIndex }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}
