import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';
import type { ReactionType } from 'grammy/types';

import { execSync } from 'child_process';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { deleteSession } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import allowedReactions from './telegram-allowed-reactions.json' with { type: 'json' };
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const ALLOWED_REACTIONS: ReadonlySet<string> = new Set(allowedReactions);
const REACTION_CACHE_CAP = 5000;

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Marker file used to notify a chat after /restart kickstart completes.
const RESTART_NOTIFY_FILE = path.join(DATA_DIR, 'restart-notify.json');

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
  private lastReactions = new Map<string, string | null>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
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

    // Command to reset session
    this.bot.command('new', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('Chat not registered.');
        return;
      }

      // Stop running container for this group
      try {
        const list = execSync('container list 2>/dev/null', {
          encoding: 'utf-8',
        });
        for (const line of list.split('\n')) {
          if (line.includes(`nanoclaw-${group.folder}-`)) {
            const name = line.trim().split(/\s+/)[0];
            if (name) {
              execSync(`container stop ${name} 2>/dev/null`);
              logger.info(
                { group: group.name, container: name },
                '/new: container stopped',
              );
            }
          }
        }
      } catch {
        // No container running — that's fine
      }

      // Delete session JSONL files
      const projectDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        '.claude',
        'projects',
        '-workspace-group',
      );
      if (fs.existsSync(projectDir)) {
        for (const f of fs.readdirSync(projectDir)) {
          if (f.endsWith('.jsonl')) {
            fs.unlinkSync(path.join(projectDir, f));
          }
        }
      }

      // Clear session ID from DB
      deleteSession(group.folder);
      logger.info({ group: group.name }, '/new: session reset');
      ctx.reply('Session reset. Next message starts fresh.');
    });

    // Command to restart NanoClaw (kickstart via launchd)
    this.bot.command('restart', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('Chat not registered.');
        return;
      }

      await ctx.reply(`${ASSISTANT_NAME} restarting…`);
      logger.warn(
        { group: group.name, triggeredBy: ctx.from?.id },
        '/restart: kickstart requested',
      );

      // Drop a marker so the next startup can ping the same chat when it's back.
      try {
        fs.writeFileSync(
          RESTART_NOTIFY_FILE,
          JSON.stringify({
            chatId: ctx.chat.id,
            threadId: ctx.message?.message_thread_id ?? null,
            requestedAt: new Date().toISOString(),
          }),
        );
      } catch (err) {
        logger.warn({ err }, '/restart: failed to write notify marker');
      }

      // Defer kickstart so the reply is flushed before launchd kills us.
      setTimeout(() => {
        try {
          const uid = process.getuid ? process.getuid() : 0;
          const label =
            process.env.NANOCLAW_LAUNCHD_LABEL || 'com.nanoclaw-unic';
          execSync(`launchctl kickstart -k gui/${uid}/${label}`);
        } catch (err) {
          logger.error({ err }, '/restart: kickstart failed');
        }
      }, 500);
    });

    // Command to show session status
    this.bot.command('status', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('Chat not registered.');
        return;
      }

      const projectDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        '.claude',
        'projects',
        '-workspace-group',
      );
      if (!fs.existsSync(projectDir)) {
        ctx.reply('No active session.');
        return;
      }

      const jsonlFiles = fs
        .readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const full = path.join(projectDir, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (jsonlFiles.length === 0) {
        ctx.reply('No active session.');
        return;
      }

      // Read last assistant entry with usage from the most recent JSONL
      const filePath = jsonlFiles[0].full;
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');

      let model = '?';
      let contextTokens = 0;
      let cacheRead = 0;
      let cacheCreation = 0;

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === 'assistant' && obj.message?.usage) {
            const u = obj.message.usage;
            model = obj.message.model || '?';
            cacheRead = u.cache_read_input_tokens || 0;
            cacheCreation = u.cache_creation_input_tokens || 0;
            contextTokens = (u.input_tokens || 0) + cacheRead + cacheCreation;
            break;
          }
        } catch {
          // skip malformed lines
        }
      }

      const contextK = Math.round(contextTokens / 1000);
      const maxK = 1000;
      const pct = Math.round((contextTokens / (maxK * 1000)) * 100);
      const total = cacheRead + cacheCreation;
      const hitRate = total > 0 ? Math.round((cacheRead / total) * 100) : 0;

      ctx.reply(
        `🧠 Model: ${model}\n📚 Context: ~${contextK}k/${maxK}k (${pct}%)\n🗄️ Cache: ${hitRate}% hit`,
      );
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set([
      'chatid',
      'ping',
      'new',
      'status',
      'restart',
    ]);

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

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

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

        // Treat replies to the bot's own messages as trigger in groups
        if (
          replyTo?.from?.id === ctx.me.id &&
          ctx.chat.type !== 'private' &&
          !TRIGGER_PATTERN.test(content)
        ) {
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
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
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

      let needsTriggerPrefix = false;
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername && caption) {
        const entities = ctx.message.caption_entities || [];
        needsTriggerPrefix = entities.some(
          (e: any) =>
            e.type === 'mention' &&
            ctx.message
              .caption!.substring(e.offset, e.offset + e.length)
              .toLowerCase() === `@${botUsername}`,
        );
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      // Reply to bot's message in group = trigger
      const replyTo = ctx.message.reply_to_message;
      if (!needsTriggerPrefix && replyTo?.from?.id === ctx.me.id && isGroup) {
        needsTriggerPrefix = true;
      }
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const deliver = (content: string) => {
        const final = needsTriggerPrefix
          ? `@${ASSISTANT_NAME} ${content}`
          : content;
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: final,
          timestamp,
          is_from_me: false,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(opts.fileId, group.folder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    this.bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeMedia(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

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
          this.bot!.api.setMyCommands([
            { command: 'new', description: 'Reset session' },
            { command: 'status', description: 'Show context usage' },
            { command: 'chatid', description: 'Show chat ID' },
            { command: 'ping', description: 'Check if bot is online' },
            { command: 'restart', description: 'Restart NanoClaw' },
          ]).catch((err) => logger.warn({ err }, 'Failed to set bot commands'));
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );

          // If we were just kickstarted via /restart, notify the requesting chat.
          if (fs.existsSync(RESTART_NOTIFY_FILE)) {
            try {
              const marker = JSON.parse(
                fs.readFileSync(RESTART_NOTIFY_FILE, 'utf-8'),
              );
              const opts: { message_thread_id?: number } = {};
              if (typeof marker.threadId === 'number') {
                opts.message_thread_id = marker.threadId;
              }
              this.bot!.api.sendMessage(
                marker.chatId,
                `${ASSISTANT_NAME} back online.`,
                opts,
              )
                .catch((err) =>
                  logger.warn({ err }, '/restart: failed to send back-online'),
                )
                .finally(() => {
                  try {
                    fs.unlinkSync(RESTART_NOTIFY_FILE);
                  } catch {
                    // ignore
                  }
                });
            } catch (err) {
              logger.warn({ err }, '/restart: failed to read notify marker');
              try {
                fs.unlinkSync(RESTART_NOTIFY_FILE);
              } catch {
                // ignore
              }
            }
          }

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

  async setReaction(
    jid: string,
    messageId: string,
    emoji: string | null,
  ): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }

    const normalizedEmoji = emoji === '' ? null : emoji;
    const cacheKey = `${jid}:${messageId}`;
    if (this.lastReactions.get(cacheKey) === normalizedEmoji) {
      logger.debug(
        { jid, messageId, emoji: normalizedEmoji },
        'Telegram reaction idempotent cache hit, skipping API',
      );
      return;
    }

    if (normalizedEmoji !== null && !ALLOWED_REACTIONS.has(normalizedEmoji)) {
      throw new Error(
        `Emoji "${normalizedEmoji}" not allowed for Telegram bot reactions`,
      );
    }

    const numericId = jid.replace(/^tg:/, '');
    const numMsgId = parseInt(messageId, 10);
    if (Number.isNaN(numMsgId)) {
      throw new Error(`Invalid message_id: "${messageId}"`);
    }

    const reaction: ReactionType[] = normalizedEmoji
      ? ([
          { type: 'emoji', emoji: normalizedEmoji },
        ] as unknown as ReactionType[])
      : [];

    await this.bot.api.setMessageReaction(numericId, numMsgId, reaction);
    logger.info(
      { jid, messageId, emoji: normalizedEmoji },
      'Telegram reaction API called',
    );

    if (this.lastReactions.has(cacheKey)) {
      this.lastReactions.delete(cacheKey);
    }
    this.lastReactions.set(cacheKey, normalizedEmoji);
    while (this.lastReactions.size > REACTION_CACHE_CAP) {
      const oldestKey = this.lastReactions.keys().next().value;
      if (oldestKey === undefined) break;
      this.lastReactions.delete(oldestKey);
    }
  }

  getCachedReaction(jid: string, messageId: string): string | null | undefined {
    return this.lastReactions.get(`${jid}:${messageId}`);
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

  async sendVoice(
    jid: string,
    audio: Buffer,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};
      await this.bot.api.sendVoice(
        numericId,
        new InputFile(audio, 'voice.ogg'),
        options,
      );
      logger.info({ jid }, 'Telegram voice message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram voice message');
    }
  }

  async sendPhoto(
    jid: string,
    filePath: string,
    caption?: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) return;
    const numericId = jid.replace(/^tg:/, '');
    const options: Record<string, unknown> = {};
    if (caption) options.caption = caption;
    if (threadId) options.message_thread_id = parseInt(threadId, 10);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.bot.api.sendPhoto(
          numericId,
          new InputFile(fs.readFileSync(filePath), path.basename(filePath)),
          options,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          AbortSignal.timeout(120_000) as any,
        );
        logger.info({ jid }, 'Telegram photo sent');
        return;
      } catch (err) {
        logger.warn({ jid, attempt, err }, 'sendPhoto attempt failed');
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    logger.error({ jid }, 'Failed to send Telegram photo after 3 attempts');
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
