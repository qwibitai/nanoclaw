import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN, GROUPS_DIR } from '../config.js';
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
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

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

    // Handle non-text messages — download media when possible.
    const storeNonText = async (
      ctx: any,
      placeholder: string,
      download?: { fileId: string; label: string; prefix: string; extension: string },
    ) => {
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
      const messageId = ctx.message.message_id.toString();

      let content: string;
      if (download) {
        const savedPath = await this.downloadMedia(
          group.folder,
          download.fileId,
          download.prefix,
          download.extension,
          messageId,
        );
        if (savedPath) {
          content = `[${download.label} saved: ${savedPath}]${caption}`;
        } else {
          content = `${placeholder}${caption}`;
        }
      } else {
        content = `${placeholder}${caption}`;
      }

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
      this.opts.onMessage(chatJid, {
        id: messageId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => {
      const photos = ctx.message.photo!;
      const largest = photos[photos.length - 1];
      return storeNonText(ctx, '[Photo]', {
        fileId: largest.file_id,
        label: 'Photo',
        prefix: 'photo',
        extension: '.jpg',
      });
    });

    this.bot.on('message:video', (ctx) =>
      storeNonText(ctx, '[Video]', {
        fileId: ctx.message.video!.file_id,
        label: 'Video',
        prefix: 'video',
        extension: '.mp4',
      })
    );

    this.bot.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]', {
        fileId: ctx.message.voice!.file_id,
        label: 'Voice message',
        prefix: 'voice',
        extension: '.ogg',
      })
    );

    this.bot.on('message:audio', (ctx) =>
      storeNonText(ctx, '[Audio]', {
        fileId: ctx.message.audio!.file_id,
        label: 'Audio',
        prefix: 'audio',
        extension: '.mp3',
      })
    );

    this.bot.on('message:document', (ctx) => {
      const doc = ctx.message.document!;
      const name = path.basename(doc.file_name || 'file').replace(/[\x00-\x1f]/g, '');
      const ext = path.extname(name) || '.bin';
      return storeNonText(ctx, `[Document: ${name}]`, {
        fileId: doc.file_id,
        label: 'Document',
        prefix: 'document',
        extension: ext,
      });
    });

    this.bot.on('message:sticker', (ctx) => {
      const sticker = ctx.message.sticker!;
      const emoji = sticker.emoji || '';
      return storeNonText(ctx, `[Sticker ${emoji}]`, {
        fileId: sticker.file_id,
        label: 'Sticker',
        prefix: 'sticker',
        extension: '.webp',
      });
    });

    // Location and contact have no downloadable file
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

  private async downloadMedia(
    groupFolder: string,
    fileId: string,
    prefix: string,
    extension: string,
    messageId: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);

      if (file.file_size && file.file_size > 20 * 1024 * 1024) {
        logger.warn({ fileId, size: file.file_size }, 'Telegram file exceeds 20MB limit');
        return null;
      }

      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      // SECURITY: This URL contains the bot token — never log it
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn({ fileId, status: response.status }, 'Telegram file download failed');
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
      await fs.mkdir(mediaDir, { recursive: true });

      const filename = `${prefix}_${messageId}${extension}`;
      const filePath = path.join(mediaDir, filename);
      await fs.writeFile(filePath, buffer);

      logger.info({ fileId, filePath }, 'Telegram media file saved');
      return `media/${filename}`;
    } catch (err) {
      logger.warn({ fileId, err }, 'Failed to download Telegram media');
      return null;
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
