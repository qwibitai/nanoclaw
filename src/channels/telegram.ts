import { execFile } from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { countPdfPages, indexPdf, computeFileHash } from '../pageindex.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const execFileAsync = promisify(execFile);

/** Extensions that can be extracted to text via external tools. */
const EXTRACTABLE_EXTS: Record<string, (filePath: string) => Promise<string>> =
  {
    '.pdf': extractPdfText,
    '.docx': extractDocxText,
  };

async function extractPdfText(filePath: string): Promise<string> {
  // Use absolute path — launchd doesn't include /opt/homebrew/bin in PATH
  const pdftotext =
    process.platform === 'darwin' ? '/opt/homebrew/bin/pdftotext' : 'pdftotext';
  const { stdout } = await execFileAsync(pdftotext, ['-layout', filePath, '-']);
  return stdout;
}

async function extractDocxText(filePath: string): Promise<string> {
  // Use absolute path — launchd doesn't include /opt/homebrew/bin in PATH
  const pandoc =
    process.platform === 'darwin' ? '/opt/homebrew/bin/pandoc' : 'pandoc';
  const { stdout } = await execFileAsync(pandoc, [
    '-f',
    'docx',
    '-t',
    'plain',
    '--wrap=none',
    filePath,
  ]);
  return stdout;
}

/**
 * Download a Telegram file to a temp path, extract text, and clean up.
 * Returns extracted text or null if extraction fails.
 */
