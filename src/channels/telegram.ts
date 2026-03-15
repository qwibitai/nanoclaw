import crypto from 'crypto';
import https from 'https';
import { createServer, Server } from 'http';
import { Api, Bot, webhookCallback } from 'grammy';

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
  private webhookUrl: string | null;
  private webhookServer: Server | null = null;
  private webhookSecretToken: string;
  private useWebhook: boolean;

  constructor(
    botToken: string,
    opts: TelegramChannelOpts,
    webhookUrl?: string,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.webhookUrl = webhookUrl || null;
    this.useWebhook = !!this.webhookUrl;
    // Generate a random secret token for webhook verification
    this.webhookSecretToken = crypto.randomBytes(32).toString('hex');
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    this.setupHandlers();

    if (this.useWebhook) {
      await this.startWebhook();
    } else {
      await this.startPolling();
    }
  }

  private setupHandlers(): void {
    // Command to get chat ID (useful for registration)
    this.bot!.command('chatid', (ctx) => {
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
    this.bot!.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot!.on('message:text', async (ctx) => {
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

    this.bot!.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot!.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot!.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
    this.bot!.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot!.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot!.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot!.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot!.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot!.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });
  }

  private async startPolling(): Promise<void> {
    // Delete any leftover webhook from a previous webhook-mode run
    await this.bot!.api.deleteWebhook();

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected (polling)',
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

  private async startWebhook(): Promise<void> {
    // Initialize the bot (fetches bot info) without starting polling
    await this.bot!.init();

    const botInfo = this.bot!.botInfo;
    logger.info(
      { username: botInfo.username, id: botInfo.id },
      'Telegram bot initialized (webhook)',
    );

    // Parse webhook URL to determine path and port
    const parsedUrl = new URL(this.webhookUrl!);
    const webhookPath = parsedUrl.pathname || '/telegram';
    const listenPort = parseInt(
      process.env.TELEGRAM_WEBHOOK_PORT || '8443',
      10,
    );

    // Create webhook handler using grammy's http adapter
    const handleUpdate = webhookCallback(this.bot!, 'http', {
      secretToken: this.webhookSecretToken,
    });

    // Create a minimal HTTP server for the webhook
    this.webhookServer = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === webhookPath) {
        await handleUpdate(req, res);
      } else {
        res.writeHead(200);
        res.end('OK');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.webhookServer!.listen(listenPort, () => {
        logger.info(
          { port: listenPort, path: webhookPath },
          'Telegram webhook server listening',
        );
        resolve();
      });
      this.webhookServer!.on('error', reject);
    });

    // Register the webhook with Telegram
    await this.bot!.api.setWebhook(this.webhookUrl!, {
      secret_token: this.webhookSecretToken,
    });

    logger.info(
      { url: this.webhookUrl },
      'Telegram webhook registered with Telegram API',
    );
    console.log(`\n  Telegram bot: @${botInfo.username} (webhook mode)`);
    console.log(`  Send /chatid to the bot to get a chat's registration ID\n`);
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
      if (this.useWebhook) {
        // Delete webhook registration so Telegram stops sending updates
        try {
          await this.bot.api.deleteWebhook();
          logger.info('Telegram webhook deleted');
        } catch (err) {
          logger.error({ err }, 'Failed to delete Telegram webhook');
        }
        // Close the webhook HTTP server
        if (this.webhookServer) {
          await new Promise<void>((resolve) => {
            this.webhookServer!.close(() => resolve());
          });
          this.webhookServer = null;
          logger.info('Telegram webhook server closed');
        }
      } else {
        this.bot.stop();
      }
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
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_URL',
    'TELEGRAM_WEBHOOK_PORT',
  ]);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const webhookUrl =
    process.env.TELEGRAM_WEBHOOK_URL || envVars.TELEGRAM_WEBHOOK_URL || '';
  return new TelegramChannel(token, opts, webhookUrl || undefined);
});
