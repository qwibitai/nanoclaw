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

// Use SDK's inferred event types
type MessageReceiveEvent = Parameters<
  NonNullable<
    Parameters<typeof lark.EventDispatcher.prototype.register>[0]['im.message.receive_v1']
  >
>[0];

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private encryptKey: string;
  private connected = false;

  constructor(
    appId: string,
    appSecret: string,
    encryptKey: string,
    opts: FeishuChannelOpts,
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.encryptKey = encryptKey;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const baseConfig = {
      appId: this.appId,
      appSecret: this.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    };

    this.client = new lark.Client(baseConfig);

    // Use WebSocket long connection mode for receiving events
    // This eliminates the need for a public endpoint
    this.wsClient = new lark.WSClient(baseConfig);

    const eventDispatcher = new lark.EventDispatcher({
      encryptKey: this.encryptKey || undefined,
    }).register({
      'im.message.receive_v1': async (data: MessageReceiveEvent) => {
        await this.handleMessage(data);
      },
    });

    try {
      await this.wsClient.start({ eventDispatcher });
      this.connected = true;

      logger.info({ appId: this.appId }, 'Feishu WebSocket connected');
      console.log(`\n  Feishu bot connected (App ID: ${this.appId})`);
      console.log(`  Add bot to a chat and send a message to get the chat ID\n`);
    } catch (err) {
      logger.error({ err }, 'Failed to connect Feishu WebSocket');
      throw err;
    }
  }

  private async handleMessage(data: MessageReceiveEvent): Promise<void> {
    const { message, sender } = data;

    // Skip messages from the bot itself
    if (sender.sender_type === 'app') {
      return;
    }

    const chatJid = `feishu:${message.chat_id}`;
    const timestamp = new Date(parseInt(message.create_time) * 1000).toISOString();
    const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id || '';
    const msgId = message.message_id;
    const msgType = message.message_type;

    // Parse message content
    let content = '';
    if (msgType === 'text') {
      try {
        const parsed = JSON.parse(message.content);
        content = parsed.text || '';
      } catch {
        content = message.content;
      }
    } else if (msgType === 'post') {
      // Rich text message - extract text content
      try {
        const parsed = JSON.parse(message.content);
        content = this.extractPostContent(parsed);
      } catch {
        content = '[Rich Text Message]';
      }
    } else if (msgType === 'image') {
      content = '[Image]';
    } else if (msgType === 'file') {
      try {
        const parsed = JSON.parse(message.content);
        content = `[File: ${parsed.file_name || 'unknown'}]`;
      } catch {
        content = '[File]';
      }
    } else if (msgType === 'audio') {
      content = '[Voice Message]';
    } else if (msgType === 'media') {
      content = '[Media]';
    } else if (msgType === 'sticker') {
      content = '[Sticker]';
    } else {
      content = `[${msgType}]`;
    }

    // Get sender name (Feishu doesn't provide it directly in message event)
    // We'll use the sender ID as a fallback
    const senderName = senderId || 'Unknown';

    // Store chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', true);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid },
        'Message from unregistered Feishu chat',
      );
      return;
    }

    // Check trigger pattern for non-main groups
    if (group.requiresTrigger && !TRIGGER_PATTERN.test(content)) {
      logger.debug(
        { chatJid, content },
        'Feishu message does not match trigger pattern',
      );
      return;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, sender: senderId, msgType },
      'Feishu message stored',
    );
  }

  private extractPostContent(postData: any): string {
    if (!postData || !postData.content) {
      return '[Rich Text]';
    }

    const extractText = (elements: any[]): string => {
      return elements
        .map((el: any) => {
          if (typeof el === 'string') return el;
          if (el.text) return el.text;
          if (el.children) return extractText(el.children);
          return '';
        })
        .join('');
    };

    try {
      const lines = postData.content.map((block: any) => {
        if (block.paragraph) {
          return extractText(block.paragraph.elements || []);
        }
        return '';
      });
      return lines.join('\n').trim() || '[Rich Text]';
    } catch {
      return '[Rich Text]';
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    try {
      const chatId = jid.replace(/^feishu:/, '');

      // Feishu has message length limits, split if needed
      // Using a conservative limit of 30KB for text content
      const MAX_LENGTH = 30000;
      const chunks = this.splitMessage(text, MAX_LENGTH);

      for (const chunk of chunks) {
        await this.client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text: chunk }),
            msg_type: 'text',
          },
        });
      }

      logger.info({ jid, length: text.length, chunks: chunks.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a newline or space near the limit
      let splitPoint = remaining.lastIndexOf('\n', maxLength);
      if (splitPoint === -1 || splitPoint < maxLength * 0.5) {
        splitPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitPoint === -1 || splitPoint < maxLength * 0.5) {
        splitPoint = maxLength;
      }

      chunks.push(remaining.slice(0, splitPoint));
      remaining = remaining.slice(splitPoint).trim();
    }

    return chunks;
  }

  isConnected(): boolean {
    return this.connected && this.wsClient !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      // WSClient doesn't have a explicit stop method in current SDK
      // The connection will be closed when the process exits
      this.wsClient = null;
      this.connected = false;
      logger.info('Feishu WebSocket disconnected');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu doesn't support typing indicators via API
    // This is intentionally a no-op
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ENCRYPT_KEY']);
  const appId =
    process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  const encryptKey =
    process.env.FEISHU_ENCRYPT_KEY || envVars.FEISHU_ENCRYPT_KEY || '';

  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID and/or FEISHU_APP_SECRET not set');
    return null;
  }

  return new FeishuChannel(appId, appSecret, encryptKey, opts);
});
