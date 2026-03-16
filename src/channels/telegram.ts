/**
 * Multi-bot Telegram channel for NanoClaw.
 *
 * Supports multiple Telegram bot tokens — one per agent group.
 * Each bot polls its own updates independently and routes messages
 * to the correct agent group via JID mapping.
 *
 * Config via .env:
 *   TELEGRAM_BOTS=folder1:token1,folder2:token2,...
 *
 * Example:
 *   TELEGRAM_BOTS=shinobu:123:AAA...,homura:456:BBB...
 */

import fs from 'fs';
import path from 'path';

import { Bot, Context } from 'grammy';
import { registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';
import { DATA_DIR, MAX_ATTACHMENT_SIZE } from '../config.js';
import { logger } from '../logger.js';
import type {
  Attachment,
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import type { ChannelOpts } from './registry.js';

interface BotInstance {
  bot: Bot;
  token: string;
  folder: string;
  jid: string | null; // Set after first message or group registration
  botUserId: number | null; // Bot's own user ID (set after start)
}

class TelegramMultiBotChannel implements Channel {
  name = 'telegram';
  private bots: Map<string, BotInstance> = new Map(); // folder → BotInstance
  private jidToFolder: Map<string, string> = new Map(); // jid → folder
  private jidToThreadId: Map<string, number> = new Map(); // jid → last message_thread_id (for Topics/Forum support)
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private connected = false;

  constructor(
    opts: ChannelOpts,
    botConfigs: Array<{ folder: string; token: string }>,
  ) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;

    for (const cfg of botConfigs) {
      const bot = new Bot(cfg.token);
      this.bots.set(cfg.folder, {
        bot,
        token: cfg.token,
        folder: cfg.folder,
        jid: null,
        botUserId: null,
      });
    }
  }

  async connect(): Promise<void> {
    // Build JID → folder mapping from registered groups
    this.refreshJidMapping();

    const startPromises: Promise<void>[] = [];

    for (const [folder, instance] of this.bots) {
      // Set up message handler for this bot
      instance.bot.on('message', (ctx: Context) => {
        this.handleMessage(ctx, folder);
      });

      // Set up callback_query handler (inline keyboard button presses)
      instance.bot.on('callback_query', (ctx: Context) => {
        this.handleCallbackQuery(ctx, folder);
      });

      instance.bot.catch((err) => {
        logger.error(
          { folder, err: err.error },
          `Telegram bot error (${folder})`,
        );
      });

      // Start polling (non-blocking)
      const startPromise = instance.bot.start({
        onStart: (botInfo) => {
          instance.botUserId = botInfo.id;
          logger.info(
            { folder, botUsername: botInfo.username },
            `Telegram bot started: @${botInfo.username} → ${folder}`,
          );
        },
        drop_pending_updates: true,
      });

      // bot.start() doesn't resolve until stopped, so we don't await it
      // Instead we just let it run in the background
      startPromise.catch((err) => {
        logger.error(
          { folder, err },
          `Telegram bot polling failed (${folder})`,
        );
      });
    }

    this.connected = true;
    logger.info(
      { botCount: this.bots.size },
      'Telegram multi-bot channel connected',
    );
  }

  private refreshJidMapping(): void {
    const groups = this.registeredGroups();
    for (const [jid, group] of Object.entries(groups)) {
      if (jid.startsWith('tg:')) {
        this.jidToFolder.set(jid, group.folder);

        // Also update the bot instance's JID
        const instance = this.bots.get(group.folder);
        if (instance) {
          instance.jid = jid;
        }
      }
    }
  }

  private async handleCallbackQuery(
    ctx: Context,
    folder: string,
  ): Promise<void> {
    if (!ctx.callbackQuery) return;

    const cbq = ctx.callbackQuery;
    const chatId = cbq.message?.chat?.id;
    if (!chatId) return;

    const jid = `tg:${chatId}`;

    // Ownership check — same logic as handleMessage
    const registeredFolder = this.jidToFolder.get(jid);
    if (registeredFolder && registeredFolder !== folder) return;

    if (!registeredFolder) {
      this.jidToFolder.set(jid, folder);
    }

    const senderId = cbq.from.id.toString();
    const senderName = cbq.from.first_name || cbq.from.username || 'Unknown';
    const timestamp = new Date().toISOString();
    const data = cbq.data || '';

    // Expose callback data and ID to the agent so it can answer via IPC
    const content = JSON.stringify({
      _type: 'callback_query',
      data: ctx.callbackQuery.data,
      message_id: ctx.callbackQuery.message?.message_id,
      query_id: ctx.callbackQuery.id,
      from_name: senderName,
    });

    const chatName =
      cbq.message?.chat?.title ||
      ('first_name' in (cbq.message?.chat ?? {})
        ? (cbq.message!.chat as { first_name?: string }).first_name
        : undefined) ||
      `Chat ${chatId}`;
    const chatType = cbq.message?.chat?.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    this.onChatMetadata(jid, timestamp, chatName, 'telegram', isGroup);

    const msg: NewMessage = {
      id: cbq.id,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    await ctx.answerCallbackQuery();
    this.onMessage(jid, msg);
  }

  async answerCallbackQuery(
    jid: string,
    callbackQueryId: string,
    text?: string,
    showAlert?: boolean,
  ): Promise<void> {
    const folder = this.jidToFolder.get(jid);
    const instance = folder ? this.bots.get(folder) : undefined;
    if (!instance) {
      logger.warn(
        { jid, callbackQueryId },
        'No bot found to answer callback query',
      );
      return;
    }

    try {
      await instance.bot.api.answerCallbackQuery(callbackQueryId, {
        text,
        show_alert: showAlert,
      });
    } catch (err) {
      logger.error(
        { jid, callbackQueryId, err },
        'Failed to answer callback query',
      );
    }
  }

  private async handleMessage(ctx: Context, folder: string): Promise<void> {
    if (!ctx.message || !ctx.chat) return;

    const chatId = ctx.chat.id;
    const jid = `tg:${chatId}`;

    // Only process messages if this bot owns this group (registered folder matches)
    // This prevents conflicts when a bot is invited to another agent's group
    // (e.g., Alice bot in Nadi's group for dual-bot interaction)
    const registeredFolder = this.jidToFolder.get(jid);
    if (registeredFolder && registeredFolder !== folder) {
      // This group belongs to a different bot/folder — ignore the message
      return;
    }

    // Update JID mapping for this bot/folder (only for unregistered/new groups)
    const instance = this.bots.get(folder);
    if (instance && !instance.jid) {
      instance.jid = jid;
    }
    if (!registeredFolder) {
      this.jidToFolder.set(jid, folder);
    }

    // Extract message content
    const text = ctx.message.text || ctx.message.caption || '';

    // Download attachments (photos, documents, etc.)
    const attachments = await this.downloadAttachments(
      ctx,
      folder,
      ctx.message.message_id.toString(),
    );

    // Skip if no text and no attachments
    if (!text && attachments.length === 0) return;

    const senderId = ctx.message.from?.id?.toString() || 'unknown';
    const senderName =
      ctx.message.from?.first_name || ctx.message.from?.username || 'Unknown';
    const chatName =
      ctx.chat.title ||
      ctx.chat.first_name ||
      ctx.chat.username ||
      `Chat ${chatId}`;
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const msgId = ctx.message.message_id.toString();

    // Track message_thread_id for Forum/Topics support
    if (ctx.message.message_thread_id) {
      this.jidToThreadId.set(jid, ctx.message.message_thread_id);
    } else {
      // Message in General topic or non-forum group — clear thread tracking
      this.jidToThreadId.delete(jid);
    }

    // Report chat metadata
    this.onChatMetadata(jid, timestamp, chatName, 'telegram', isGroup);

    // Build and deliver message
    const msg: NewMessage = {
      id: msgId,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
      // Only mark as bot_message if from THIS group's own bot (prevents self-loops).
      // Messages from OTHER bots (cross-agent IPC) should be processed normally.
      is_bot_message:
        ctx.message.from?.is_bot === true &&
        instance?.botUserId != null &&
        ctx.message.from.id === instance.botUserId,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    this.onMessage(jid, msg);
  }

  private async downloadAttachments(
    ctx: Context,
    folder: string,
    msgId: string,
  ): Promise<Attachment[]> {
    if (!ctx.message) return [];

    const attachments: Attachment[] = [];
    const filesToDownload: Array<{
      fileId: string;
      filename: string;
      mimeType: string;
    }> = [];

    // Photos (array of sizes — take the largest)
    if (ctx.message.photo && ctx.message.photo.length > 0) {
      const largest = ctx.message.photo[ctx.message.photo.length - 1];
      filesToDownload.push({
        fileId: largest.file_id,
        filename: `photo_${msgId}.jpg`,
        mimeType: 'image/jpeg',
      });
    }

    // Documents (PDF, etc.)
    if (ctx.message.document) {
      filesToDownload.push({
        fileId: ctx.message.document.file_id,
        filename: ctx.message.document.file_name || `file_${msgId}`,
        mimeType: ctx.message.document.mime_type || 'application/octet-stream',
      });
    }

    // Voice messages
    if (ctx.message.voice) {
      filesToDownload.push({
        fileId: ctx.message.voice.file_id,
        filename: `voice_${msgId}.ogg`,
        mimeType: ctx.message.voice.mime_type || 'audio/ogg',
      });
    }

    // Video
    if (ctx.message.video) {
      filesToDownload.push({
        fileId: ctx.message.video.file_id,
        filename: ctx.message.video.file_name || `video_${msgId}.mp4`,
        mimeType: ctx.message.video.mime_type || 'video/mp4',
      });
    }

    // Sticker (as webp image)
    if (ctx.message.sticker && !ctx.message.sticker.is_animated) {
      filesToDownload.push({
        fileId: ctx.message.sticker.file_id,
        filename: `sticker_${msgId}.webp`,
        mimeType: 'image/webp',
      });
    }

    if (filesToDownload.length === 0) return [];

    // Find the bot instance for downloading
    const instance = this.bots.get(folder);
    if (!instance) return [];

    const attachDir = path.join(DATA_DIR, 'attachments', folder);
    fs.mkdirSync(attachDir, { recursive: true });

    for (const item of filesToDownload) {
      try {
        const file = await instance.bot.api.getFile(item.fileId);

        // Check file size
        if (file.file_size && file.file_size > MAX_ATTACHMENT_SIZE) {
          logger.warn(
            { folder, fileSize: file.file_size, filename: item.filename },
            'Attachment too large, skipping',
          );
          continue;
        }

        if (!file.file_path) {
          logger.warn(
            { folder, filename: item.filename },
            'No file_path from Telegram API',
          );
          continue;
        }

        // Download the file
        const url = `https://api.telegram.org/file/bot${instance.token}/${file.file_path}`;
        const response = await fetch(url);
        if (!response.ok) {
          logger.error(
            { folder, status: response.status, filename: item.filename },
            'Failed to download attachment',
          );
          continue;
        }

        // Sanitize filename
        const safeName = item.filename
          .replace(/\.\./g, '_')
          .replace(/[/\\]/g, '_');
        const diskName = `${msgId}-${safeName}`;
        const hostPath = path.join(attachDir, diskName);
        const containerPath = `/workspace/attachments/${diskName}`;

        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(hostPath, buffer);

        attachments.push({
          filename: safeName,
          mimeType: item.mimeType,
          hostPath,
          containerPath,
          size: buffer.length,
        });

        logger.info(
          { folder, filename: safeName, size: buffer.length },
          'Attachment downloaded',
        );
      } catch (err) {
        logger.error(
          { folder, filename: item.filename, err },
          'Error downloading attachment',
        );
      }
    }

    return attachments;
  }

  async sendMessage(
    jid: string,
    text: string,
    sender?: string,
    messageThreadId?: number,
  ): Promise<void> {
    const chatId = jid.replace('tg:', '');

    // If sender is specified, try to use the matching bot (lowercase sender = folder name)
    let instance: BotInstance | undefined;

    if (sender) {
      const senderFolder = sender.toLowerCase();
      instance = this.bots.get(senderFolder);
      if (instance) {
        logger.debug({ sender, senderFolder }, 'Using sender-specific bot');
      }
    }

    // Default: find the bot bound to this JID's folder
    if (!instance) {
      const folder = this.jidToFolder.get(jid);
      if (folder) {
        instance = this.bots.get(folder);
      }
    }

    // Fallback: try to find any bot that has this JID
    if (!instance) {
      for (const [, bot] of this.bots) {
        if (bot.jid === jid) {
          instance = bot;
          break;
        }
      }
    }

    if (!instance) {
      logger.error({ jid }, 'No bot found for JID');
      return;
    }

    // Build send options — include message_thread_id for Forum/Topics support
    // Explicit messageThreadId (from IPC) takes priority over cached thread ID
    const threadId = messageThreadId ?? this.jidToThreadId.get(jid);
    const sendOpts: Record<string, unknown> = { parse_mode: undefined };
    if (threadId) {
      sendOpts.message_thread_id = threadId;
    }

    // Helper: send with retry on transient errors (504, 429, network)
    const sendWithRetry = async (
      targetChatId: string,
      chunk: string,
      opts: Record<string, unknown>,
      maxRetries = 3,
    ) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await instance!.bot.api.sendMessage(targetChatId, chunk, opts);
          return;
        } catch (err: any) {
          const code = err?.error_code || err?.status;
          const isRetryable =
            code === 504 ||
            code === 502 ||
            code === 429 ||
            code === 503 ||
            !code;
          if (isRetryable && attempt < maxRetries) {
            const delay = code === 429 ? 5000 : 2000 * attempt;
            logger.warn(
              { chatId: targetChatId, attempt, code, delay },
              'Telegram sendMessage failed, retrying',
            );
            await new Promise((r) => setTimeout(r, delay));
          } else {
            logger.error(
              { chatId: targetChatId, attempt, code, err: err?.message || err },
              'Telegram sendMessage failed permanently',
            );
            return; // Don't crash — just drop the message
          }
        }
      }
    };

    // Split long messages (Telegram limit: 4096 chars)
    const MAX_LEN = 4096;
    if (text.length <= MAX_LEN) {
      await sendWithRetry(chatId, text, sendOpts);
    } else {
      // Split at newlines when possible
      let remaining = text;
      while (remaining.length > 0) {
        let chunk: string;
        if (remaining.length <= MAX_LEN) {
          chunk = remaining;
          remaining = '';
        } else {
          const splitAt = remaining.lastIndexOf('\n', MAX_LEN);
          if (splitAt > MAX_LEN * 0.5) {
            chunk = remaining.slice(0, splitAt);
            remaining = remaining.slice(splitAt + 1);
          } else {
            chunk = remaining.slice(0, MAX_LEN);
            remaining = remaining.slice(MAX_LEN);
          }
        }
        await sendWithRetry(chatId, chunk, sendOpts);
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async setReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const chatId = jid.replace('tg:', '');
    const folder = this.jidToFolder.get(jid);
    const instance = folder ? this.bots.get(folder) : undefined;
    if (!instance) return;

    try {
      await instance.bot.api.setMessageReaction(
        chatId,
        parseInt(messageId, 10),
        [{ type: 'emoji', emoji: emoji as any }],
      );
    } catch {
      // Ignore reaction errors (unsupported emoji, permissions, etc.)
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return; // Telegram doesn't have "stop typing"

    const chatId = jid.replace('tg:', '');
    const folder = this.jidToFolder.get(jid);
    const instance = folder ? this.bots.get(folder) : undefined;
    if (!instance) return;

    try {
      const threadId = this.jidToThreadId.get(jid);
      const opts: Record<string, unknown> = {};
      if (threadId) opts.message_thread_id = threadId;
      await instance.bot.api.sendChatAction(chatId, 'typing', opts);
    } catch {
      // Ignore typing errors
    }
  }

  async disconnect(): Promise<void> {
    for (const [folder, instance] of this.bots) {
      try {
        await instance.bot.stop();
        logger.info({ folder }, 'Telegram bot stopped');
      } catch {
        // Ignore
      }
    }
    this.connected = false;
  }
}

// --- Self-registration ---

function parseBotConfigs(): Array<{ folder: string; token: string }> | null {
  const env = readEnvFile(['TELEGRAM_BOTS', 'TELEGRAM_BOT_TOKEN']);

  // Multi-bot format: TELEGRAM_BOTS=folder1:botId1:tokenPart1,folder2:botId2:tokenPart2
  if (env.TELEGRAM_BOTS) {
    const configs: Array<{ folder: string; token: string }> = [];

    for (const entry of env.TELEGRAM_BOTS.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      // Format: folder:botId:tokenPart → token is "botId:tokenPart"
      const firstColon = trimmed.indexOf(':');
      if (firstColon === -1) {
        logger.warn(
          { entry: trimmed },
          'Invalid TELEGRAM_BOTS entry, expected folder:token',
        );
        continue;
      }

      const folder = trimmed.slice(0, firstColon);
      const token = trimmed.slice(firstColon + 1);

      if (!folder || !token) {
        logger.warn({ entry: trimmed }, 'Invalid TELEGRAM_BOTS entry');
        continue;
      }

      configs.push({ folder, token });
    }

    if (configs.length > 0) return configs;
  }

  // Fallback: single bot format
  if (env.TELEGRAM_BOT_TOKEN) {
    return [{ folder: '__default__', token: env.TELEGRAM_BOT_TOKEN }];
  }

  return null;
}

registerChannel('telegram', (opts) => {
  const configs = parseBotConfigs();
  if (!configs) {
    return null;
  }

  return new TelegramMultiBotChannel(opts, configs);
});
