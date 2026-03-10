/**
 * Telegram channel — Grammy-based bot for receiving and sending messages.
 *
 * JID format: tg:{chat_id}
 *
 * Self-registers at import time via registerChannel().
 * Returns null from factory when TELEGRAM_BOT_TOKEN is not configured.
 */

import { Bot, Context } from 'grammy';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const MAX_LENGTH = 4096;

function buildNewMessage(ctx: Context, content: string): NewMessage {
  const msg = ctx.message!;
  const from = msg.from!;
  const senderName =
    [from.first_name, from.last_name].filter(Boolean).join(' ') ||
    from.username ||
    String(from.id);

  return {
    id: String(msg.message_id),
    chat_jid: `tg:${msg.chat.id}`,
    sender: String(from.id),
    sender_name: senderName,
    content,
    timestamp: new Date(msg.date * 1000).toISOString(),
    is_from_me: false,
    is_bot_message: from.is_bot ?? false,
  };
}

class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot;
  private connected = false;

  constructor(private token: string, private opts: ChannelOpts) {
    this.bot = new Bot(token);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    const { onMessage, onChatMetadata } = this.opts;

    // Text messages
    this.bot.on('message:text', (ctx) => {
      const msg = ctx.message;
      const chatJid = `tg:${msg.chat.id}`;
      const timestamp = new Date(msg.date * 1000).toISOString();
      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
      const chatName = 'title' in msg.chat ? msg.chat.title : undefined;

      onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);
      onMessage(chatJid, buildNewMessage(ctx, msg.text));
    });

    // Photo messages
    this.bot.on('message:photo', (ctx) => {
      const msg = ctx.message;
      const chatJid = `tg:${msg.chat.id}`;
      const timestamp = new Date(msg.date * 1000).toISOString();
      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
      const chatName = 'title' in msg.chat ? msg.chat.title : undefined;

      const caption = msg.caption ? ` "${msg.caption}"` : '';
      const content = `[Photo${caption}]`;

      onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);
      onMessage(chatJid, buildNewMessage(ctx, content));
    });

    this.bot.catch((err) => {
      logger.error({ err }, 'Telegram bot error');
    });
  }

  async connect(): Promise<void> {
    // Verify token is valid before starting
    const me = await this.bot.api.getMe();
    logger.info({ username: me.username, id: me.id }, 'Telegram bot connected');

    // Start long-polling in the background (bot.start() resolves only when stopped)
    this.bot.start().catch((err) => {
      logger.error({ err }, 'Telegram bot polling stopped unexpectedly');
      this.connected = false;
    });

    this.connected = true;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^tg:/, '');
    if (text.length <= MAX_LENGTH) {
      await this.bot.api.sendMessage(chatId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await this.bot.api.sendMessage(chatId, text.slice(i, i + MAX_LENGTH));
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    await this.bot.stop();
    this.connected = false;
    logger.info('Telegram bot disconnected');
  }
}

registerChannel('telegram', (opts: ChannelOpts): Channel | null => {
  const secrets = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || secrets.TELEGRAM_BOT_TOKEN || '';

  if (!token) {
    return null;
  }

  return new TelegramChannel(token, opts);
});
