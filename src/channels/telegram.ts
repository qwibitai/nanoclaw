import fs from 'fs';
import { execSync } from 'child_process';

import { Bot, Api } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { markdownToTelegramHtml } from '../markdown-to-telegram.js';
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

/**
 * Split HTML into chunks that respect paragraph boundaries and don't break HTML tags.
 * Each chunk will be under maxLength characters.
 */
function splitHtmlIntelligently(html: string, maxLength: number): string[] {
  // Split by double newlines (paragraph breaks) first
  const paragraphs = html.split('\n\n');
  const chunks: string[] = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    // If adding this paragraph would exceed limit, save current chunk and start new one
    if (currentChunk.length + para.length + 2 > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }

      // If a single paragraph is too long, split it by sentences
      if (para.length > maxLength) {
        const sentences = para.split(/(?<=[.!?])\s+/);
        let sentenceChunk = '';

        for (const sentence of sentences) {
          if (sentenceChunk.length + sentence.length + 1 > maxLength) {
            if (sentenceChunk) {
              chunks.push(sentenceChunk.trim());
            }

            // If even a single sentence is too long, hard split it
            if (sentence.length > maxLength) {
              for (let i = 0; i < sentence.length; i += maxLength) {
                chunks.push(sentence.slice(i, i + maxLength));
              }
              sentenceChunk = '';
            } else {
              sentenceChunk = sentence;
            }
          } else {
            sentenceChunk += (sentenceChunk ? ' ' : '') + sentence;
          }
        }

        if (sentenceChunk) {
          currentChunk = sentenceChunk;
        } else {
          currentChunk = '';
        }
      } else {
        currentChunk = para;
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [html];
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

    // Single entry-point security gate — applies to ALL incoming updates
    const allowedUsers = (process.env.ALLOWED_TELEGRAM_USERS || '')
      .split(',')
      .map((id) => parseInt(id.trim()))
      .filter((id) => !isNaN(id));

    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (allowedUsers.length > 0 && (!userId || !allowedUsers.includes(userId))) {
        logger.debug({ userId }, 'Unauthorized Telegram user, dropping');
        return;
      }
      await next();
    });

    // Command to list available commands
    this.bot.command('help', (ctx) => {
      ctx.reply(
        `/help — Show this list\n` +
        `/ping — Check if the bot is online\n` +
        `/status — System status report\n` +
        `/restart — Restart NanoClaw\n` +
        `/chatid — Get this chat's registration ID`,
      );
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
        { parse_mode: 'MarkdownV2' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to check system status
    this.bot.command('status', async (ctx) => {
      try {
        logger.info('Executing status command');

        // Get system status from script
        const scriptPath = `${process.cwd()}/scripts/status-report.sh`;
        const systemStatus = execSync(`bash ${scriptPath}`, {
          encoding: 'utf-8',
          timeout: 10000,
        });

        // Get process metrics
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const memory = process.memoryUsage();
        const memMB = Math.round(memory.heapUsed / 1024 / 1024);
        const nodeVersion = process.version;

        // Extract title from system status and rebuild output
        const lines = systemStatus.trim().split('\n');
        const title = lines[0]; // "📊 *Estado de NanoClaw* (26 Feb 11:42)"
        const systemStatusBody = lines.slice(2).join('\n'); // Skip title and empty line

        // Combine with title first, then process metrics, then rest
        const statusOutput = `${title}

⚙️ *Proceso NanoClaw*
Uptime: ${hours}h ${minutes}m
Memory: ${memMB} MB
Node: ${nodeVersion}

${systemStatusBody}`;

        logger.info({ outputLength: statusOutput.length }, 'Status report generated successfully');
        await ctx.reply(statusOutput, { parse_mode: 'Markdown' });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorOutput = err instanceof Error && 'output' in err ? (err as any).output : null;
        logger.error(
          {
            err,
            errorMessage,
            errorOutput,
            stderr: (err as any)?.stderr?.toString?.() || 'N/A',
            stdout: (err as any)?.stdout?.toString?.() || 'N/A',
          },
          'Failed to generate status report',
        );
        await ctx.reply('❌ Error generando reporte de estado');
      }
    });

    // Command to restart the service
    this.bot.command('restart', async (ctx) => {
      await ctx.reply('Reiniciando NanoClaw...');
      logger.info('Service restart initiated via /restart command');
      // launchctl (KeepAlive: true) will restart the process automatically
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
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

      const html = markdownToTelegramHtml(text);

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (html.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, html, { parse_mode: 'HTML' });
      } else {
        // Split intelligently by paragraphs to avoid breaking HTML tags
        const chunks = splitHtmlIntelligently(html, MAX_LENGTH);
        logger.info({ jid, totalLength: html.length, chunks: chunks.length }, 'Splitting long message');

        for (const chunk of chunks) {
          await this.bot.api.sendMessage(numericId, chunk, { parse_mode: 'HTML' });
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
    const html = markdownToTelegramHtml(text);
    const MAX_LENGTH = 4096;
    if (html.length <= MAX_LENGTH) {
      await poolApi.sendMessage(numericId, html, { parse_mode: 'HTML' });
    } else {
      // Split intelligently by paragraphs to avoid breaking HTML tags
      const chunks = splitHtmlIntelligently(html, MAX_LENGTH);
      logger.info({ jid: chatId, sender, totalLength: html.length, chunks: chunks.length }, 'Splitting long pool message');

      for (const chunk of chunks) {
        await poolApi.sendMessage(numericId, chunk, { parse_mode: 'HTML' });
      }
    }
    logger.info({ jid: chatId, sender, poolIndex: botInfo.botIndex }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}
