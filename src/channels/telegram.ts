import fs from 'fs';
import path from 'path';

import { Bot } from 'grammy';

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
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Convert Markdown to Telegram HTML.
 * Handles fenced code blocks, markdown tables, inline code, bold, and italic.
 * HTML special chars are escaped in all regions; markdown syntax is only
 * converted outside of code spans.
 */
function markdownToHtml(text: string): string {
  const parts: string[] = [];
  const fencedRe = /```(?:\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = fencedRe.exec(text)) !== null) {
    if (m.index > last) parts.push(convertText(text.slice(last, m.index)));
    const code = escHtml(m[1].replace(/\n$/, ''));
    parts.push(`<pre><code>${code}</code></pre>`);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(convertText(text.slice(last)));
  return parts.join('');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Display width: CJK and fullwidth chars count as 2, others as 1. */
function displayWidth(s: string): number {
  return [...s].reduce((w, c) => {
    const cp = c.codePointAt(0)!;
    return w + (cp > 0x2e80 && cp < 0xff61 ? 2 : 1);
  }, 0);
}

/** Convert a block of markdown table lines to a <pre> ASCII table. */
function tableToPreformatted(tableLines: string[]): string {
  const isSep = (l: string) => /^\|[\s|:=-]+\|$/.test(l.trim());
  const rows = tableLines
    .filter((l) => !isSep(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim()),
    );
  if (rows.length === 0) return tableLines.join('\n');

  const colCount = Math.max(...rows.map((r) => r.length));
  const colWidths = Array.from({ length: colCount }, (_, ci) =>
    Math.max(1, ...rows.map((r) => displayWidth(r[ci] ?? ''))),
  );

  const pad = (s: string, w: number) =>
    s + ' '.repeat(Math.max(0, w - displayWidth(s)));

  const bar = (l: string, mid: string, r: string, f: string) =>
    l + colWidths.map((w) => f.repeat(w + 2)).join(mid) + r;

  const rowStr = (row: string[]) =>
    '│' +
    Array.from({ length: colCount }, (_, ci) => ` ${pad(row[ci] ?? '', colWidths[ci])} `).join('│') +
    '│';

  const top = bar('┌', '┬', '┐', '─');
  const sep = bar('├', '┼', '┤', '─');
  const bot = bar('└', '┴', '┘', '─');

  const formatted = rows
    .map((row, i) => {
      if (i === 0) return `${top}\n${rowStr(row)}\n${sep}`;
      if (i === rows.length - 1) return `${rowStr(row)}\n${bot}`;
      return rowStr(row);
    })
    .join('\n');

  return `<pre>${escHtml(formatted)}</pre>`;
}

/**
 * Convert a non-code text chunk: detects markdown table blocks line by line
 * and converts them to preformatted output; all other lines go through
 * inline markdown conversion.
 */
function convertText(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      out.push(tableToPreformatted(tableLines));
    } else {
      out.push(convertInline(lines[i]));
      i++;
    }
  }
  return out.join('\n');
}

function convertInline(text: string): string {
  // Heading lines: # Heading → <b>Heading</b>
  const headingMatch = text.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    return `<b>${escHtml(headingMatch[2])}</b>`;
  }
  // Bullet list items: - item or * item → • item
  const bulletMatch = text.match(/^[-*]\s+(.+)$/);
  if (bulletMatch) {
    return `• ${processInlineSpans(bulletMatch[1])}`;
  }
  // Horizontal rule: --- or *** → separator line
  if (/^[-*]{3,}$/.test(text.trim())) {
    return '───────────';
  }
  return processInlineSpans(text);
}

function processInlineSpans(text: string): string {
  const segments = text.split(/(`[^`]+`)/g);
  return segments
    .map((seg) => {
      if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
        return `<code>${escHtml(seg.slice(1, -1))}</code>`;
      }
      let s = escHtml(seg);
      s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
      s = s.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
      s = s.replace(/_([^_\n]+)_/g, '<i>$1</i>');
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      return s;
    })
    .join('');
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

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Telegram sends photos as an array from smallest to largest
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const filename = `photo_${ctx.message.message_id}.jpg`;
      const filePath = await this.downloadToGroup(
        photo.file_id,
        filename,
        group.folder,
        photo.file_size,
      );
      const content = filePath ? `[Photo: ${filePath}]` : '[Photo: too large to download]';
      storeNonText(ctx, content);
    });

    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const doc = ctx.message.document!;
      const safeName = (doc.file_name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `doc_${ctx.message.message_id}_${safeName}`;
      const filePath = await this.downloadToGroup(
        doc.file_id,
        filename,
        group.folder,
        doc.file_size,
      );
      const sizeMb = doc.file_size ? ` (${(doc.file_size / 1024 / 1024).toFixed(1)} MB)` : '';
      const content = filePath
        ? `[Document: ${filePath}]`
        : `[Document: ${doc.file_name || 'file'}${sizeMb} — too large to download (>20 MB)]`;
      storeNonText(ctx, content);
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

    const numericId = jid.replace(/^tg:/, '');
    const html = markdownToHtml(text);
    const MAX_LENGTH = 4096;

    const sendChunks = async (
      content: string,
      opts: Record<string, unknown>,
    ) => {
      if (content.length <= MAX_LENGTH) {
        await this.bot!.api.sendMessage(numericId, content, opts as any);
      } else {
        for (let i = 0; i < content.length; i += MAX_LENGTH) {
          await this.bot!.api.sendMessage(
            numericId,
            content.slice(i, i + MAX_LENGTH),
            opts as any,
          );
        }
      }
    };

    try {
      await sendChunks(html, { parse_mode: 'HTML' });
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (htmlErr) {
      // Telegram rejected the HTML (e.g. malformed tags) — fall back to plain text
      logger.warn({ jid, htmlErr }, 'HTML send failed, retrying as plain text');
      try {
        await sendChunks(text, {});
        logger.info({ jid, length: text.length }, 'Telegram message sent');
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send Telegram message');
      }
    }
  }

  /**
   * Download a Telegram file to the group's uploads/ directory.
   * Returns the relative path (e.g. "uploads/photo_42.jpg") on success,
   * or null if the file is too large or the download fails.
   */
  private async downloadToGroup(
    fileId: string,
    filename: string,
    groupFolder: string,
    fileSizeBytes?: number,
  ): Promise<string | null> {
    const MAX_BYTES = 20 * 1024 * 1024; // Telegram Bot API getFile limit
    if (fileSizeBytes !== undefined && fileSizeBytes > MAX_BYTES) return null;

    try {
      const file = await this.bot!.api.getFile(fileId);
      if (!file.file_path) return null;

      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const uploadsDir = path.join(resolveGroupFolderPath(groupFolder), 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      const dest = path.join(uploadsDir, filename);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return `uploads/${filename}`;
    } catch (err) {
      logger.warn({ err, fileId }, 'Failed to download Telegram file');
      return null;
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
