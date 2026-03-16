import * as Lark from '@larksuiteoapi/node-sdk';

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

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private connected = false;
  private botOpenId = '';
  private userNameCache = new Map<string, string>();

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });

    // Fetch bot identity for @mention detection and is_from_me
    try {
      const botInfo = await (this.client as any).bot.v3.info.get();
      this.botOpenId = botInfo?.data?.bot?.open_id || '';
      logger.info(
        { botOpenId: this.botOpenId },
        'Feishu: bot identity resolved',
      );
    } catch (err) {
      logger.error(
        { err },
        'Feishu: failed to get bot info, @mention detection may not work',
      );
    }

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        if (!this.connected) return;
        await this.handleMessage(data);
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher });
    this.connected = true;
    logger.info('Feishu: connected via WebSocket');
  }

  private async handleMessage(data: any): Promise<void> {
    const message = data.message;
    const sender = data.sender;

    const chatId = message.chat_id;
    const chatType = message.chat_type;
    const messageType = message.message_type;
    const chatJid = `feishu:${chatId}`;
    const senderId = sender.sender_id?.open_id || '';
    const senderType = sender.sender_type;
    const timestamp = new Date(parseInt(message.create_time)).toISOString();
    const isGroup = chatType === 'group';

    // Always emit metadata for chat discovery
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

    // Only process messages from registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Feishu chat');
      return;
    }

    // Extract content based on message type
    let content: string;
    try {
      if (messageType === 'text') {
        const parsed = JSON.parse(message.content);
        content = parsed.text || '';
      } else {
        content = `[Unsupported: ${messageType}]`;
      }
    } catch {
      content = message.content || `[${messageType}]`;
    }

    // Resolve sender name
    const senderName = await this.resolveSenderName(senderId);

    this.opts.onMessage(chatJid, {
      id: message.message_id,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: senderId === this.botOpenId,
      is_bot_message: senderType !== 'user',
    });

    logger.info({ chatJid, sender: senderName }, 'Feishu message stored');
  }

  private async resolveSenderName(openId: string): Promise<string> {
    if (!openId) return 'Unknown';

    const cached = this.userNameCache.get(openId);
    if (cached) return cached;

    try {
      const res = await this.client!.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      } as any);
      const name = (res as any)?.data?.user?.name || openId;
      this.userNameCache.set(openId, name);
      return name;
    } catch (err) {
      logger.warn({ openId, err }, 'Feishu: failed to resolve sender name');
      this.userNameCache.set(openId, openId);
      return openId;
    }
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    throw new Error('Not implemented');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsClient = null;
    this.client = null;
    logger.info('Feishu: disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu API does not support typing indicators
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }
  return new FeishuChannel(appId, appSecret, opts);
});
