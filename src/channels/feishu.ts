import * as lark from '@larksuiteoapi/node-sdk';

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

  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Initialize Feishu client
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    // Initialize WebSocket client for event subscription
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    // Create event dispatcher
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        logger.info({ event: 'im.message.receive_v1' }, 'Feishu message event received');
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Failed to handle Feishu message');
        }
      },
    });

    // Log all events for debugging
    logger.info('Feishu event dispatcher registered for: im.message.receive_v1');

    // Start WebSocket connection with event dispatcher
    await this.wsClient.start({ eventDispatcher });

    logger.info('Feishu bot connected via WebSocket');
    console.log('\n  Feishu bot connected');
    console.log('  Use chat IDs from Feishu to register groups\n');
  }

  private async handleMessage(data: any): Promise<void> {
    const message = data.message;
    const sender = data.sender;

    // Ignore bot messages
    if (sender.sender_type === 'app') return;

    const chatId = message.chat_id;
    const chatJid = `fs:${chatId}`;
    const messageId = message.message_id;
    const senderId = sender.sender_id.open_id;
    const timestamp = new Date(parseInt(message.create_time)).toISOString();

    // Get message content
    let content = '';
    const msgType = message.message_type;

    if (msgType === 'text') {
      const textContent = JSON.parse(message.content);
      content = textContent.text || '';
    } else if (msgType === 'image') {
      content = '[图片]';
    } else if (msgType === 'file') {
      content = '[文件]';
    } else if (msgType === 'audio') {
      content = '[语音]';
    } else if (msgType === 'video') {
      content = '[视频]';
    } else {
      content = `[${msgType}]`;
    }

    // Get sender name
    let senderName = 'Unknown';
    try {
      const userInfo = await this.client!.contact.v3.user.get({
        path: { user_id: senderId },
        params: { user_id_type: 'open_id' },
      });
      senderName = userInfo.data?.user?.name || senderId;
    } catch (err) {
      logger.debug({ err, senderId }, 'Failed to get Feishu user info');
      senderName = senderId;
    }

    // Get chat name
    let chatName = 'Unknown Chat';
    let isGroup = false;
    try {
      const chatInfo = await this.client!.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      chatName = chatInfo.data?.name || chatId;
      isGroup = chatInfo.data?.chat_mode === 'group';
    } catch (err) {
      logger.debug({ err, chatId }, 'Failed to get Feishu chat info');
      chatName = chatId;
    }

    // Handle @mentions - check if bot is mentioned
    if (message.mentions && message.mentions.length > 0) {
      const botMentioned = message.mentions.some(
        (mention: any) => mention.id?.open_id === this.appId,
      );
      if (botMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      console.log('\n=== Unregistered Feishu Chat ===');
      console.log(`Chat ID: ${chatJid}`);
      console.log(`Chat Name: ${chatName}`);
      console.log(`Is Group: ${isGroup}`);
      console.log('Use this Chat ID to register the chat');
      console.log('================================\n');
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Feishu chat',
      );
      return;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Feishu message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    try {
      const chatId = jid.replace(/^fs:/, '');

      // Send text message
      await this.client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.wsClient !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      // WSClient doesn't have a stop method, just set to null
      this.wsClient = null;
    }
    this.client = null;
    logger.info('Feishu bot stopped');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu doesn't support typing indicators
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
