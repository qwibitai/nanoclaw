import fs from 'fs';
import path from 'path';

import { Api, Bot } from 'grammy';
import { Marked, type MarkedExtension } from 'marked';

import { ASSISTANT_NAME, GROUPS_DIR, RESET_COMMAND_PATTERN, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// --- Telegram HTML formatting ---

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Telegram-compatible renderer as a plain object.
 * marked v17 requires renderer overrides as a plain object, not a class instance.
 */
const telegramRenderer: MarkedExtension = {
  renderer: {
    heading({ tokens }) {
      // Telegram has no heading tag — render as bold
      return `<b>${this.parser.parseInline(tokens)}</b>\n\n`;
    },

    paragraph({ tokens }) {
      return `${this.parser.parseInline(tokens)}\n\n`;
    },

    blockquote({ tokens }) {
      const body = this.parser.parse(tokens).replace(/\n+$/, '');
      return `<blockquote>${body}</blockquote>\n\n`;
    },

    code({ text, lang }) {
      const escaped = escapeHtml(text);
      if (lang) {
        return `<pre><code class="language-${lang}">${escaped}</code></pre>\n\n`;
      }
      return `<pre>${escaped}</pre>\n\n`;
    },

    codespan({ text }) {
      return `<code>${escapeHtml(text)}</code>`;
    },

    strong({ tokens }) {
      return `<b>${this.parser.parseInline(tokens)}</b>`;
    },

    em({ tokens }) {
      return `<i>${this.parser.parseInline(tokens)}</i>`;
    },

    del({ tokens }) {
      return `<s>${this.parser.parseInline(tokens)}</s>`;
    },

    link({ href, tokens }) {
      return `<a href="${href}">${this.parser.parseInline(tokens)}</a>`;
    },

    image({ text }) {
      // Telegram can't render images inline — degrade to text
      return text ? escapeHtml(text) : '';
    },

    list({ items, ordered, start }) {
      // Telegram has no list tags — render as text lines with bullets/numbers
      const lines = items.map((item: any, i: number) => {
        const prefix = ordered ? `${Number(start ?? 1) + i}. ` : '• ';
        const content = this.parser.parse(item.tokens).replace(/\n+$/, '');
        return `${prefix}${content}`;
      });
      return lines.join('\n') + '\n\n';
    },

    listitem(token: any) {
      return this.parser.parse(token.tokens);
    },

    hr() {
      return '\n';
    },

    html({ text }) {
      // Escape raw HTML in source to prevent injection
      return escapeHtml(text);
    },

    table({ header, rows }) {
      // Degrade to text: header row + data rows separated by " | "
      const headerCells = header.map((cell: any) => this.parser.parseInline(cell.tokens));
      const lines = [headerCells.join(' | ')];
      for (const row of rows) {
        lines.push(row.map((cell: any) => this.parser.parseInline(cell.tokens)).join(' | '));
      }
      return lines.join('\n') + '\n\n';
    },

    br() {
      return '\n';
    },

    text(token: any) {
      if ('tokens' in token && token.tokens) {
        return this.parser.parseInline(token.tokens);
      }
      return escapeHtml(token.raw);
    },
  },
};

/**
 * Custom extension: __underline__ → <u>
 * Must have higher priority than marked's default __ (strong) handling.
 */
const underlineExtension: MarkedExtension = {
  extensions: [{
    name: 'underline',
    level: 'inline',
    start(src: string) { return src.indexOf('__'); },
    tokenizer(src: string) {
      const match = /^__(?!\s)([\s\S]*?[^\s])__(?!_)/.exec(src);
      if (match) {
        return {
          type: 'underline',
          raw: match[0],
          text: match[1],
          tokens: this.lexer.inlineTokens(match[1]),
        };
      }
      return undefined;
    },
    renderer(token) {
      return `<u>${this.parser.parseInline(token.tokens!)}</u>`;
    },
  }],
};

/**
 * Custom extension: ||spoiler|| → <tg-spoiler>
 */
const spoilerExtension: MarkedExtension = {
  extensions: [{
    name: 'spoiler',
    level: 'inline',
    start(src: string) { return src.indexOf('||'); },
    tokenizer(src: string) {
      const match = /^\|\|(?!\s)([\s\S]*?[^\s])\|\|/.exec(src);
      if (match) {
        return {
          type: 'spoiler',
          raw: match[0],
          text: match[1],
          tokens: this.lexer.inlineTokens(match[1]),
        };
      }
      return undefined;
    },
    renderer(token) {
      return `<tg-spoiler>${this.parser.parseInline(token.tokens!)}</tg-spoiler>`;
    },
  }],
};

/**
 * Custom extension: ~single tilde strikethrough~ → <s>
 * Standard markdown uses ~~double~~, but Telegram uses ~single~.
 */
const singleTildeExtension: MarkedExtension = {
  extensions: [{
    name: 'singleTilde',
    level: 'inline',
    start(src: string) { return src.indexOf('~'); },
    tokenizer(src: string) {
      // Match single ~ but not ~~ (which is standard strikethrough)
      const match = /^~(?!~)(?!\s)([\s\S]*?[^\s~])~(?!~)/.exec(src);
      if (match) {
        return {
          type: 'singleTilde',
          raw: match[0],
          text: match[1],
          tokens: this.lexer.inlineTokens(match[1]),
        };
      }
      return undefined;
    },
    renderer(token) {
      return `<s>${this.parser.parseInline(token.tokens!)}</s>`;
    },
  }],
};

// Build a configured marked instance
const telegramMarked = new Marked(
  underlineExtension,
  spoilerExtension,
  singleTildeExtension,
  telegramRenderer,
);

/**
 * Convert standard Markdown to Telegram-compatible HTML.
 * Uses marked for proper AST parsing — handles nested formatting correctly.
 */
export function markdownToTelegramHtml(md: string): string {
  const html = telegramMarked.parse(md, { async: false }) as string;
  // Trim trailing newlines that marked/our renderer adds
  return html.replace(/\n+$/, '');
}

/**
 * Send a message with HTML formatting, falling back to plain text on parse errors.
 */
async function sendTelegramHtml(
  api: Api,
  chatId: string,
  text: string,
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  try {
    await api.sendMessage(chatId, html, { parse_mode: 'HTML' });
  } catch {
    // Fallback to plain text if HTML parsing fails
    await api.sendMessage(chatId, text);
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot (handled by caller)
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramHtml(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramHtml(api, numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

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
  private pendingReactions = new Map<string, number>();

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
      // Skip bot commands (but allow /reset and /clear through)
      if (ctx.message.text.startsWith('/') && !RESET_COMMAND_PATTERN.test(ctx.message.text)) return;

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

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
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

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const msgId = ctx.message.message_id.toString();

      let placeholder = '[Photo]';
      try {
        const photo = ctx.message.photo!.at(-1)!;
        const file = await ctx.api.getFile(photo.file_id);
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        const filePath = path.join(mediaDir, `${msgId}.jpg`);
        fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
        placeholder = `[Photo: /workspace/group/media/${msgId}.jpg]`;
        logger.info({ chatJid, msgId, filePath }, 'Telegram photo downloaded');
      } catch (err) {
        logger.warn({ chatJid, msgId, err }, 'Failed to download Telegram photo');
      }

      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    });
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

    await this.clearThinking(jid);

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramHtml(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramHtml(
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

  async markThinking(jid: string, messageId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.clearThinking(jid);
      const numericId = jid.replace(/^tg:/, '');
      const msgId = parseInt(messageId, 10);
      await this.bot.api.setMessageReaction(numericId, msgId, [{ type: 'emoji', emoji: '👀' }]);
      this.pendingReactions.set(jid, msgId);
    } catch (err) {
      logger.debug({ jid, messageId, err }, 'Failed to set thinking reaction');
    }
  }

  async clearThinking(jid: string): Promise<void> {
    const msgId = this.pendingReactions.get(jid);
    if (!this.bot || msgId === undefined) return;
    this.pendingReactions.delete(jid);
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.setMessageReaction(numericId, msgId, []);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to clear thinking reaction');
    }
  }
}
