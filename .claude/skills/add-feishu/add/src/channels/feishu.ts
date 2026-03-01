import * as lark from '@larksuiteoapi/node-sdk';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
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

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client;
  private wsClient: lark.WSClient;
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
      // Register event handler for P2P messages
      this.wsClient.on('im.message.receive_v1', async (data) => {
        await this.handleMessage(data);
      });

      await this.wsClient.start();
      this.connected = true;
      logger.info('Feishu channel connected via WebSocket');
    } catch (err) {
      logger.error({ err }, 'Failed to connect Feishu channel');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    // The SDK doesn't expose a clean disconnect method for WS client yet,
    // but we can mark as disconnected.
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

    try {
      await this.client.im.message.create({
        params: {
          receive_id_type: 'open_id', // Default to open_id, could be chat_id based on context
        },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send Feishu message');
      throw err;
    }
  }

  private async handleMessage(event: any): Promise<void> {
    const message = event.message;
    if (!message || message.message_type !== 'text') return;

    const content = JSON.parse(message.content).text;
    const senderId = event.sender.sender_id.open_id;
    const chatId = message.chat_id; // Use chat_id for groups, open_id for P2P

    // Determine if it's a group chat
    const isGroup = message.chat_type === 'group';

    // Construct JID
    // For P2P: feishu:open_id
    // For Group: feishu:chat_id
    const chatJid = `feishu:${isGroup ? chatId : senderId}`;

    const timestamp = new Date(parseInt(message.create_time)).toISOString();
    const senderName = event.sender.sender_id.user_id || 'Feishu User'; // Need API call to get real name

    // Handle trigger pattern
    let processedContent = content;
    // In groups, check for @mention or trigger pattern
    if (isGroup) {
      // Simple check: if message mentions bot (need bot name/id logic here)
      // For now, rely on TRIGGER_PATTERN
    }

    // Store chat metadata
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      isGroup ? 'Feishu Group' : 'Feishu User',
      'feishu',
      isGroup,
    );

    // Only process if it matches trigger or is a direct message (if configured)
    // For now, pass everything to router which handles trigger logic

    this.opts.onMessage(chatJid, {
      id: message.message_id,
      chat_jid: chatJid,
      sender: `feishu:${senderId}`,
      sender_name: senderName,
      content: processedContent,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }
}
