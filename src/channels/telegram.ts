import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';

const whisperEnv = readEnvFile(['OPENAI_API_KEY']);
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || whisperEnv.OPENAI_API_KEY || '';
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

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  /** Track processed update IDs to prevent duplicate handling during instance overlap */
  private processedUpdateIds = new Set<number>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Stop any previously running bot instance to prevent orphaned polling loops
    // (e.g. if connect() is called again after a reconnect)
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }

    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Delete any existing webhook before starting long polling.
    // Stale webhooks from prior deployments cause Telegram to deliver
    // updates via BOTH webhook and polling, producing duplicate messages.
    await this.bot.api.deleteWebhook();

    // Deduplicate updates: during Railway rolling deployments, the old and new
    // instances briefly overlap and both poll the same bot token. Telegram can
    // deliver the same update_id to both. This middleware skips already-seen updates.
    this.bot.use((ctx, next) => {
      const updateId = ctx.update.update_id;
      if (this.processedUpdateIds.has(updateId)) {
        logger.debug({ updateId }, 'Skipping duplicate Telegram update');
        return;
      }
      this.processedUpdateIds.add(updateId);
      // Prune old entries to prevent memory growth
      if (this.processedUpdateIds.size > 10000) {
        const ids = [...this.processedUpdateIds];
        this.processedUpdateIds = new Set(ids.slice(ids.length - 5000));
      }
      return next();
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

    this.bot.on('message:photo', async (ctx) => {
      // Download the highest-resolution photo
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      try {
        const file = await ctx.api.getFile(largest.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const ext = path.extname(file.file_path) || '.jpg';
          const filename = `photo-${Date.now()}${ext}`;

          // Find the group folder for this chat
          const groups = this.opts.registeredGroups();
          const chatJid = `tg:${ctx.chat.id}`;
          const group = groups[chatJid];
          const saveDir = group
            ? path.join(GROUPS_DIR, group.folder, 'inbox')
            : path.join(GROUPS_DIR, 'telegram_learning', 'inbox');
          fs.mkdirSync(saveDir, { recursive: true });
          const savePath = path.join(saveDir, filename);

          // Download the file
          const res = await fetch(url);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(savePath, buffer);
            logger.info(
              { chatJid, savePath, size: buffer.length },
              'Photo downloaded',
            );

            const caption = ctx.message.caption
              ? ` ${ctx.message.caption}`
              : '';
            const chatJidStr = `tg:${ctx.chat.id}`;
            const timestamp = new Date(ctx.message.date * 1000).toISOString();
            const senderName =
              ctx.from?.first_name || ctx.from?.username || 'Unknown';

            const isGroup =
              ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
            this.opts.onChatMetadata(
              chatJidStr,
              timestamp,
              undefined,
              'telegram',
              isGroup,
            );
            this.opts.onMessage(chatJidStr, {
              id: ctx.message.message_id.toString(),
              chat_jid: chatJidStr,
              sender: ctx.from?.id?.toString() || '',
              sender_name: senderName,
              content: `[Photo: inbox/${filename}]${caption}`,
              timestamp,
              is_from_me: false,
            });
            return;
          }
        }
      } catch (err) {
        logger.warn(
          { err },
          'Failed to download Telegram photo, falling back to placeholder',
        );
      }
      // Fallback if download fails
      storeNonText(ctx, '[Photo]');
    });
    this.bot.on('message:video', async (ctx) => {
      try {
        const video = ctx.message.video;
        const file = await ctx.api.getFile(video.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const ext = path.extname(file.file_path) || '.mp4';
          const filename = `video-${Date.now()}${ext}`;

          const groups = this.opts.registeredGroups();
          const chatJid = `tg:${ctx.chat.id}`;
          const group = groups[chatJid];
          const saveDir = group
            ? path.join(GROUPS_DIR, group.folder, 'inbox')
            : path.join(GROUPS_DIR, 'telegram_learning', 'inbox');
          fs.mkdirSync(saveDir, { recursive: true });
          const savePath = path.join(saveDir, filename);

          const res = await fetch(url);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(savePath, buffer);
            logger.info(
              { chatJid, savePath, size: buffer.length },
              'Video downloaded',
            );

            const caption = ctx.message.caption
              ? ` ${ctx.message.caption}`
              : '';
            const timestamp = new Date(ctx.message.date * 1000).toISOString();
            const senderName =
              ctx.from?.first_name || ctx.from?.username || 'Unknown';
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
              content: `[Video: inbox/${filename}]${caption}`,
              timestamp,
              is_from_me: false,
            });
            return;
          }
        }
      } catch (err) {
        logger.warn(
          { err },
          'Failed to download Telegram video, falling back to placeholder',
        );
      }
      storeNonText(ctx, '[Video]');
    });
    this.bot.on('message:voice', async (ctx) => {
      if (!OPENAI_API_KEY) {
        storeNonText(
          ctx,
          '[Voice message - no OPENAI_API_KEY for transcription]',
        );
        return;
      }
      try {
        const file = await ctx.api.getFile(ctx.message.voice.file_id);
        if (!file.file_path) throw new Error('No file_path');
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const audioRes = await fetch(url);
        if (!audioRes.ok)
          throw new Error(`Download failed: ${audioRes.status}`);
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

        // Call OpenAI Whisper API
        const boundary = `----formdata${Date.now()}`;
        const filename = `voice${path.extname(file.file_path) || '.ogg'}`;
        const formParts = [
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`,
          `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`,
          `--${boundary}--\r\n`,
        ];
        const body = Buffer.concat([
          Buffer.from(formParts[0]),
          audioBuffer,
          Buffer.from(formParts[1]),
          Buffer.from(formParts[2]),
        ]);

        const whisperRes = await fetch(
          'https://api.openai.com/v1/audio/transcriptions',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body,
          },
        );

        if (!whisperRes.ok) {
          const errText = await whisperRes.text();
          throw new Error(
            `Whisper API ${whisperRes.status}: ${errText.slice(0, 200)}`,
          );
        }

        const result = (await whisperRes.json()) as { text?: string };
        const transcript =
          result.text?.trim() || '[Voice message - empty transcription]';

        logger.info(
          { chatJid: `tg:${ctx.chat.id}`, length: transcript.length },
          'Voice message transcribed',
        );

        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        const chatJid = `tg:${ctx.chat.id}`;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name || ctx.from?.username || 'Unknown';
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
          content: `[Voice message] ${transcript}${caption}`,
          timestamp,
          is_from_me: false,
        });
      } catch (err) {
        logger.warn({ err }, 'Voice transcription failed, storing placeholder');
        storeNonText(ctx, '[Voice message - transcription failed]');
      }
    });
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

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
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
