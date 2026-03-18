import { Bot, type Context } from 'grammy';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  isTranscriptionAvailable,
  transcribeAudio,
} from '../transcription.js';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot;
  private connected = false;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;

  constructor(opts: ChannelOpts, token: string) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;

    this.bot = new Bot(token);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.bot.on('message', async (ctx: Context) => {
      try {
        await this.handleMessage(ctx);
      } catch (err) {
        logger.error(
          { err, chatId: ctx.chat?.id },
          'Error processing Telegram message',
        );
      }
    });

    this.bot.catch((err) => {
      logger.error({ err }, 'Grammy error handler');
    });
  }

  private async handleMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.from || !ctx.message) return;

    const chatJid = `tg:${ctx.chat.id}`;
    const timestamp = new Date(ctx.message.date * 1000).toISOString();

    const isGroup =
      ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const chatName =
      isGroup && 'title' in ctx.chat
        ? ctx.chat.title
        : ctx.from.first_name;

    // Always emit metadata for chat discovery
    this.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

    // Only deliver full message for registered groups
    const groups = this.registeredGroups();
    if (!groups[chatJid]) return;

    // Extract text content
    let content =
      ctx.message.text || ctx.message.caption || '';

    // Handle voice/audio messages
    if (!content && (ctx.message.voice || ctx.message.audio)) {
      const fileInfo = ctx.message.voice || ctx.message.audio;
      if (fileInfo && isTranscriptionAvailable()) {
        try {
          const file = await ctx.api.getFile(fileInfo.file_id);
          if (file.file_path) {
            const url = `https://api.telegram.org/file/bot${this.bot.token}/` +
              file.file_path;
            const response = await fetch(url);
            const buffer = Buffer.from(await response.arrayBuffer());
            const ext = file.file_path.split('.').pop() || 'ogg';
            const transcription = await transcribeAudio(
              buffer,
              `voice.${ext}`,
            );
            if (transcription) {
              content = `[Voice: ${transcription}]`;
            }
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to download/transcribe Telegram voice');
        }
      }
      if (!content) {
        content = '[Voice message - transcription unavailable]';
      }
    }

    // Skip messages with no content
    if (!content) return;

    const sender = ctx.from.username
      ? `@${ctx.from.username}`
      : String(ctx.from.id);
    const senderName =
      ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');

    // Detect if this message is from the bot itself
    const botInfo = this.bot.botInfo;
    const isSelf = botInfo && ctx.from.id === botInfo.id;

    const message: NewMessage = {
      id: String(ctx.message.message_id),
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isSelf || false,
      is_bot_message: isSelf || false,
    };

    this.onMessage(chatJid, message);
  }

  async connect(): Promise<void> {
    try {
      await this.bot.init();
      logger.info(
        { username: this.bot.botInfo.username },
        'Telegram bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Telegram bot');
      throw err;
    }

    // Start polling in background (non-blocking)
    this.bot.start({
      onStart: () => {
        this.connected = true;
        logger.info('Telegram bot started polling');
      },
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = Number(jid.slice(3));
    if (isNaN(chatId)) {
      logger.warn({ jid }, 'Invalid Telegram JID');
      return;
    }

    // Split long messages at Telegram's 4096 char limit
    const chunks = splitMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(chatId, chunk);
    }
    logger.info({ jid, length: text.length }, 'Telegram message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.bot.stop();
    logger.info('Telegram bot stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    try {
      const chatId = Number(jid.slice(3));
      await this.bot.api.sendChatAction(chatId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async syncGroups(): Promise<void> {
    // Telegram delivers chat names inline with messages; no batch sync needed.
  }
}

/**
 * Split a message into chunks respecting a max length.
 * Tries to split at the last newline before the limit.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at last newline before limit
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0) splitIdx = maxLength;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}

// Self-register
registerChannel('telegram', (opts: ChannelOpts) => {
  const secrets = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  if (!secrets.TELEGRAM_BOT_TOKEN) {
    logger.warn('Telegram channel disabled (TELEGRAM_BOT_TOKEN not set)');
    return null;
  }

  try {
    return new TelegramChannel(opts, secrets.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    logger.error({ err }, 'Failed to create Telegram channel');
    return null;
  }
});
