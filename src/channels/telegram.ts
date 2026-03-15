import fs from 'fs';
import https from 'https';
import path from 'path';

import { Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudioBuffer } from '../transcription.js';
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
 * Convert WhatsApp-style markdown to Telegram HTML.
 *
 * Handles:
 *  - ```code blocks``` → <pre>code blocks</pre>
 *  - `inline code`    → <code>inline code</code>
 *  - *bold*           → <b>bold</b>
 *  - _italic_         → <i>italic</i>
 *  - ~strikethrough~  → <s>strikethrough</s>
 *
 * HTML special chars (&, <, >) are escaped first so user content is safe.
 */
function toTelegramHTML(text: string): string {
  // 1. Escape HTML entities first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Code blocks (``` ... ```) — must come before inline code
  html = html.replace(/```([\s\S]*?)```/g, (_match, code) => {
    return `<pre>${code.trim()}</pre>`;
  });

  // 3. Inline code (` ... `)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 4. Bold (*text*) — but not inside code tags
  //    Match *word(s)* but not ** (empty) or URLs with *
  html = html.replace(/(?<![&\w])\*([^*]+)\*(?![&\w])/g, '<b>$1</b>');

  // 5. Italic (_text_) — but not mid-word underscores
  html = html.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<i>$1</i>');

  // 6. Strikethrough (~text~)
  html = html.replace(/(?<!\w)~([^~]+)~(?!\w)/g, '<s>$1</s>');

  return html;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  // Deduplication: track recently sent messages to prevent duplicates
  // Key: jid + hash of text, Value: timestamp
  private recentlySent = new Map<string, number>();
  private readonly DEDUP_WINDOW_MS = 5000; // 5 second window

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private isDuplicate(jid: string, text: string): boolean {
    // Simple hash of the text
    const hash = text.slice(0, 100) + text.length;
    const key = `${jid}:${hash}`;
    const now = Date.now();

    // Clean old entries
    for (const [k, ts] of this.recentlySent) {
      if (now - ts > this.DEDUP_WINDOW_MS) {
        this.recentlySent.delete(k);
      }
    }

    if (this.recentlySent.has(key)) {
      logger.debug({ jid }, 'Duplicate message suppressed');
      return true;
    }

    this.recentlySent.set(key, now);
    return false;
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

    // Photos — download and save for agent access
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
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      let content = `[Photo]${caption}`;

      try {
        // Get the largest photo (last in the array)
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const buffer = await this.downloadFile(fileUrl);

        if (buffer && buffer.length > 0) {
          // Save to group's IPC input directory
          const inputDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');
          fs.mkdirSync(inputDir, { recursive: true });

          const ext = file.file_path?.split('.').pop() || 'jpg';
          const filename = `img-${Date.now()}.${ext}`;
          const hostPath = path.join(inputDir, filename);

          fs.writeFileSync(hostPath, buffer);
          logger.info(
            { bytes: buffer.length, path: hostPath },
            'Saved Telegram photo for agent access',
          );

          content = `[Photo: /workspace/ipc/input/${filename}]${caption}`;

          // Clean up old images (older than 1 hour)
          this.cleanupOldMedia(inputDir, 60 * 60 * 1000);
        }
      } catch (err) {
        logger.error({ err }, 'Telegram photo download failed');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = '[Voice message]';
      try {
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const buffer = await this.downloadFile(fileUrl);
        const transcript = await transcribeAudioBuffer(buffer);
        if (transcript) {
          content = `[Voice: ${transcript}]`;
        }
      } catch (err) {
        logger.error({ err }, 'Telegram voice transcription failed');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
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

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    // Check for duplicate message within dedup window
    if (this.isDuplicate(jid, text)) {
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const html = toTelegramHTML(text);

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (html.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, html, {
          parse_mode: 'HTML',
        });
      } else {
        // Split on newlines near the limit to avoid breaking HTML tags
        const chunks = this.splitMessage(html, MAX_LENGTH);
        for (const chunk of chunks) {
          await this.bot.api.sendMessage(numericId, chunk, {
            parse_mode: 'HTML',
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      // If HTML parsing fails, fall back to plain text
      logger.warn({ jid, err }, 'HTML send failed, falling back to plain text');
      try {
        const numericId = jid.replace(/^tg:/, '');
        const MAX_LENGTH = 4096;
        if (text.length <= MAX_LENGTH) {
          await this.bot!.api.sendMessage(numericId, text);
        } else {
          for (let i = 0; i < text.length; i += MAX_LENGTH) {
            await this.bot!.api.sendMessage(
              numericId,
              text.slice(i, i + MAX_LENGTH),
            );
          }
        }
      } catch (fallbackErr) {
        logger.error(
          { jid, err: fallbackErr },
          'Failed to send Telegram message',
        );
      }
    }
  }

  async sendImage(
    jid: string,
    imagePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Check if file exists
      if (!fs.existsSync(imagePath)) {
        logger.error({ jid, imagePath }, 'Image file not found');
        return;
      }

      // Read the file and create InputFile
      const imageBuffer = fs.readFileSync(imagePath);
      const filename = path.basename(imagePath);
      const inputFile = new InputFile(imageBuffer, filename);

      // Format caption with HTML if provided
      const formattedCaption = caption ? toTelegramHTML(caption) : undefined;

      await this.bot.api.sendPhoto(numericId, inputFile, {
        caption: formattedCaption,
        parse_mode: formattedCaption ? 'HTML' : undefined,
      });

      logger.info(
        { jid, imagePath, hasCaption: !!caption },
        'Telegram image sent',
      );
    } catch (err) {
      logger.error({ jid, imagePath, err }, 'Failed to send Telegram image');
    }
  }

  /**
   * Split a long message into chunks, trying to break at newlines
   * to avoid splitting HTML tags mid-tag.
   */
  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to find a newline near the limit
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt < maxLength * 0.5) {
        // No good newline found — split at space
        splitAt = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitAt < maxLength * 0.3) {
        // No good break point — hard split
        splitAt = maxLength;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
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

  private downloadFile(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      https
        .get(url, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        })
        .on('error', reject);
    });
  }

  /**
   * Remove media files older than maxAge from a directory.
   */
  private cleanupOldMedia(dir: string, maxAgeMs: number): void {
    try {
      const files = fs.readdirSync(dir);
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith('img-')) continue;
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            logger.debug({ file }, 'Cleaned up old media file');
          }
        } catch {}
      }
    } catch {}
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
