import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface FeishuChannelOpts {
  appId: string;
  appSecret: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Feishu (Lark) channel implementation using long connection mode.
 *
 * This channel uses WebSocket-based long connection to receive events,
 * which is the recommended approach by Feishu as it doesn't require
 * public webhook URLs or encryption configuration.
 */
export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client;
  private wsClient: lark.WSClient;
  private eventDispatcher: lark.EventDispatcher;
  private connected = false;
  private opts: FeishuChannelOpts;

  constructor(opts: FeishuChannelOpts) {
    this.opts = opts;

    // Initialize Lark client for API calls
    this.client = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });

    // Initialize WebSocket client for long connection
    this.wsClient = new lark.WSClient({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    });

    // Initialize event dispatcher
    // Note: For long connection mode, verification is handled by the WebSocket layer
    this.eventDispatcher = new lark.EventDispatcher({
      verificationToken: '',
      encryptKey: '',
      loggerLevel: lark.LoggerLevel.info,
    }).register({
      'im.message.receive_v1': this.handleMessage.bind(this),
    });

    logger.info('Feishu channel initialized with long connection mode');
  }

  async connect(): Promise<void> {
    try {
      // Start WebSocket long connection with event dispatcher
      await this.wsClient.start({
        eventDispatcher: this.eventDispatcher,
      });
      this.connected = true;
      logger.info('Feishu long connection established');
    } catch (err: any) {
      logger.error({ err }, 'Failed to connect to Feishu');
      throw err;
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Feishu channel not connected');
    }

    try {
      await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      logger.debug(
        { chatId, textLength: text.length },
        'Sent message to Feishu',
      );
    } catch (err: any) {
      logger.error({ err, chatId }, 'Failed to send Feishu message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // For Feishu, we own all JIDs when Feishu is the active channel
    // The JID is the chat_id from Feishu (format: oc_xxx)
    return true;
  }

  async disconnect(): Promise<void> {
    try {
      // Note: WSClient doesn't expose a stop method, connection will be closed on process exit
      this.connected = false;
      logger.info('Feishu channel disconnected');
    } catch (err: any) {
      logger.error({ err }, 'Error disconnecting Feishu channel');
    }
  }

  /**
   * Handle incoming message event from Feishu.
   *
   * Processes text messages, replaces mention placeholders with actual names,
   * and delivers the message to the NanoClaw message processing pipeline.
   */
  private async handleMessage(data: any): Promise<void> {
    try {
      const message = data.message;
      const sender = data.sender;

      if (!message || !sender) {
        logger.warn({ data }, 'Missing message or sender in event data');
        return;
      }

      // Extract chat ID and message content
      const chatId = message.chat_id;
      const messageType = message.message_type;
      const messageId = message.message_id;

      logger.debug(
        { chatId, messageType, messageId },
        'Received Feishu message',
      );

      // Only process text messages for now
      if (messageType !== 'text') {
        logger.debug({ messageType }, 'Ignoring non-text message');
        return;
      }

      const content = JSON.parse(message.content);
      let text = content.text;

      // Replace mention placeholders with actual names
      // Feishu uses @_user_1, @_user_2 etc. as placeholders
      if (message.mentions && Array.isArray(message.mentions)) {
        for (const mention of message.mentions) {
          if (mention.key && mention.name) {
            text = text.replace(mention.key, `@${mention.name}`);
          }
        }
      }

      // Get sender info
      const senderId = sender.sender_id.user_id || sender.sender_id.open_id;
      const senderName =
        sender.sender_id.user_id || sender.sender_id.open_id || 'Unknown';

      logger.debug(
        { chatId, senderId, senderName, text },
        'Processing Feishu message',
      );

      // Notify chat metadata (for first-time discovery)
      this.opts.onChatMetadata(
        chatId,
        new Date().toISOString(),
        undefined, // Feishu doesn't provide chat name in message event
        'feishu',
        message.chat_type === 'group',
      );

      // Deliver the message
      this.opts.onMessage(chatId, {
        id: messageId,
        chat_jid: chatId,
        sender: senderId,
        sender_name: senderName,
        content: text,
        timestamp: new Date(parseInt(message.create_time)).toISOString(),
        is_from_me: false, // Feishu bots don't receive their own messages
      });

      logger.debug({ chatId, messageId }, 'Message delivered successfully');
    } catch (err: any) {
      logger.error({ err, data }, 'Error handling Feishu message');
      throw err; // Re-throw to let EventDispatcher know there was an error
    }
  }

  /**
   * Set typing indicator (not supported by Feishu)
   */
  async setTyping?(chatId: string, isTyping: boolean): Promise<void> {
    // Feishu doesn't support typing indicators
    logger.debug({ chatId, isTyping }, 'Typing indicator not supported');
  }
}
