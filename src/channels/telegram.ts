import { readEnvValue } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
  reply_to_message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

function getTelegramToken(): string | undefined {
  return readEnvValue([
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_TOKEN',
    'TELEGRAM-TOKEN',
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSenderName(user?: TelegramUser): string {
  if (!user) return 'Unknown';
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return fullName || user.username || `Telegram User ${user.id}`;
}

function buildChatName(chat: TelegramChat): string {
  if (chat.title) return chat.title;
  const fullName = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  return fullName || chat.username || `Telegram ${chat.id}`;
}

function extractMessageText(message: TelegramMessage): string {
  return message.text || message.caption || '[non-text Telegram message]';
}

class TelegramChannel implements Channel {
  readonly name = 'telegram';

  private connected = false;
  private offset = 0;
  private botUserId: number | null = null;
  private pollPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private readonly opts: ChannelOpts,
    private readonly token: string,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;

    const me = await this.api<TelegramUser>('getMe');
    this.botUserId = me.id;
    this.connected = true;
    logger.info({ botUserId: me.id }, 'Telegram channel connected');
    this.pollPromise = this.pollLoop();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.abortController?.abort();
    try {
      await this.pollPromise;
    } catch {
      // ignore abort-related errors during shutdown
    }
    logger.info('Telegram channel disconnected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = this.chatIdFromJid(jid);
    await this.api('sendMessage', {
      method: 'POST',
      body: {
        chat_id: chatId,
        text,
      },
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const chatId = this.chatIdFromJid(jid);
    await this.api('sendChatAction', {
      method: 'POST',
      body: {
        chat_id: chatId,
        action: 'typing',
      },
    });
  }

  private chatIdFromJid(jid: string): number {
    if (!jid.startsWith('tg:')) {
      throw new Error(`Invalid Telegram JID: ${jid}`);
    }
    const raw = jid.slice(3);
    const chatId = Number(raw);
    if (!Number.isFinite(chatId)) {
      throw new Error(`Invalid Telegram chat ID: ${jid}`);
    }
    return chatId;
  }

  private async pollLoop(): Promise<void> {
    while (this.connected) {
      this.abortController = new AbortController();
      try {
        const updates = await this.api<TelegramUpdate[]>('getUpdates', {
          query: {
            timeout: '25',
            offset: String(this.offset),
            allowed_updates: JSON.stringify(['message', 'edited_message']),
          },
          signal: this.abortController.signal,
        });

        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.connected) break;
        if (err instanceof Error && err.name === 'AbortError') break;
        logger.warn({ err }, 'Telegram polling failed');
        await delay(2000);
      } finally {
        this.abortController = null;
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message || update.edited_message;
    if (!message) return;

    const chatJid = `tg:${message.chat.id}`;
    const timestamp = new Date(
      (message.edit_date || message.date) * 1000,
    ).toISOString();

    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      buildChatName(message.chat),
      'telegram',
      message.chat.type !== 'private',
    );

    const inbound: NewMessage = {
      id: String(message.message_id),
      chat_jid: chatJid,
      sender: message.from ? `tg:user:${message.from.id}` : chatJid,
      sender_name: buildSenderName(message.from),
      content: extractMessageText(message),
      timestamp,
      is_from_me:
        this.botUserId !== null && message.from?.id === this.botUserId,
      reply_to_message_id: message.reply_to_message
        ? String(message.reply_to_message.message_id)
        : undefined,
      reply_to_message_content: message.reply_to_message
        ? extractMessageText(message.reply_to_message)
        : undefined,
      reply_to_sender_name: message.reply_to_message?.from
        ? buildSenderName(message.reply_to_message.from)
        : undefined,
    };

    this.opts.onMessage(chatJid, inbound);
  }

  private async api<T>(
    method: string,
    options?: {
      method?: 'GET' | 'POST';
      query?: Record<string, string>;
      body?: Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const url = new URL(`https://api.telegram.org/bot${this.token}/${method}`);
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method: options?.method || 'GET',
      headers: options?.body
        ? { 'content-type': 'application/json; charset=utf-8' }
        : undefined,
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(`Telegram API ${method} failed with ${response.status}`);
    }

    const payload = (await response.json()) as TelegramApiResponse<T>;
    if (!payload.ok) {
      throw new Error(
        payload.description || `Telegram API ${method} returned ok=false`,
      );
    }

    return payload.result;
  }
}

registerChannel('telegram', (opts) => {
  const token = getTelegramToken();
  if (!token) return null;
  return new TelegramChannel(opts, token);
});
