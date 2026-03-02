import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  NewMessage,
  RegisteredGroup,
} from '../types.js';
import {
  Client,
  WSClient,
  EventDispatcher,
  LoggerLevel,
} from '@larksuiteoapi/node-sdk';

interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  unregisterGroup?: (jid: string) => void;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private config!: { appId: string; appSecret: string };
  private client!: Client;
  private wsClient?: WSClient;
  private connected = false;
  private outgoingQueue: Array<{ openId: string; text: string }> = [];
  private flushing = false;
  private chatSenders: Map<string, string> = new Map();
  private chatTypes: Map<string, string> = new Map();

  private opts: FeishuChannelOpts;

  constructor(opts: FeishuChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const envConfig = await import('../env.js').then(m =>
      m.readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']),
    );
    this.config = {
      appId: envConfig.FEISHU_APP_ID || '',
      appSecret: envConfig.FEISHU_APP_SECRET || '',
    };

    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set');
    }

    this.client = new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: LoggerLevel.info,
    });

    this.connected = true;
    logger.info('Feishu client initialized');

    this.startWebSocket();
    this.flushOutgoingQueue().catch(err =>
      logger.error({ err }, 'Failed to flush outgoing queue'),
    );
  }

  private startWebSocket(): void {
    if (!this.wsClient) {
      logger.error('WSClient not initialized');
      return;
    }

    const eventDispatcher = new EventDispatcher({});

    // Message receive handler
    eventDispatcher.register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        try {
          const message = (data.message || data) as Record<string, unknown>;
          const sender = (data.sender || message.sender) as Record<string, unknown> | undefined;
          if (!message) return;

          const messageId = String(message.message_id || '');
          const chatId = String(message.chat_id || '');
          const chatType = String(message.chat_type || 'p2p');
          const content = String(message.content || '');
          const senderId = sender
            ? String((sender.sender_id as Record<string, unknown>)?.open_id || '')
            : '';

          if (!chatId || !senderId) return;

          // Parse message content
          let text = '';
          try {
            if (content) {
              const parsed = JSON.parse(content);
              text = parsed.text || '';
            }
          } catch {
            text = content || '';
          }

          if (!text) return;

          let groups = this.opts.registeredGroups();

          // Store chat type and sender
          this.chatTypes.set(chatId, chatType);
          if (senderId && chatType === 'p2p') {
            this.chatSenders.set(chatId, senderId);
          }

          // Auto-register new group chats
          if (chatType === 'group' && !groups[chatId] && this.opts.registerGroup) {
            const folderName = `group-${chatId.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
            logger.info({ chatId, folderName }, 'Auto-registering new group');
            const newGroup: RegisteredGroup = {
              name: folderName,
              folder: folderName,
              trigger: '@Andy',
              added_at: new Date().toISOString(),
              requiresTrigger: false,
            };
            this.opts.registerGroup(chatId, newGroup);
            groups = this.opts.registeredGroups();
          }

          if (!groups[chatId]) {
            logger.info({ chatId }, 'Chat not in registered groups');
            return;
          }

          this.opts.onChatMetadata(
            chatId,
            new Date().toISOString(),
            undefined,
            'feishu',
            chatType === 'group',
          );

          const newMessage: NewMessage = {
            id: messageId,
            chat_jid: chatId,
            sender: senderId,
            sender_name: senderId,
            content: text,
            timestamp: new Date().toISOString(),
            is_from_me: false,
            is_bot_message: false,
          };

          this.opts.onMessage(chatId, newMessage);
        } catch (err) {
          logger.error({ err }, 'Error processing Feishu message');
        }
      },
    });

    // Group disbanded handler
    eventDispatcher.register({
      'im.chat.disbanded_v1': async (data: Record<string, unknown>) => {
        try {
          const chatId = String(data.chat_id || '');
          if (!chatId) return;

          logger.info({ chatId }, 'Group disbanded');
          this.chatSenders.delete(chatId);
          this.chatTypes.delete(chatId);

          if (this.opts.unregisterGroup) {
            const groups = this.opts.registeredGroups();
            if (groups[chatId]) {
              logger.info({ chatId }, 'Unregistering disbanded group');
              this.opts.unregisterGroup(chatId);
            }
          }
        } catch (err) {
          logger.error({ err }, 'Error processing Feishu disband event');
        }
      },
    });

    this.wsClient.start({ eventDispatcher });
    logger.info('Feishu WebSocket started');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    let receiveId = jid;
    let receiveIdType: 'chat_id' | 'open_id' = 'chat_id';

    // Only use open_id for P2P chats, use chat_id for groups
    const chatType = this.chatTypes.get(jid);
    if (chatType === 'p2p') {
      const resolvedSenderId = this.chatSenders.get(jid);
      if (resolvedSenderId) {
        receiveId = resolvedSenderId;
        receiveIdType = 'open_id';
      }
    }

    if (!this.connected) {
      this.outgoingQueue.push({ openId: receiveId, text });
      logger.info(
        { jid, receiveId, length: text.length, queueSize: this.outgoingQueue.length },
        'Feishu disconnected, message queued',
      );
      return;
    }

    try {
      const token = await this.getToken();

      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            receive_id: receiveId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          }),
        },
      );

      const result = await response.json() as { code?: number; msg?: string };
      if (result.code !== 0) {
        throw new Error(`Feishu API error: ${result.code} ${result.msg}`);
      }

      logger.debug({ jid, receiveId, receiveIdType, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ err, jid, receiveId }, 'Failed to send Feishu message');
      this.outgoingQueue.push({ openId: receiveId, text });
    }
  }

  private async getToken(): Promise<string> {
    const response = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );

    const data = await response.json() as { tenant_access_token?: string };
    if (!data.tenant_access_token) {
      throw new Error('Failed to get Feishu token');
    }
    return data.tenant_access_token;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('ou_') || jid.startsWith('oc_') || jid.startsWith('cli_');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('Disconnected from Feishu');
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;

    this.flushing = true;
    const queue = [...this.outgoingQueue];
    this.outgoingQueue = [];

    for (const { openId, text } of queue) {
      await this.sendMessage(openId, text);
    }

    this.flushing = false;
  }

  async getUserInfo(openId: string): Promise<{ name: string; open_id: string } | null> {
    try {
      const response = await this.client.contact.user.get({
        params: { user_id_type: 'open_id' },
        path: { user_id: openId },
      });

      if (!response.data || !response.data.user) return null;

      return {
        name: response.data.user.name || 'Unknown',
        open_id: response.data.user.open_id || openId,
      };
    } catch (err) {
      logger.error({ err, openId }, 'Failed to get Feishu user info');
      return null;
    }
  }
}
