import { Telegraf } from 'telegraf';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { Channel, NewMessage } from '../types.js';

import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

// Voice transcription config (local whisper service)
const VOICE_TRANSCRIPTION_ENABLED =
  (process.env.VOICE_TRANSCRIPTION_ENABLED ?? 'true') === 'true';
const VOICE_TRANSCRIPTION_ENDPOINT =
  process.env.VOICE_TRANSCRIPTION_ENDPOINT ??
  'http://localhost:8787/transcribe';
const VOICE_TRANSCRIPTION_TIMEOUT = 30_000; // 30 seconds

export function createTelegramChannel(opts: ChannelOpts): Channel | null {
  const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    logger.info('TELEGRAM_BOT_TOKEN not set — skipping Telegram channel');
    return null;
  }

  const bot = new Telegraf(token);
  let connected = false;

  // Outgoing queue for messages sent while disconnected
  const outgoingQueue: Array<{ jid: string; text: string }> = [];

  // Thinking indicator: jid -> interval timer for sendChatAction
  const thinkingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  function extractChatId(jid: string): string {
    return jid.replace(/^telegram:/, '');
  }

  function resolveSenderName(from: {
    first_name?: string;
    last_name?: string;
    username?: string;
    id: number;
  }): string {
    if (from.first_name) {
      return from.last_name
        ? `${from.first_name} ${from.last_name}`
        : from.first_name;
    }
    return from.username || String(from.id);
  }

  async function flushQueue(): Promise<void> {
    while (outgoingQueue.length > 0) {
      const item = outgoingQueue.shift()!;
      try {
        await channel.sendMessage(item.jid, item.text);
      } catch (err) {
        logger.error({ err, jid: item.jid }, 'Failed to flush queued message');
      }
    }
  }

  async function syncChannelMetadata(): Promise<void> {
    const groups = opts.registeredGroups();
    for (const jid of Object.keys(groups)) {
      if (!jid.startsWith('telegram:')) continue;
      const chatId = extractChatId(jid);
      try {
        const chat = await bot.telegram.getChat(chatId);
        if ('title' in chat && chat.title) {
          updateChatName(jid, chat.title);
          logger.debug(
            { jid, title: chat.title },
            'Synced Telegram group metadata',
          );
        }
      } catch (err) {
        logger.debug({ err, jid }, 'Failed to sync Telegram group metadata');
      }
    }
  }

  /**
   * Download a Telegram file and transcribe it via the local whisper service.
   * Returns transcribed text on success, null on failure.
   */
  async function transcribeVoiceMessage(
    fileId: string,
    duration?: number,
  ): Promise<string | null> {
    if (!VOICE_TRANSCRIPTION_ENABLED) {
      logger.debug('Voice transcription disabled via config');
      return null;
    }

    try {
      // Download file from Telegram
      const fileLink = await bot.telegram.getFileLink(fileId);
      const fileUrl = fileLink.href;

      logger.info(
        { fileId, duration },
        'Downloading Telegram voice message for transcription',
      );

      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) {
        logger.warn(
          { fileId, status: fileResponse.status },
          'Failed to download Telegram voice file',
        );
        return null;
      }

      const audioBuffer = Buffer.from(await fileResponse.arrayBuffer());

      // POST to local whisper service
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer]), 'voice.ogg');

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        VOICE_TRANSCRIPTION_TIMEOUT,
      );

      try {
        const whisperResponse = await fetch(VOICE_TRANSCRIPTION_ENDPOINT, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!whisperResponse.ok) {
          const errBody = await whisperResponse.text().catch(() => 'unknown');
          logger.warn(
            { fileId, status: whisperResponse.status, error: errBody },
            'Voice transcription failed: whisper service error',
          );
          return null;
        }

        const result = (await whisperResponse.json()) as {
          text: string;
          language: string;
          duration_seconds: number;
        };

        logger.info(
          {
            fileId,
            language: result.language,
            processingTime: result.duration_seconds.toFixed(1),
            textLength: result.text.length,
          },
          'Voice message transcribed successfully',
        );

        return result.text;
      } catch (err) {
        clearTimeout(timeout);
        if ((err as Error).name === 'AbortError') {
          logger.warn(
            { fileId, timeout: VOICE_TRANSCRIPTION_TIMEOUT },
            'Voice transcription timed out',
          );
        } else {
          logger.warn(
            { err, fileId },
            'Voice transcription failed: whisper service unreachable',
          );
        }
        return null;
      }
    } catch (err) {
      logger.warn(
        { err, fileId },
        'Voice transcription failed: could not download file',
      );
      return null;
    }
  }

  // Set up message handler
  bot.on('message', async (ctx) => {
    const msg = ctx.message;

    // Extract content from text, voice, or audio messages
    let messageContent: string | null = null;
    if ('text' in msg && msg.text) {
      messageContent = msg.text;
    } else if ('voice' in msg && msg.voice) {
      const v = msg.voice as { file_id: string; duration?: number };
      const dur = v.duration ? ` duration=${v.duration}s` : '';

      // Attempt local transcription
      const transcription = await transcribeVoiceMessage(v.file_id, v.duration);
      if (transcription) {
        messageContent = `[Voice message transcription]:\n${transcription}`;
      } else {
        // Fallback: pass file_id for manual transcription via MCP tool
        messageContent = `[Voice message: telegram_file_id=${v.file_id}${dur}. Use transcribe_audio with this file_id to read what was said.]`;
      }
    } else if ('audio' in msg && msg.audio) {
      const a = msg.audio as {
        file_id: string;
        duration?: number;
        title?: string;
      };
      const dur = a.duration ? ` duration=${a.duration}s` : '';

      // Attempt local transcription for audio files too
      const transcription = await transcribeVoiceMessage(a.file_id, a.duration);
      if (transcription) {
        messageContent = `[Audio transcription]:\n${transcription}`;
      } else {
        messageContent = `[Audio file: telegram_file_id=${a.file_id}${dur}${a.title ? ` title="${a.title}"` : ''}. Use transcribe_audio with this file_id.]`;
      }
    }
    if (!messageContent) return;

    const chatId = String(msg.chat.id);
    const jid = `telegram:${chatId}`;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const timestamp = new Date(msg.date * 1000).toISOString();

    // Chat name: title for groups, sender name for DMs
    const chatName =
      isGroup && 'title' in msg.chat ? msg.chat.title : undefined;

    // Always report metadata
    opts.onChatMetadata(jid, timestamp, chatName, 'telegram', isGroup);

    // Only deliver messages for registered groups
    const group = opts.registeredGroups()[jid];
    if (!group) return;

    // Detect self-messages
    const isFromMe = msg.from?.id === bot.botInfo?.id;

    // Resolve sender
    const from = msg.from || { id: 0 };
    const senderName = resolveSenderName(
      from as {
        first_name?: string;
        last_name?: string;
        username?: string;
        id: number;
      },
    );
    const sender = from.username || String(from.id);

    let content = messageContent;

    // Handle /x command: strip prefix and prepend assistant name
    if (content.startsWith('/x ') || content === '/x') {
      const rest = content === '/x' ? '' : content.slice(3);
      content = `@${ASSISTANT_NAME} ${rest}`.trimEnd();
    }
    // Handle @botusername mention translation
    else if (
      bot.botInfo?.username &&
      content.includes(`@${bot.botInfo.username}`)
    ) {
      if (!TRIGGER_PATTERN.test(content)) {
        content = content.replace(
          new RegExp(`@${bot.botInfo.username}`, 'g'),
          `@${ASSISTANT_NAME}`,
        );
        // If it doesn't start with the trigger after replacement, prepend it
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }
    }

    // Check trigger pattern for groups that require it
    const requiresTrigger =
      group.requiresTrigger !== undefined ? group.requiresTrigger : isGroup;
    if (requiresTrigger && !isFromMe && !TRIGGER_PATTERN.test(content)) {
      // Still store the message but don't trigger the agent
      const newMsg: NewMessage = {
        id: String(msg.message_id),
        chat_jid: jid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isFromMe,
      };
      opts.onMessage(jid, newMsg);
      return;
    }

    const newMsg: NewMessage = {
      id: String(msg.message_id),
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isFromMe,
      is_bot_message: isFromMe,
    };

    opts.onMessage(jid, newMsg);

    // Show early thinking indicator for messages that will trigger the agent
    if (!isFromMe && TRIGGER_PATTERN.test(content)) {
      channel.setTyping?.(jid, true).catch((err) => {
        logger.debug({ err, jid }, 'Failed to send thinking indicator');
      });
    }
  });

  const channel: Channel & {
    setTyping: (jid: string, isTyping: boolean) => Promise<void>;
    syncGroups: (force: boolean) => Promise<void>;
  } = {
    name: 'telegram',

    async connect(): Promise<void> {
      // Resolve bot info first (launch() starts polling and never resolves)
      const me = await bot.telegram.getMe();
      (bot as unknown as { botInfo: typeof me }).botInfo = me;
      logger.info({ username: me.username }, 'Telegram bot connected');

      if (VOICE_TRANSCRIPTION_ENABLED) {
        logger.info(
          { endpoint: VOICE_TRANSCRIPTION_ENDPOINT },
          'Voice transcription enabled (local whisper)',
        );
      }

      // Start polling in background (does not return)
      bot.launch().catch((err) => {
        logger.error({ err }, 'Telegram polling error');
      });
      connected = true;
      await syncChannelMetadata();
      await flushQueue();
    },

    async sendMessage(jid: string, text: string): Promise<void> {
      if (!connected) {
        outgoingQueue.push({ jid, text });
        return;
      }

      const chatId = extractChatId(jid);

      // Split long messages
      if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
        await bot.telegram.sendMessage(chatId, text);
      } else {
        for (let i = 0; i < text.length; i += TELEGRAM_MAX_MESSAGE_LENGTH) {
          const chunk = text.slice(i, i + TELEGRAM_MAX_MESSAGE_LENGTH);
          await bot.telegram.sendMessage(chatId, chunk);
        }
      }
    },

    isConnected(): boolean {
      return connected;
    },

    ownsJid(jid: string): boolean {
      return jid.startsWith('telegram:');
    },

    async disconnect(): Promise<void> {
      bot.stop();
      connected = false;
    },

    async setTyping(jid: string, isTyping: boolean): Promise<void> {
      const chatId = extractChatId(jid);
      try {
        if (isTyping) {
          // Dedup: skip if already showing typing for this chat
          if (thinkingIntervals.has(jid)) return;
          // Send immediately, then repeat every 4s (Telegram expires after 5s)
          await bot.telegram.sendChatAction(chatId, 'typing');
          const interval = setInterval(() => {
            bot.telegram.sendChatAction(chatId, 'typing').catch(() => {});
          }, 4000);
          thinkingIntervals.set(jid, interval);
        } else {
          const interval = thinkingIntervals.get(jid);
          if (interval) {
            clearInterval(interval);
            thinkingIntervals.delete(jid);
          }
        }
      } catch (err) {
        logger.debug({ err, jid, isTyping }, 'Thinking indicator error');
      }
    },

    async syncGroups(_force: boolean): Promise<void> {
      await syncChannelMetadata();
    },
  };

  return channel;
}

// Self-register
registerChannel('telegram', (opts) => createTelegramChannel(opts));
