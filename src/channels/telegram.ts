import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { downloadFile } from '../download.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
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

/**
 * Split long messages at the 4096-char Telegram limit and send each chunk.
 * Shared between TelegramChannel.sendMessage() and BotPool.send().
 */
async function sendWithSplit(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
): Promise<void> {
  const numericId =
    typeof chatId === 'string' ? chatId.replace(/^tg:/, '') : chatId;
  const MAX_LENGTH = 4096;
  if (text.length <= MAX_LENGTH) {
    await sendTelegramMessage(api, numericId, text);
  } else {
    for (let i = 0; i < text.length; i += MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text.slice(i, i + MAX_LENGTH));
    }
  }
}

export interface BotPoolDeps {
  createApi: (token: string) => Api;
  renameDelayMs: number;
}

const DEFAULT_DEPS: BotPoolDeps = {
  createApi: (token: string) => new Api(token),
  // Telegram rate-limits setMyName; wait after rename so the new name
  // is visible before the first message arrives in the chat.
  renameDelayMs: 2000,
};

// NOTE: setMyName is a global Telegram API operation — it changes the bot's
// display name for ALL chats, not per-chat. When the same bot is assigned to
// different senders across groups (via round-robin wrap), its name will flip
// between roles. This is a Telegram API limitation, not a bug.
export class BotPool {
  private apis: Api[] = [];
  private senderMap = new Map<string, number>();
  private nextIndex = 0;
  private deps: BotPoolDeps;

  constructor(deps: Partial<BotPoolDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  async init(tokens: string[]): Promise<void> {
    for (const token of tokens) {
      try {
        const api = this.deps.createApi(token);
        const me = await api.getMe();
        this.apis.push(api);
        logger.info(
          { username: me.username, id: me.id, poolSize: this.apis.length },
          'Pool bot initialized',
        );
      } catch (err) {
        logger.error({ err }, 'Failed to initialize pool bot');
      }
    }
    if (this.apis.length > 0) {
      logger.info({ count: this.apis.length }, 'Telegram bot pool ready');
    }
  }

  async send(
    chatId: string,
    text: string,
    sender: string,
    groupFolder: string,
  ): Promise<boolean> {
    if (this.apis.length === 0) {
      return false; // Signal caller to use fallback
    }

    const key = `${groupFolder}:${sender}`;
    let idx = this.senderMap.get(key);
    if (idx === undefined) {
      idx = this.nextIndex % this.apis.length;
      this.nextIndex++;
      this.senderMap.set(key, idx);
      try {
        await this.apis[idx].setMyName(sender);
        if (this.deps.renameDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.deps.renameDelayMs));
        }
        logger.info(
          { sender, groupFolder, poolIndex: idx },
          'Assigned and renamed pool bot',
        );
      } catch (err) {
        logger.warn(
          { sender, err },
          'Failed to rename pool bot (sending anyway)',
        );
      }
    }

    const api = this.apis[idx];
    await sendWithSplit(api, chatId, text);
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
    return true;
  }

  get size(): number {
    return this.apis.length;
  }

  getAssignment(sender: string, groupFolder: string): number | undefined {
    return this.senderMap.get(`${groupFolder}:${sender}`);
  }

  reset(): void {
    this.apis = [];
    this.senderMap.clear();
    this.nextIndex = 0;
  }
}

// Singleton instance and convenience functions
export const botPool = new BotPool();

export async function initBotPool(tokens: string[]): Promise<void> {
  await botPool.init(tokens);
}

export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<boolean> {
  return botPool.send(chatId, text, sender, groupFolder);
}

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

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Try to download the photo so the agent can actually see it
      try {
        const photos = ctx.message.photo;
        // Telegram provides multiple sizes; last is largest
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);

        if (!file.file_path)
          throw new Error('No file_path in Telegram response');

        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const groupDir = resolveGroupFolderPath(group.folder);
        const imagesDir = path.join(groupDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });

        const ext = path.extname(file.file_path) || '.jpg';
        const filename = `photo-${ctx.message.message_id}${ext}`;
        const filePath = path.join(imagesDir, filename);

        await downloadFile(url, filePath);

        const containerPath = `/workspace/group/images/${filename}`;
        logger.info({ chatJid, filePath }, 'Downloaded Telegram photo');

        storeNonText(ctx, `[Image: ${containerPath} — use Read tool to view]`);
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to download Telegram photo');
        // Fallback to placeholder if download fails
        storeNonText(ctx, '[Photo]');
      }
    });
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
      await sendWithSplit(this.bot.api, jid, text);
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendImage(
    jid: string,
    imagePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const file = new InputFile(imagePath);
      await this.bot.api.sendPhoto(numericId, file, {
        caption,
        ...(caption ? { parse_mode: 'Markdown' as const } : {}),
      });
      logger.info({ jid, imagePath }, 'Telegram image sent');
    } catch (err) {
      logger.error({ jid, imagePath, err }, 'Failed to send Telegram image');
      // Fallback: notify user that the image couldn't be sent
      const fallbackText = caption
        ? `${caption}\n\n(Image could not be sent)`
        : '(Image could not be sent)';
      await this.sendMessage(jid, fallbackText);
    }
  }

  async sendDocument(
    jid: string,
    documentPath: string,
    filename?: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const file = new InputFile(documentPath, filename);
      await this.bot.api.sendDocument(numericId, file, {
        caption,
        ...(caption ? { parse_mode: 'Markdown' as const } : {}),
      });
      logger.info({ jid, documentPath }, 'Telegram document sent');
    } catch (err) {
      logger.error(
        { jid, documentPath, err },
        'Failed to send Telegram document',
      );
      const fallbackText = caption
        ? `${caption}\n\n(Document could not be sent)`
        : '(Document could not be sent)';
      await this.sendMessage(jid, fallbackText);
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
