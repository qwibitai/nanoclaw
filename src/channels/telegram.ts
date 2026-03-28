import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { contentPartsToText, processContentParts } from '../media.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  ContentPart,
  OnChatMetadata,
  OnInboundMessage,
  RawContentPart,
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

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private async getFileUrl(fileId: string): Promise<string> {
    const file = await this.bot!.api.getFile(fileId);
    return `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
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

    const handleMedia = async (
      ctx: any,
      buildParts: () => Promise<RawContentPart[]>,
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
      const sender = ctx.from?.id?.toString() || '';
      const msgId = ctx.message.message_id.toString();

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const rawParts: RawContentPart[] = [];
      if (ctx.message.caption)
        rawParts.push({ type: 'text', text: ctx.message.caption });

      try {
        rawParts.push(...(await buildParts()));
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to get Telegram file URL');
        return;
      }

      let contentParts: ContentPart[] | undefined;
      try {
        contentParts = await processContentParts(rawParts, group.folder, msgId);
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to process content parts');
      }

      const content =
        ctx.message.caption ||
        (contentParts ? contentPartsToText(contentParts) : '');
      if (!content) return;

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        content_parts: contentParts,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) =>
      handleMedia(ctx, async () => {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const ref = await this.getFileUrl(largest.file_id);
        return [{ type: 'image', ref, mimetype: 'image/jpeg' }];
      }),
    );

    this.bot.on('message:video', (ctx) =>
      handleMedia(ctx, async () => {
        const ref = await this.getFileUrl(ctx.message.video.file_id);
        return [
          {
            type: 'video',
            ref,
            mimetype: ctx.message.video.mime_type || undefined,
          },
        ];
      }),
    );

    this.bot.on('message:voice', (ctx) =>
      handleMedia(ctx, async () => {
        const ref = await this.getFileUrl(ctx.message.voice.file_id);
        return [
          {
            type: 'voice',
            ref,
            mimetype: ctx.message.voice.mime_type || undefined,
          },
        ];
      }),
    );

    this.bot.on('message:audio', (ctx) =>
      handleMedia(ctx, async () => {
        const ref = await this.getFileUrl(ctx.message.audio.file_id);
        return [
          {
            type: 'audio',
            ref,
            mimetype: ctx.message.audio.mime_type || undefined,
          },
        ];
      }),
    );

    this.bot.on('message:document', (ctx) =>
      handleMedia(ctx, async () => {
        const doc = ctx.message.document;
        const ref = await this.getFileUrl(doc.file_id);
        return [
          {
            type: 'file',
            ref,
            filename: doc.file_name || 'document',
            mimetype: doc.mime_type || undefined,
          },
        ];
      }),
    );

    this.bot.on('message:sticker', (ctx) =>
      handleMedia(ctx, async () => {
        const sticker = ctx.message.sticker;
        const ref = await this.getFileUrl(sticker.file_id);
        const mimetype = sticker.is_video
          ? 'video/webm'
          : sticker.is_animated
            ? 'application/gzip'
            : 'image/webp';
        return [{ type: 'sticker', ref, mimetype }];
      }),
    );

    this.bot.on('message:location', (ctx) =>
      handleMedia(ctx, async () => [
        {
          type: 'location',
          lat: ctx.message.location.latitude,
          lng: ctx.message.location.longitude,
        },
      ]),
    );

    this.bot.on('message:contact', (ctx) =>
      handleMedia(ctx, async () => [
        {
          type: 'contact',
          data: {
            displayName: [
              ctx.message.contact.first_name,
              ctx.message.contact.last_name,
            ]
              .filter(Boolean)
              .join(' '),
            vcard: ctx.message.contact.vcard || '',
          },
        },
      ]),
    );

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
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
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