async function extractDocumentText(
  fileUrl: string,
  fileName: string,
): Promise<string | null> {
  const ext = fileName.includes('.')
    ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
    : '';
  const extractor = EXTRACTABLE_EXTS[ext];
  if (!extractor) return null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-doc-'));
  const tmpFile = path.join(tmpDir, fileName);
  try {
    const resp = await fetch(fileUrl);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tmpFile, buf);
    return await extractor(tmpFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
/**
 * Send a message via a pool bot assigned to the given sender name.
 * Returns false if the pool bot can't reach the chat (e.g. 403 in DMs),
 * so the caller can fall back to the main bot.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<boolean> {
  if (poolApis.length === 0) {
    return false;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
    return true;
  } catch (err: unknown) {
    const errorCode =
      err && typeof err === 'object' && 'error_code' in err
        ? (err as { error_code: number }).error_code
        : 0;
    if (errorCode === 403) {
      logger.info(
        { chatId, sender },
        'Pool bot cannot reach chat, falling back to main bot',
      );
      return false;
    }
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
    return false;
  }
}

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

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const name = doc?.file_name || 'file';

      // For text-readable files, download and include the content
      const textExts = [
        '.txt',
        '.md',
        '.json',
        '.csv',
        '.xml',
        '.yaml',
        '.yml',
        '.html',
        '.htm',
        '.css',
        '.js',
        '.ts',
        '.py',
        '.sh',
        '.log',
        '.ini',
        '.cfg',
        '.toml',
        '.env',
        '.sql',
        '.r',
        '.tex',
        '.bib',
        '.tsv',
      ];
      const ext = name.includes('.')
        ? name.slice(name.lastIndexOf('.')).toLowerCase()
        : '';
      const isText =
        textExts.includes(ext) ||
        (doc?.mime_type?.startsWith('text/') ?? false);

      if (isText && doc?.file_id) {
        try {
          const file = await ctx.api.getFile(doc.file_id);
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const content = await resp.text();
            // Telegram Bot API file size limit is 20MB; truncate large files
            const maxChars = 50_000;
            const truncated =
              content.length > maxChars
                ? content.slice(0, maxChars) +
                  `\n\n[Truncated — ${content.length} chars total]`
                : content;
            storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
            logger.info(
              { name, chars: content.length },
              'Telegram document downloaded',
            );
            return;
          }
        } catch (err) {
          logger.warn({ name, err }, 'Failed to download Telegram document');
        }
      }

      // Try extracting text from binary documents (PDF, DOCX, etc.)
      if (doc?.file_id && EXTRACTABLE_EXTS[ext]) {
        // Special handling for PDFs: auto-index long documents
        if (ext === '.pdf') {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pdf-'));
          const tmpFile = path.join(tmpDir, name);
          try {
            const file = await ctx.api.getFile(doc.file_id);
            const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
            const resp = await fetch(url);
            if (!resp.ok) {
              storeNonText(ctx, `[Document: ${name}]`);
              return;
            }
            const buf = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(tmpFile, buf);

            const pageCount = await countPdfPages(tmpFile);
            if (pageCount > 20) {
              // Long PDF — auto-index
              await ctx.api.sendChatAction(ctx.chat.id, 'typing');
              const hash = computeFileHash(buf);

              // Determine vault dir from group's additionalMounts config
              const chatJid = `tg:${ctx.chat.id}`;
              const group = this.opts.registeredGroups()[chatJid];
              let vaultDir: string | undefined;
              let inboxDir: string | undefined;
              if (group?.containerConfig?.additionalMounts) {
                for (const m of group.containerConfig.additionalMounts) {
                  if (fs.existsSync(m.hostPath)) {
                    inboxDir = path.join(m.hostPath, '00-inbox');
                    vaultDir = inboxDir;
                    break;
                  }
                }
              }

              const result = await indexPdf(tmpFile, name, {
                vaultDir,
                contentHash: hash,
                fileBuffer: buf,
              });

              if (result.success && result.tree) {
                // Save PDF to vault 00-inbox/
                if (inboxDir) {
                  try {
                    fs.mkdirSync(inboxDir, { recursive: true });
                    fs.writeFileSync(path.join(inboxDir, name), buf);
                    logger.info({ name, inboxDir }, 'PDF saved to vault inbox');
                  } catch (saveErr) {
                    logger.warn({ name, err: saveErr }, 'Failed to save PDF to vault inbox');
                  }
                }
                storeNonText(
                  ctx,
                  `[Document: ${name} — ${pageCount} pages, indexed]\n\n${JSON.stringify(result.tree, null, 2)}`,
                );
                logger.info(
                  { name, pageCount },
                  'Telegram PDF indexed',
                );
                return;
              } else if (result.fallbackText && result.fallbackText.trim().length > 0) {
                const maxChars = 50_000;
                const truncated =
                  result.fallbackText.length > maxChars
                    ? result.fallbackText.slice(0, maxChars) +
                      `\n\n[Truncated — ${result.fallbackText.length} chars total]`
                    : result.fallbackText;
                storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
                logger.info(
                  { name, chars: result.fallbackText.length, pageCount },
                  'Telegram PDF extracted (fallback)',
                );
                return;
              } else {
                storeNonText(ctx, `[Document: ${name}]`);
                return;
              }
            }

            // Short PDF (≤20 pages) — use existing extraction flow
            try {
              const extracted = await extractPdfText(tmpFile);
              if (extracted && extracted.trim().length > 0) {
                const maxChars = 50_000;
                const truncated =
                  extracted.length > maxChars
                    ? extracted.slice(0, maxChars) +
                      `\n\n[Truncated — ${extracted.length} chars total]`
                    : extracted;
                storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
                logger.info(
                  { name, chars: extracted.length },
                  'Telegram document extracted',
                );
                return;
              }
            } catch (extractErr) {
              logger.warn(
                { name, err: extractErr },
                'Failed to extract short PDF text',
              );
            }
          } catch (err) {
            logger.warn(
              { name, err },
              'Failed to process Telegram PDF',
            );
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
          storeNonText(ctx, `[Document: ${name}]`);
          return;
        }

        // Non-PDF extractable documents (DOCX, etc.)
        try {
          const file = await ctx.api.getFile(doc.file_id);
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const extracted = await extractDocumentText(url, name);
          if (extracted && extracted.trim().length > 0) {
            const maxChars = 50_000;
            const truncated =
              extracted.length > maxChars
                ? extracted.slice(0, maxChars) +
                  `\n\n[Truncated — ${extracted.length} chars total]`
                : extracted;
            storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
            logger.info(
              { name, chars: extracted.length },
              'Telegram document extracted',
            );
            return;
          }
        } catch (err) {
          logger.warn(
            { name, err },
            'Failed to extract Telegram document text',
          );
        }
      }

      // Fallback: placeholder for binary files or download failures
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
