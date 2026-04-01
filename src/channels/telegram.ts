import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
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

/** A named bot instance with its own token and API. */
interface BotInstance {
  name: string;
  bot: Bot;
}

/**
 * Parse TELEGRAM_BOTS config string into name→token pairs.
 * Format: "pip:token123,pickle:token456"
 */
export function parseBotConfig(
  botsConfig: string | undefined,
  legacyToken: string | undefined,
): Array<{ name: string; token: string }> {
  if (botsConfig) {
    return botsConfig
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const colonIdx = entry.indexOf(':');
        if (colonIdx === -1) {
          throw new Error(
            `Invalid TELEGRAM_BOTS entry "${entry}" — expected "name:token"`,
          );
        }
        return {
          name: entry.slice(0, colonIdx).trim(),
          token: entry.slice(colonIdx + 1).trim(),
        };
      });
  }

  if (legacyToken) {
    return [{ name: 'default', token: legacyToken }];
  }

  return [];
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
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bots: Map<string, BotInstance> = new Map();
  private defaultBotName: string;
  private opts: TelegramChannelOpts;
  private botConfigs: Array<{ name: string; token: string }>;

  constructor(
    botConfigs: Array<{ name: string; token: string }>,
    opts: TelegramChannelOpts,
  ) {
    this.botConfigs = botConfigs;
    this.opts = opts;
    this.defaultBotName = botConfigs[0]?.name || 'default';
  }

  async connect(): Promise<void> {
    for (const config of this.botConfigs) {
      const bot = new Bot(config.token, {
        client: {
          baseFetchConfig: { agent: https.globalAgent, compress: true },
        },
      });

      this.setupBotHandlers(bot, config.name);

      const instance: BotInstance = { name: config.name, bot };
      this.bots.set(config.name, instance);

      // Start polling — each bot polls independently
      await new Promise<void>((resolve) => {
        bot.start({
          onStart: (botInfo) => {
            logger.info(
              { botName: config.name, username: botInfo.username, id: botInfo.id },
              'Telegram bot connected',
            );
            console.log(`\n  Telegram bot "${config.name}": @${botInfo.username}`);
            resolve();
          },
        });
      });
    }

    if (this.bots.size > 0) {
      console.log(
        `  Send /chatid to any bot to get a chat's registration ID\n`,
      );
    }
  }

  private setupBotHandlers(bot: Bot, botName: string): void {
    // Command to get chat ID (useful for registration)
    bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nBot: ${botName}\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} (${botName}) is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

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
      });

      logger.info(
        { chatJid, chatName, sender: senderName, bot: botName },
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

    bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    bot.catch((err) => {
      logger.error({ botName, err: err.message }, 'Telegram bot error');
    });
  }

  /**
   * Resolve which bot instance should send to a given JID.
   * Uses the registered group's `bot` field, falling back to the default bot.
   */
  private getBotForJid(jid: string): BotInstance | undefined {
    const group = this.opts.registeredGroups()[jid];
    const botName = group?.bot || this.defaultBotName;
    return this.bots.get(botName) || this.bots.values().next().value;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const instance = this.getBotForJid(jid);
    if (!instance) {
      logger.warn('No Telegram bot available');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(instance.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            instance.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info(
        { jid, length: text.length, bot: instance.name },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, bot: instance.name, err }, 'Failed to send Telegram message');
    }
  }

  async pinMessage(jid: string, messageId: string): Promise<void> {
    const instance = this.getBotForJid(jid);
    if (!instance) {
      logger.warn('No Telegram bot available for pinMessage');
      return;
    }

    try {
      const numericChatId = jid.replace(/^tg:/, '');
      await instance.bot.api.pinChatMessage(
        Number(numericChatId),
        Number(messageId),
        { disable_notification: true },
      );
      logger.info(
        { jid, messageId, bot: instance.name },
        'Telegram message pinned',
      );
    } catch (err) {
      logger.error(
        { jid, messageId, bot: instance.name, err },
        'Failed to pin Telegram message',
      );
    }
  }

  isConnected(): boolean {
    return this.bots.size > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const [name, instance] of this.bots) {
      instance.bot.stop();
      logger.info({ botName: name }, 'Telegram bot stopped');
    }
    this.bots.clear();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const instance = this.getBotForJid(jid);
    if (!instance) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await instance.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOTS']);
  const botsConfig =
    process.env.TELEGRAM_BOTS || envVars.TELEGRAM_BOTS || undefined;
  const legacyToken =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || undefined;

  const configs = parseBotConfig(botsConfig, legacyToken);
  if (configs.length === 0) {
    logger.warn('Telegram: no bot tokens configured (TELEGRAM_BOTS or TELEGRAM_BOT_TOKEN)');
    return null;
  }

  return new TelegramChannel(configs, opts);
});
