import lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const MAX_SENT_MESSAGE_CHARS = 3500;
const MAX_SEEN_MESSAGE_IDS = 2000;

const NON_TEXT_PLACEHOLDERS: Record<string, string> = {
  image: '[Image]',
  file: '[File]',
  audio: '[Audio]',
  media: '[Media]',
  sticker: '[Sticker]',
  location: '[Location]',
  video: '[Video]',
  post: '[Post]',
};

interface FeishuSenderId {
  open_id?: string;
  user_id?: string;
  union_id?: string;
}

interface FeishuSender {
  sender_type?: string;
  sender_id?: FeishuSenderId;
}

interface FeishuMessage {
  message_id?: string;
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  create_time?: string;
}

interface FeishuMessageEvent {
  sender?: FeishuSender;
  message?: FeishuMessage;
}

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private readonly client: any;
  private readonly wsClient: any;
  private readonly opts: FeishuChannelOpts;
  private connected = false;
  private readonly seenIds = new Set<string>();
  private readonly seenQueue: string[] = [];

  constructor(
    appId: string,
    appSecret: string,
    opts: FeishuChannelOpts,
    domain?: string,
  ) {
    this.opts = opts;

    const sdkConfig = {
      appId,
      appSecret,
      ...(domain ? { domain } : {}),
    } as any;
    this.client = new lark.Client(sdkConfig);
    this.wsClient = new lark.WSClient(sdkConfig);
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        await this.handleInbound(data);
      },
    });

    const startResult = this.wsClient.start({ eventDispatcher });
    if (startResult && typeof startResult.catch === 'function') {
      startResult.catch((err: unknown) => {
        this.connected = false;
        logger.error({ err }, 'Feishu websocket client failed');
      });
    }
    this.connected = true;
    logger.info('Feishu channel connected (long connection)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'Feishu not connected, dropping outbound message');
      return;
    }

    const chatId = this.toChatId(jid);
    if (!chatId) {
      logger.warn({ jid }, 'Invalid Feishu JID');
      return;
    }

    try {
      const chunks = this.splitMessage(text, MAX_SENT_MESSAGE_CHARS);
      for (const chunk of chunks) {
        await this.sendText(chatId, chunk);
      }
      logger.info({ jid, chunks: chunks.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu outbound message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.wsClient?.stop) {
      this.wsClient.stop();
    }
    logger.info('Feishu channel stopped');
  }

  private async handleInbound(data: unknown): Promise<void> {
    try {
      const event = this.unwrapEvent(data);
      const message = event.message;
      const sender = event.sender;
      if (!message) return;

      const messageId = String(message.message_id || '').trim();
      const chatId = String(message.chat_id || '').trim();
      if (!messageId || !chatId) return;

      if (this.seenIds.has(messageId)) return;
      this.trackSeenMessageId(messageId);

      const senderType = String(sender?.sender_type || '').toLowerCase();
      if (senderType && senderType !== 'user') return;

      const chatJid = `fs:${chatId}`;
      const timestamp = this.toIsoTimestamp(message.create_time);
      const chatType = String(message.chat_type || '').toLowerCase();
      const isGroup = chatType !== 'p2p';
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

      const content = this.parseMessageContent(
        String(message.message_type || '').toLowerCase(),
        String(message.content || ''),
      );
      if (!content) return;

      if (this.isChatIdCommand(content)) {
        await this.sendText(
          chatId,
          `Chat ID: \`fs:${chatId}\`\nType: ${chatType || 'unknown'}`,
        );
        return;
      }

      let finalContent = content;
      if (
        isGroup &&
        this.messageMentionsBot(message.content) &&
        !TRIGGER_PATTERN.test(finalContent)
      ) {
        finalContent = `@${ASSISTANT_NAME} ${finalContent}`;
      }

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid }, 'Message from unregistered Feishu chat');
        return;
      }

      const senderId = this.extractSenderId(sender);
      const senderName = senderId || 'Feishu User';
      this.opts.onMessage(chatJid, {
        id: messageId,
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content: finalContent,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, sender: senderName }, 'Feishu message stored');
    } catch (err) {
      logger.error({ err }, 'Failed to handle Feishu inbound message');
    }
  }

  private unwrapEvent(data: unknown): FeishuMessageEvent {
    if (!data || typeof data !== 'object') return {};
    const asRecord = data as Record<string, unknown>;
    const event = asRecord.event;
    if (event && typeof event === 'object') {
      return event as FeishuMessageEvent;
    }
    return asRecord as FeishuMessageEvent;
  }

  private extractSenderId(sender: FeishuSender | undefined): string {
    if (!sender || !sender.sender_id) return '';
    const id = sender.sender_id;
    return String(id.open_id || id.user_id || id.union_id || '');
  }

  private parseMessageContent(messageType: string, rawContent: string): string {
    const payload = this.parseContentJson(rawContent);

    if (messageType === 'text') {
      const text = this.valueToString(payload.text || rawContent).trim();
      return text;
    }

    if (messageType === 'post') {
      const flattened = this.flattenPostContent(payload).trim();
      return flattened || NON_TEXT_PLACEHOLDERS.post;
    }

    const placeholder = NON_TEXT_PLACEHOLDERS[messageType];
    if (placeholder) {
      if (messageType === 'file') {
        const fileName = this.valueToString(payload.file_name).trim();
        return fileName ? `${placeholder}: ${fileName}` : placeholder;
      }
      return placeholder;
    }

    if (rawContent.trim()) {
      return rawContent.trim();
    }
    return `[${messageType || 'message'}]`;
  }

  private parseContentJson(rawContent: string): Record<string, unknown> {
    if (!rawContent) return {};
    try {
      const parsed = JSON.parse(rawContent);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Some message types may not be JSON; ignore parse failures.
    }
    return {};
  }

  private flattenPostContent(payload: Record<string, unknown>): string {
    const out: string[] = [];
    this.collectPostText(payload, out);
    return out.join(' ').replace(/\s+/g, ' ').trim();
  }

  private collectPostText(node: unknown, out: string[]): void {
    if (!node) return;
    if (typeof node === 'string') {
      const text = node.trim();
      if (text) out.push(text);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) this.collectPostText(item, out);
      return;
    }
    if (typeof node !== 'object') return;

    const obj = node as Record<string, unknown>;
    const tag = this.valueToString(obj.tag).trim().toLowerCase();
    if (tag === 'img') {
      out.push('[Image]');
      return;
    }
    if (tag === 'media') {
      out.push('[Media]');
      return;
    }

    if (obj.text) {
      const text = this.valueToString(obj.text).trim();
      if (text) out.push(text);
    }
    if (tag === 'at') {
      const mention =
        this.valueToString(obj.user_name).trim() ||
        this.valueToString(obj.user_id).trim() ||
        '@mention';
      out.push(mention.startsWith('@') ? mention : `@${mention}`);
    }

    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') {
        this.collectPostText(value, out);
      }
    }
  }

  private messageMentionsBot(rawContent: string | undefined): boolean {
    if (!rawContent) return false;
    const payload = this.parseContentJson(rawContent);
    const mentions = payload.mentions;
    if (!Array.isArray(mentions)) return false;
    return mentions.length > 0;
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    const body = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    };
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: body,
      });
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send Feishu message');
      throw err;
    }
  }

  private splitMessage(text: string, maxChars: number): string[] {
    const normalized = text.trim();
    if (!normalized) return ['(empty)'];
    if (normalized.length <= maxChars) return [normalized];

    const chunks: string[] = [];
    let current = '';
    for (const line of normalized.split('\n')) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length <= maxChars) {
        current = next;
        continue;
      }
      if (current) chunks.push(current);
      if (line.length <= maxChars) {
        current = line;
        continue;
      }
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
      }
      current = '';
    }
    if (current) chunks.push(current);
    return chunks;
  }

  private trackSeenMessageId(messageId: string): void {
    this.seenIds.add(messageId);
    this.seenQueue.push(messageId);
    while (this.seenQueue.length > MAX_SEEN_MESSAGE_IDS) {
      const oldest = this.seenQueue.shift();
      if (oldest) this.seenIds.delete(oldest);
    }
  }

  private isChatIdCommand(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return normalized === '/chatid' || normalized === 'chatid';
  }

  private toIsoTimestamp(raw: string | undefined): string {
    const value = Number(raw || 0);
    if (!Number.isFinite(value) || value <= 0) {
      return new Date().toISOString();
    }
    // Feishu create_time is milliseconds as string.
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }

  private toChatId(jid: string): string | null {
    if (!jid.startsWith('fs:')) return null;
    const chatId = jid.slice(3).trim();
    return chatId || null;
  }

  private valueToString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'LARK_APP_ID',
    'LARK_APP_SECRET',
    'FEISHU_DOMAIN',
  ]);

  const appId =
    process.env.FEISHU_APP_ID ||
    process.env.LARK_APP_ID ||
    envVars.FEISHU_APP_ID ||
    envVars.LARK_APP_ID ||
    '';
  const appSecret =
    process.env.FEISHU_APP_SECRET ||
    process.env.LARK_APP_SECRET ||
    envVars.FEISHU_APP_SECRET ||
    envVars.LARK_APP_SECRET ||
    '';
  const domain = process.env.FEISHU_DOMAIN || envVars.FEISHU_DOMAIN || '';

  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID/LARK_APP_ID or FEISHU_APP_SECRET/LARK_APP_SECRET not set');
    return null;
  }

  return new FeishuChannel(appId, appSecret, opts, domain || undefined);
});
