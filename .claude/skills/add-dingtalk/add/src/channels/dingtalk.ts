import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';

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

const MAX_MESSAGE_LENGTH = 4000;

interface DingTalkRobotMessage {
  msgId?: string;
  msgtype?: string;
  conversationId?: string;
  conversationType?: string;
  conversationTitle?: string;
  conversationName?: string;
  senderId?: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId?: string;
  createAt?: number;
  isInAtList?: boolean;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  text?: {
    content?: string;
  };
  content?: {
    fileName?: string;
  };
  richText?: Array<{
    text?: string;
  }>;
}

interface DingTalkStreamEnvelope {
  data: string | DingTalkRobotMessage;
  headers?: {
    messageId?: string;
  };
}

interface SessionWebhookCacheEntry {
  webhook: string;
  expiresAt: number;
}

export interface DingTalkChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DingTalkChannel implements Channel {
  name = 'dingtalk';

  private client: any | null = null;
  private connected = false;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly opts: DingTalkChannelOpts;
  private readonly sessionWebhooks = new Map<string, SessionWebhookCacheEntry>();

  constructor(
    clientId: string,
    clientSecret: string,
    opts: DingTalkChannelOpts,
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new DWClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });

    this.client.registerCallbackListener(
      TOPIC_ROBOT,
      async (payload: DingTalkStreamEnvelope) => {
        await this.handleRobotMessage(payload);
      },
    );

    await Promise.resolve(this.client.connect());
    this.connected = true;

    logger.info('DingTalk bot connected');
    console.log('\n  DingTalk bot connected');
    console.log('  In a DingTalk group, @ the bot and send /chatid\n');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn({ jid }, 'DingTalk client not initialized');
      return;
    }

    const entry = this.getSessionWebhook(jid);
    if (!entry) {
      logger.warn(
        { jid },
        'No active DingTalk session webhook for conversation; cannot send',
      );
      return;
    }

    try {
      await this.postText(entry.webhook, text);
      logger.info({ jid, length: text.length }, 'DingTalk message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send DingTalk message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('ding:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.client && typeof this.client.disconnect === 'function') {
      await Promise.resolve(this.client.disconnect());
    }

    this.client = null;
    this.sessionWebhooks.clear();
    logger.info('DingTalk bot disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // DingTalk app bots do not expose a typing indicator in this integration path.
  }

  private async handleRobotMessage(
    payload: DingTalkStreamEnvelope,
  ): Promise<void> {
    const raw = this.parsePayload(payload);
    if (!raw?.conversationId) {
      logger.warn({ payload }, 'Invalid DingTalk robot payload');
      return;
    }

    const chatJid = `ding:${raw.conversationId}`;
    const isGroup = this.isGroupConversation(raw.conversationType);
    const timestamp = new Date(raw.createAt || Date.now()).toISOString();
    const sender = raw.senderStaffId || raw.senderId || '';
    const senderName =
      raw.senderNick || raw.senderStaffId || raw.senderId || 'Unknown';
    const chatName = isGroup
      ? raw.conversationTitle || raw.conversationName || chatJid
      : raw.senderNick || raw.conversationTitle || raw.conversationName || chatJid;

    this.rememberSessionWebhook(chatJid, raw);
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'dingtalk', isGroup);

    if (raw.chatbotUserId && raw.senderId === raw.chatbotUserId) {
      logger.debug({ chatJid }, 'Ignoring DingTalk bot self-message');
      return;
    }

    const rawText = this.extractRawText(raw).trim();
    if (rawText === '/chatid' || rawText === 'chatid') {
      await this.replyWithChatId(chatJid, isGroup);
      return;
    }

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid, chatName }, 'Message from unregistered DingTalk chat');
      return;
    }

    const content = this.normalizeInboundContent(raw, rawText);
    const messageId = raw.msgId || payload.headers?.messageId || timestamp;

    this.opts.onMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, chatName, sender: senderName }, 'DingTalk message stored');
  }

  private parsePayload(
    payload: DingTalkStreamEnvelope,
  ): DingTalkRobotMessage | null {
    try {
      return typeof payload.data === 'string'
        ? (JSON.parse(payload.data) as DingTalkRobotMessage)
        : payload.data;
    } catch (err) {
      logger.error({ err, payload }, 'Failed to parse DingTalk payload');
      return null;
    }
  }

  private extractRawText(raw: DingTalkRobotMessage): string {
    const msgtype = (raw.msgtype || '').toLowerCase();

    if (msgtype === 'text') {
      return raw.text?.content || '';
    }

    if (msgtype === 'richtext') {
      return (raw.richText || [])
        .map((block) => block.text || '')
        .join('\n')
        .trim();
    }

    if (msgtype === 'file') {
      const name = raw.content?.fileName || 'file';
      return `[File: ${name}]`;
    }

    if (msgtype === 'picture' || msgtype === 'image') {
      return '[Image]';
    }

    if (msgtype === 'audio') {
      return '[Audio]';
    }

    if (msgtype === 'video') {
      return '[Video]';
    }

    return `[DingTalk ${raw.msgtype || 'message'}]`;
  }

  private normalizeInboundContent(
    raw: DingTalkRobotMessage,
    rawText: string,
  ): string {
    let content = rawText || `[DingTalk ${raw.msgtype || 'message'}]`;

    if (raw.isInAtList && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    return content.trim();
  }

  private isGroupConversation(conversationType?: string): boolean {
    if (conversationType === '2') return false;
    return true;
  }

  private rememberSessionWebhook(
    chatJid: string,
    raw: DingTalkRobotMessage,
  ): void {
    if (!raw.sessionWebhook) return;

    const expiresAt =
      raw.sessionWebhookExpiredTime && raw.sessionWebhookExpiredTime > 0
        ? raw.sessionWebhookExpiredTime
        : Date.now() + 15 * 60 * 1000;

    this.sessionWebhooks.set(chatJid, {
      webhook: raw.sessionWebhook,
      expiresAt,
    });
  }

  private getSessionWebhook(
    chatJid: string,
  ): SessionWebhookCacheEntry | undefined {
    const entry = this.sessionWebhooks.get(chatJid);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.sessionWebhooks.delete(chatJid);
      return undefined;
    }

    return entry;
  }

  private async replyWithChatId(
    chatJid: string,
    isGroup: boolean,
  ): Promise<void> {
    const text = `Chat ID: ${chatJid}\nType: ${isGroup ? 'group' : 'private'}`;
    const entry = this.getSessionWebhook(chatJid);

    if (!entry) {
      logger.warn({ chatJid }, 'Cannot reply to /chatid without a session webhook');
      return;
    }

    await this.postText(entry.webhook, text);
  }

  private async postText(webhook: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('DingTalk client not initialized');
    }

    const accessToken = await Promise.resolve(this.client.getAccessToken());
    const chunks = this.chunkText(text);

    for (const chunk of chunks) {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: chunk },
        }),
      });

      if (!response.ok) {
        throw new Error(`DingTalk webhook returned ${response.status}`);
      }
    }
  }

  private chunkText(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];

    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
    }
    return chunks;
  }
}

registerChannel('dingtalk', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET']);
  const clientId =
    process.env.DINGTALK_CLIENT_ID || envVars.DINGTALK_CLIENT_ID || '';
  const clientSecret =
    process.env.DINGTALK_CLIENT_SECRET || envVars.DINGTALK_CLIENT_SECRET || '';

  if (!clientId || !clientSecret) {
    logger.warn(
      'DingTalk: DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET must be set',
    );
    return null;
  }

  return new DingTalkChannel(clientId, clientSecret, opts);
});
