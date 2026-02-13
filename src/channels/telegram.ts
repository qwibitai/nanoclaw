import { logger } from '../logger.js';
import { toCanonicalConversationId } from '../conversation.js';
import {
  Channel,
  ChannelCapabilities,
  ChannelFactoryOpts,
  MessageAttachment,
} from '../types.js';

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
  is_bot?: boolean;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{
    file_id: string;
    file_size?: number;
    width?: number;
    height?: number;
  }>;
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video?: {
    file_id: string;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    mime_type?: string;
    file_size?: number;
    file_name?: string;
  };
  from?: TelegramUser;
  chat: TelegramChat;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
const TELEGRAM_RETRY_DELAY_MS = 1000;

function toIsoTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function chatDisplayName(chat: TelegramChat): string {
  return chat.title || chat.username || String(chat.id);
}

function senderDisplayName(user: TelegramUser | undefined): string {
  if (!user) return 'unknown';
  return user.username || user.first_name || String(user.id);
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false;
  capabilities: ChannelCapabilities = {
    typing: true,
    metadataSync: false,
    groupDiscovery: true,
    attachments: true,
    deliveryMode: 'polling',
  };

  private readonly opts: ChannelFactoryOpts;
  private readonly token: string;
  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopRequested = false;
  private updateOffset = 0;
  private botUserId: number | null = null;
  private chatTypes = new Map<string, TelegramChat['type']>();

  constructor(opts: ChannelFactoryOpts) {
    this.opts = opts;
    this.token = process.env.TELEGRAM_BOT_TOKEN || '';
  }

  async connect(): Promise<void> {
    if (!this.token) {
      throw new Error(
        'TELEGRAM_BOT_TOKEN is required when CHANNEL_PROVIDER=telegram',
      );
    }

    const me = await this.apiCall<TelegramUser>('getMe');
    this.botUserId = me.id;
    this.connected = true;
    this.stopRequested = false;
    this.startPolling(0);
    logger.info(
      { botId: this.botUserId },
      'Connected to Telegram Bot API',
    );
  }

  async disconnect(): Promise<void> {
    this.stopRequested = true;
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return /^-?\d+$/.test(jid);
  }

  isGroupChat(jid: string): boolean {
    const knownType = this.chatTypes.get(jid);
    if (knownType) {
      return knownType === 'group' || knownType === 'supergroup';
    }
    // Telegram groups/supergroups are negative IDs.
    return jid.startsWith('-');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.apiCall('sendMessage', {
      chat_id: jid,
      text,
      disable_web_page_preview: true,
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    try {
      await this.apiCall('sendChatAction', {
        chat_id: jid,
        action: 'typing',
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to set Telegram typing status');
    }
  }

  async syncGroupMetadata(_force = false): Promise<void> {
    // Telegram Bot API has no direct "list all chats" endpoint.
    // Metadata is learned progressively from incoming updates.
  }

  private startPolling(delayMs: number): void {
    if (this.stopRequested) return;
    this.pollTimer = setTimeout(() => {
      this.pollUpdates().catch((err) => {
        logger.error({ err }, 'Telegram poll cycle failed');
      });
    }, delayMs);
  }

  private async pollUpdates(): Promise<void> {
    if (this.stopRequested) return;

    try {
      const updates = await this.apiCall<TelegramUpdate[]>('getUpdates', {
        timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
        offset: this.updateOffset,
        allowed_updates: ['message'],
      });

      for (const update of updates) {
        this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
        await this.handleUpdate(update);
      }

      this.startPolling(0);
    } catch (err) {
      logger.error({ err }, 'Telegram polling error');
      this.startPolling(TELEGRAM_RETRY_DELAY_MS);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message) return;

    const chatId = String(message.chat.id);
    this.chatTypes.set(chatId, message.chat.type);

    const timestamp = toIsoTimestamp(message.date);
    this.opts.onChatMetadata(chatId, timestamp, chatDisplayName(message.chat));

    const groups = this.opts.registeredGroups();
    const canonicalChatId = toCanonicalConversationId(this.name, chatId);
    if (!groups[canonicalChatId]) return;

    const content = message.text || message.caption || '';
    const attachments = extractAttachments(message);
    const sender = message.from ? String(message.from.id) : 'unknown';
    const senderName = senderDisplayName(message.from);
    const isFromMe = !!(
      message.from?.is_bot &&
      this.botUserId !== null &&
      message.from.id === this.botUserId
    );

    this.opts.onMessage(chatId, {
      id: String(message.message_id),
      chat_jid: chatId,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isFromMe,
      attachments,
    });
  }

  private async apiCall<T>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
    });

    if (!response.ok) {
      throw new Error(
        `Telegram API HTTP ${response.status} for ${method}`,
      );
    }

    const parsed = (await response.json()) as TelegramApiResponse<T>;
    if (!parsed.ok) {
      throw new Error(
        `Telegram API error for ${method}: ${parsed.description || 'unknown error'}`,
      );
    }

    return parsed.result;
  }
}

function extractAttachments(message: TelegramMessage): MessageAttachment[] {
  const attachments: MessageAttachment[] = [];

  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    attachments.push({
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: largest.file_size,
    });
  }

  if (message.document) {
    attachments.push({
      kind: 'document',
      mimeType: message.document.mime_type,
      fileName: message.document.file_name,
      sizeBytes: message.document.file_size,
    });
  }

  if (message.video) {
    attachments.push({
      kind: 'video',
      mimeType: message.video.mime_type,
      sizeBytes: message.video.file_size,
    });
  }

  if (message.audio) {
    attachments.push({
      kind: 'audio',
      mimeType: message.audio.mime_type,
      fileName: message.audio.file_name,
      sizeBytes: message.audio.file_size,
    });
  }

  return attachments;
}
