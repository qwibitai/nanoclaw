import * as lark from '@larksuiteoapi/node-sdk';
import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
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

interface FeishuMention {
  id?: {
    open_id?: string;
    union_id?: string;
    user_id?: string | null;
  };
  key?: string;
  name?: string;
  tenant_key?: string;
}

interface FeishuMessageEvent {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  ts?: string;
  uuid?: string;
  type?: string;
  app_id?: string;
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
  };
  message: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    chat_id?: string;
    message_type?: string;
    content?: string;
    chat_type?: string;
    mentions?: FeishuMention[];
  };
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client;
  private wsClient: lark.WSClient;
  private eventDispatcher: lark.EventDispatcher;
  private opts: FeishuChannelOpts;
  private connected = false;

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.opts = opts;

    // Initialize API client
    this.client = new lark.Client({
      appId,
      appSecret,
      disableTokenCache: false,
    });

    // Initialize event dispatcher for handling events
    this.eventDispatcher = new lark.EventDispatcher({
      loggerLevel: lark.LoggerLevel.info,
    });

    // Register message handler
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: FeishuMessageEvent) => {
        await this.handleMessage(data);
      },
    });

    // Initialize WebSocket client for receiving events
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      await this.wsClient.start({
        eventDispatcher: this.eventDispatcher,
      });
      this.connected = true;
      logger.info('Feishu channel connected via WebSocket');
    } catch (err) {
      logger.error({ err }, 'Failed to connect Feishu channel');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.wsClient.close();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) throw new Error('Feishu channel not connected');

    const [prefix, receiveId] = jid.split(':');
    if (prefix !== 'feishu' || !receiveId) {
      throw new Error(`Invalid Feishu JID: ${jid}`);
    }

    logger.info(
      { jid, receiveId, text: text.slice(0, 100) },
      'Sending Feishu message',
    );

    try {
      const result = await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id', // Use chat_id for both P2P and group
        },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      logger.info({ jid, result }, 'Feishu message sent successfully');
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send Feishu message');
      throw err;
    }
  }

  private async handleMessage(event: FeishuMessageEvent): Promise<void> {
    logger.info({ event }, 'Feishu message received');
    const message = event.message;
    if (!message || message.message_type !== 'text') {
      logger.debug(
        { messageType: message?.message_type },
        'Skipping non-text message',
      );
      return;
    }

    let content: string;
    try {
      content = JSON.parse(message.content || '{}').text || '';
    } catch {
      logger.warn(
        { eventId: event.event_id },
        'Failed to parse Feishu message content',
      );
      return;
    }

    // Replace Feishu mention placeholders (@_user_1) with actual names
    // This converts "@_user_1 hello" to "@NanoClaw hello" for trigger detection
    if (message.mentions && message.mentions.length > 0) {
      for (const mention of message.mentions) {
        if (mention.key && mention.name) {
          // If this mention is the bot itself, use ASSISTANT_NAME for trigger matching
          const displayName =
            mention.name === 'NanoClaw' ? ASSISTANT_NAME : mention.name;
          content = content.replace(mention.key, `@${displayName}`);
        }
      }
      logger.debug(
        { content, mentions: message.mentions },
        'Processed Feishu mentions',
      );
    }

    const senderId = event.sender.sender_id?.open_id || 'unknown';
    const chatId = message.chat_id || senderId;

    // Determine if it's a group chat
    const isGroup = message.chat_type === 'group';

    // Construct JID using chat_id for both P2P and group
    const chatJid = `feishu:${chatId}`;

    const timestamp = message.create_time
      ? new Date(parseInt(message.create_time)).toISOString()
      : new Date().toISOString();
    const senderName = event.sender.sender_id?.user_id || 'Feishu User';

    // Store chat metadata
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      isGroup ? 'Feishu Group' : 'Feishu User',
      'feishu',
      isGroup,
    );

    // Pass message to router which handles trigger logic
    this.opts.onMessage(chatJid, {
      id: message.message_id || event.event_id || '',
      chat_jid: chatJid,
      sender: `feishu:${senderId}`,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }
}
