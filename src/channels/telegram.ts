import https from 'https';

import { Bot, InputFile } from 'grammy';

import {
  LIVE_LOCATION_IDLE_TIMEOUT_MS,
  LIVE_LOCATION_LOG_DIR,
} from '../config.js';
import { registerModelFlow } from './telegram/commands/model-flow.js';
import { registerSimpleCommands } from './telegram/commands/simple.js';
import { registerStatusCommand } from './telegram/commands/status.js';
import { registerTasksCommand } from './telegram/commands/tasks.js';
import { registerLocationHandlers } from './telegram/handlers/location.js';
import { registerMediaHandlers } from './telegram/handlers/media.js';
import { registerTextHandler } from './telegram/handlers/text.js';
import { downloadTelegramFile } from './telegram/download.js';
import { sendLongTelegramMessage } from './telegram/send.js';
import {
  LiveLocationManager,
  _setActiveLiveLocationManager,
} from '../live-location.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts, StatusInfo } from './registry.js';
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
  getStatus: () => StatusInfo;
  sendIpcMessage: (chatJid: string, text: string) => boolean;
  clearSession: (groupFolder: string, chatJid: string) => void;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private liveLocation: LiveLocationManager | null = null;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /** Download helper — thin wrapper so handlers read consistent syntax. */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;
    return downloadTelegramFile(
      this.bot.api,
      this.botToken,
      fileId,
      groupFolder,
      filename,
    );
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    this.liveLocation = new LiveLocationManager({
      logDir: LIVE_LOCATION_LOG_DIR,
      idleTimeoutMs: LIVE_LOCATION_IDLE_TIMEOUT_MS,
      onTimeout: (chatJid) => {
        void this.sendMessage(chatJid, '📍 Live location sharing timeout.');
      },
      onStopped: (chatJid) => {
        void this.sendMessage(
          chatJid,
          '📍 Live location sharing stopped by user.',
        );
      },
    });
    this.liveLocation.initialize();
    _setActiveLiveLocationManager(this.liveLocation);

    // All /commands live under ./telegram/commands/*
    registerSimpleCommands(this.bot, { opts: this.opts });
    registerModelFlow(this.bot, {
      registeredGroups: this.opts.registeredGroups,
    });
    registerStatusCommand(this.bot, { opts: this.opts });
    registerTasksCommand(this.bot, { opts: this.opts });

    // Message/media/location handlers live under ./telegram/handlers/*
    registerTextHandler(this.bot, { opts: this.opts });
    const mediaDeps = {
      opts: this.opts,
      downloadFile: (fileId: string, folder: string, filename: string) =>
        this.downloadFile(fileId, folder, filename),
    };
    registerMediaHandlers(this.bot, mediaDeps);
    registerLocationHandlers(this.bot, {
      ...mediaDeps,
      liveLocation: this.liveLocation,
      sendMessage: (jid, text, threadId) =>
        this.sendMessage(jid, text, threadId),
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Register slash commands in Telegram's command menu.
    // Clear all scoped commands first to remove stale entries from previous
    // setups (e.g. OpenClaw), then set the canonical list on default scope.
    const commands = [
      { command: 'chatid', description: 'Show chat ID for registration' },
      { command: 'ping', description: 'Check bot status' },
      {
        command: 'model',
        description: 'Configure model, effort, and thinking',
      },
      { command: 'status', description: 'Show system status' },
      { command: 'compact', description: 'Compact conversation context' },
      { command: 'clear', description: 'Clear conversation session' },
      { command: 'tasks', description: 'List scheduled tasks' },
    ];
    const scopesToClear = [
      { type: 'all_private_chats' as const },
      { type: 'all_group_chats' as const },
      { type: 'all_chat_administrators' as const },
    ];
    await Promise.all([
      ...scopesToClear.map((scope) =>
        this.bot!.api.deleteMyCommands({ scope }).catch(() => {}),
      ),
      this.bot!.api.setMyCommands(commands),
    ]);

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

      await sendLongTelegramMessage(this.bot.api, numericId, text, options);
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendPhoto(jid: string, photo: string, caption?: string): Promise<void> {
    if (!this.bot) return;
    const numericId = jid.replace(/^tg:/, '');
    try {
      const input = photo.startsWith('http') ? photo : new InputFile(photo);
      const options: Record<string, unknown> = {};
      if (caption) {
        options.caption = caption;
        options.parse_mode = 'Markdown';
      }
      await this.bot.api.sendPhoto(numericId, input, options);
      logger.info({ jid, photo }, 'Telegram photo sent');
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.error({ jid, photo, err }, 'Failed to send Telegram photo');
      // Fallback: send caption as text
      if (caption) {
        await this.sendMessage(jid, caption);
      }
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
      this.liveLocation?.destroy();
      this.liveLocation = null;
      _setActiveLiveLocationManager(null);
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async sendStreamMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<number | null> {
    if (!this.bot) return null;
    const numericId = jid.replace(/^tg:/, '');
    const options = threadId
      ? { message_thread_id: parseInt(threadId, 10) }
      : {};
    try {
      const msg = await this.bot.api.sendMessage(numericId, text, {
        ...options,
        parse_mode: 'Markdown',
      });
      return msg.message_id;
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      // Markdown failed — fall back to plain text
      try {
        const msg = await this.bot.api.sendMessage(numericId, text, options);
        return msg.message_id;
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err2) {
        logger.error({ jid, err2 }, 'Failed to send streaming message');
        return null;
      }
    }
  }

  async editMessage(
    jid: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    if (!this.bot) return;
    const numericId = jid.replace(/^tg:/, '');

    const MAX_RETRIES = 2;
    const INITIAL_BACKOFF_MS = 1000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.bot.api.editMessageText(numericId, messageId, text, {
          parse_mode: 'Markdown',
        });
        return;
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        // Telegram throws 400 when content is unchanged — that's fine
        if (String(err).includes('message is not modified')) return;

        // 429 rate limit — retry with exponential backoff (#27)
        if (String(err).includes('429') && attempt < MAX_RETRIES) {
          const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          logger.debug(
            { jid, messageId, attempt, delay },
            'Rate limited on edit, retrying',
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Non-429 error or retries exhausted — try plain text once.
        // If this also throws, the error propagates to the caller (#27).
        await this.bot.api.editMessageText(numericId, messageId, text);
        return;
      }
    }
  }

  async deleteMessage(jid: string, messageId: number): Promise<void> {
    if (!this.bot) return;
    const numericId = jid.replace(/^tg:/, '');
    await this.bot.api.deleteMessage(numericId, messageId);
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
