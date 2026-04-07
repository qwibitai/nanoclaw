import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  ReplyContext,
} from '../types.js';

/** Cap on stored reply snapshot length so the prompt doesn't bloat. */
const REPLY_SNAPSHOT_MAX = 500;

/**
 * Build a compact snapshot of a Telegram reply target so Pip can see what
 * the user is replying to. Returns undefined if no usable content exists.
 */
export function extractReplyContext(
  replyMsg: any | undefined,
): ReplyContext | undefined {
  if (!replyMsg) return undefined;

  const senderName =
    replyMsg.from?.first_name ||
    replyMsg.from?.username ||
    replyMsg.from?.id?.toString() ||
    'Unknown';

  let content = '';
  if (replyMsg.text) {
    content = replyMsg.text;
  } else if (replyMsg.caption) {
    content = replyMsg.caption;
  } else if (replyMsg.photo) {
    content = '[Photo]';
  } else if (replyMsg.video) {
    content = '[Video]';
  } else if (replyMsg.voice) {
    content = '[Voice message]';
  } else if (replyMsg.audio) {
    content = '[Audio]';
  } else if (replyMsg.document) {
    content = `[Document: ${replyMsg.document.file_name || 'file'}]`;
  } else if (replyMsg.sticker) {
    content = `[Sticker ${replyMsg.sticker.emoji || ''}]`.trim();
  } else if (replyMsg.location) {
    content = '[Location]';
  } else if (replyMsg.contact) {
    content = '[Contact]';
  } else {
    return undefined;
  }

  if (content.length > REPLY_SNAPSHOT_MAX) {
    content = content.slice(0, REPLY_SNAPSHOT_MAX) + '…';
  }

  return {
    id: replyMsg.message_id?.toString() ?? '',
    sender_name: senderName,
    content,
  };
}

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
/**
 * Convert markdown-style links [text](url) to HTML <a> tags,
 * and escape HTML entities in the rest of the text.
 */
function markdownLinksToHtml(text: string): string | null {
  if (!/\[([^\]]+)\]\(([^)]+)\)/.test(text)) return null;

  // Split on markdown links, escape non-link parts, convert links to <a>
  const parts: string[] = [];
  let last = 0;
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(escapeHtml(text.slice(last, match.index)));
    }
    parts.push(`<a href="${escapeHtml(match[2])}">${escapeHtml(match[1])}</a>`);
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push(escapeHtml(text.slice(last)));
  }
  return parts.join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  // If the message contains [text](url) links, send as HTML for reliable
  // link rendering. Telegram Markdown V1 is too flaky with special chars.
  const htmlText = markdownLinksToHtml(text);
  if (htmlText) {
    try {
      await api.sendMessage(chatId, htmlText, {
        ...options,
        parse_mode: 'HTML',
      });
      return;
    } catch (err) {
      logger.debug({ err }, 'HTML send failed, trying Markdown');
    }
  }

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
 * Save a buffer to the vault's _sources/telegram/ directory.
 * Returns the container-visible path if successful, null otherwise.
 */
function saveToVault(filename: string, buffer: Buffer): string | null {
  try {
    const vaultSourcesDir = path.join(
      process.env.HOME || '/Users/fambot',
      'sigma-data',
      'family-vault',
      '_sources',
      'telegram',
    );
    fs.mkdirSync(vaultSourcesDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const safeName = `${date}-${filename}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    const savePath = path.join(vaultSourcesDir, safeName);
    fs.writeFileSync(savePath, buffer);

    logger.info({ file: safeName, size: buffer.length }, 'File saved to vault');
    return `/workspace/extra/family-vault/_sources/telegram/${safeName}`;
  } catch (err) {
    logger.error({ filename, err }, 'Failed to save file to vault');
    return null;
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
              {
                botName: config.name,
                username: botInfo.username,
                id: botInfo.id,
              },
              'Telegram bot connected',
            );
            console.log(
              `\n  Telegram bot "${config.name}": @${botInfo.username}`,
            );
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
        reply_to: extractReplyContext(ctx.message.reply_to_message),
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
        reply_to: extractReplyContext(ctx.message.reply_to_message),
      });
    };

    bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        storeNonText(ctx, '[Photo]');
        return;
      }

      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      if (largest?.file_id) {
        try {
          const file = await bot.api.getFile(largest.file_id);
          if (file.file_path) {
            const msgId = ctx.message.message_id.toString();
            const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
            const response = await fetch(url);
            if (response.ok) {
              const buffer = Buffer.from(await response.arrayBuffer());
              const vaultPath = saveToVault(`photo-${msgId}.jpg`, buffer);
              if (vaultPath) {
                storeNonText(ctx, `[Photo] (saved to ${vaultPath})`);
                return;
              }
            }
          }
        } catch (err) {
          logger.error({ chatJid, err }, 'Failed to download Telegram photo');
        }
      }
      storeNonText(ctx, '[Photo]');
    });
    bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const name = doc?.file_name || 'file';
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      // Try to download the file into the group's uploads folder
      if (group && doc?.file_id) {
        try {
          const file = await bot.api.getFile(doc.file_id);
          if (file.file_path) {
            const groupDir = resolveGroupFolderPath(group.folder);
            const uploadsDir = path.join(groupDir, 'uploads');
            fs.mkdirSync(uploadsDir, { recursive: true });
            const savePath = path.join(uploadsDir, name);

            const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
            const response = await fetch(url);
            if (response.ok) {
              const buffer = Buffer.from(await response.arrayBuffer());
              fs.writeFileSync(savePath, buffer);
              logger.info(
                { chatJid, file: name, size: buffer.length },
                'Telegram file downloaded',
              );

              // Also save to vault
              const vaultPath = saveToVault(name, buffer);
              const locationNote = vaultPath
                ? `saved to ${vaultPath}`
                : `saved to /workspace/group/uploads/${name}`;
              storeNonText(ctx, `[Document: ${name}] (${locationNote})`);
              return;
            }
          }
        } catch (err) {
          logger.error(
            { chatJid, file: name, err },
            'Failed to download Telegram file',
          );
        }
      }

      // Fallback: just store the placeholder
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
      logger.error(
        { jid, bot: instance.name, err },
        'Failed to send Telegram message',
      );
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
    logger.warn(
      'Telegram: no bot tokens configured (TELEGRAM_BOTS or TELEGRAM_BOT_TOKEN)',
    );
    return null;
  }

  return new TelegramChannel(configs, opts);
});
