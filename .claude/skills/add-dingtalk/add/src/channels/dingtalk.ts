import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import axios from 'axios';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DingTalkChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}

interface DingTalkMessage {
  msgId: string;
  msgtype: string;
  text?: {
    content: string;
  };
  senderStaffId?: string;
  senderId: string;
  senderNick?: string;
  conversationId: string;
  conversationType: string;
  conversationTitle?: string;
  chatbotUserId: string;
  sessionWebhook: string;
  createAt: number;
}

export class DingTalkChannel implements Channel {
  name = 'dingtalk';

  private client: DWClient | null = null;
  private opts: DingTalkChannelOpts;
  private clientId: string;
  private clientSecret: string;
  private robotCode?: string;
  private allowedUsers: string[];
  private allowedGroups: string[];

  // Session webhook cache (chatId -> webhook URL)
  private sessionWebhooks = new Map<string, string>();

  // Message deduplication cache (msgId -> expiry timestamp)
  private processedMessages = new Map<string, number>();
  private readonly MESSAGE_DEDUP_TTL = 60000; // 60 seconds
  private readonly MESSAGE_DEDUP_MAX_SIZE = 1000;

  // Connection management
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isStopped = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly HEALTH_CHECK_INTERVAL = 5000; // 5 seconds
  private readonly INITIAL_RECONNECT_DELAY = 1000; // 1 second
  private readonly MAX_RECONNECT_DELAY = 60000; // 60 seconds
  private readonly RECONNECT_JITTER = 0.3; // 30% jitter

  // Socket event handlers (saved for cleanup)
  private socketCloseHandler?: (code: number, reason: string) => void;
  private socketErrorHandler?: (error: Error) => void;
  private monitoredSocket?: any;

  constructor(
    clientId: string,
    clientSecret: string,
    robotCode: string | undefined,
    allowedUsers: string[],
    allowedGroups: string[],
    opts: DingTalkChannelOpts,
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.robotCode = robotCode;
    this.allowedUsers = allowedUsers;
    this.allowedGroups = allowedGroups;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new DWClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });

    // Disable DWClient's built-in auto-reconnect; use our own managed reconnection
    (this.client as any).config.autoReconnect = false;

    // Register message callback listener
    await this.registerMessageHandler();

    // Initiate connection
    try {
      await this.client.connect();
      logger.info('DingTalk connected');
      console.log('\n  DingTalk: Stream Mode connected');
      console.log('  Send a message in DingTalk to test\n');

      // Set up connection health check and auto-reconnect
      this.setupConnectionMonitoring();
    } catch (err) {
      logger.error({ err }, 'Failed to connect to DingTalk');
      throw err;
    }
  }

  /**
   * Set up connection monitoring and auto-reconnect
   */
  private setupConnectionMonitoring(): void {
    if (this.isStopped) return;

    this.cleanupConnectionMonitoring();

    logger.debug('Setting up DingTalk connection monitoring');

    // 1. Health check timer: checks connection state every 5 seconds
    this.healthCheckInterval = setInterval(() => {
      if (this.isStopped) {
        this.cleanupConnectionMonitoring();
        return;
      }

      const client = this.client as any;
      if (client && !client.connected) {
        logger.warn('DingTalk connection health check failed - detected disconnection');
        this.cleanupConnectionMonitoring();
        this.handleDisconnection();
      }
    }, this.HEALTH_CHECK_INTERVAL);

    // 2. Monitor WebSocket close and error events
    const client = this.client as any;
    if (client?.socket) {
      const socket = client.socket;
      this.monitoredSocket = socket;

      this.socketCloseHandler = (code: number, reason: string) => {
        if (this.isStopped) return;
        logger.warn({ code, reason: reason || 'none' }, 'DingTalk WebSocket closed');
        this.cleanupConnectionMonitoring();
        this.handleDisconnection();
      };

      this.socketErrorHandler = (error: Error) => {
        logger.error({ err: error }, 'DingTalk WebSocket error');
      };

      socket.once('close', this.socketCloseHandler);
      socket.once('error', this.socketErrorHandler);

      logger.debug('DingTalk WebSocket event listeners attached');
    }
  }

  /**
   * Clean up connection monitoring resources
   */
  private cleanupConnectionMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      logger.debug('Health check interval cleared');
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.monitoredSocket) {
      const socket = this.monitoredSocket;

      if (this.socketCloseHandler) {
        socket.removeListener('close', this.socketCloseHandler);
        this.socketCloseHandler = undefined;
      }

      if (this.socketErrorHandler) {
        socket.removeListener('error', this.socketErrorHandler);
        this.socketErrorHandler = undefined;
      }

      logger.debug('Socket event listeners removed');
      this.monitoredSocket = undefined;
    }
  }

  /**
   * Handle disconnection and trigger auto-reconnect
   */
  private handleDisconnection(): void {
    if (this.isStopped || this.isConnecting) return;

    logger.warn('DingTalk connection lost, initiating reconnection...');

    const delay = this.calculateReconnectDelay();

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        { attempts: this.reconnectAttempts },
        'Max reconnection attempts reached, giving up',
      );
      return;
    }

    this.reconnectAttempts++;
    logger.info(
      { attempt: this.reconnectAttempts, delay: `${delay}ms` },
      'Scheduling DingTalk reconnection',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnect().catch((err) => {
        logger.error({ err }, 'Reconnection failed');
      });
    }, delay);
  }

  /**
   * Calculate reconnect delay using exponential backoff with jitter.
   * Formula: min(initialDelay * 2^attempt, maxDelay) * (1 ± jitter)
   */
  private calculateReconnectDelay(): number {
    // reconnectAttempts starts at 1, convert to zero-based
    const attempt = this.reconnectAttempts - 1;
    const exponentialDelay = this.INITIAL_RECONNECT_DELAY * Math.pow(2, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.MAX_RECONNECT_DELAY);
    const jitterAmount = cappedDelay * this.RECONNECT_JITTER;
    const randomJitter = (Math.random() * 2 - 1) * jitterAmount;
    const finalDelay = Math.max(100, cappedDelay + randomJitter);
    return Math.floor(finalDelay);
  }

  /**
   * Perform reconnection
   */
  private async reconnect(): Promise<void> {
    if (this.isStopped || this.isConnecting) return;

    this.isConnecting = true;
    logger.info('Attempting to reconnect to DingTalk...');

    try {
      if (this.client) {
        try {
          this.client.disconnect();
        } catch (err) {
          logger.debug({ err }, 'Error disconnecting old client');
        }
      }

      this.client = new DWClient({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      });

      (this.client as any).config.autoReconnect = false;

      await this.registerMessageHandler();
      await this.client.connect();

      logger.info('DingTalk reconnected successfully');
      console.log('\n  DingTalk: Reconnected successfully\n');

      this.reconnectAttempts = 0;
      this.isConnecting = false;

      this.setupConnectionMonitoring();
    } catch (err) {
      this.isConnecting = false;
      logger.error({ err }, 'Reconnection attempt failed');
      this.handleDisconnection();
    }
  }

  /**
   * Register message handler (extracted for reuse on reconnect)
   */
  private async registerMessageHandler(): Promise<void> {
    if (!this.client) return;

    this.client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      try {
        const data: DingTalkMessage = JSON.parse(res.data);

        // Deduplication check
        if (this.isMessageProcessed(data.msgId)) {
          logger.debug({ msgId: data.msgId }, 'Duplicate DingTalk message');
          return;
        }
        this.markMessageProcessed(data.msgId);

        // Filter bot self-messages
        if (data.senderId === data.chatbotUserId) {
          logger.debug('Ignoring DingTalk bot self-message');
          return;
        }

        // Extract message content
        const content = data.text?.content?.trim() || '';
        if (!content) {
          return;
        }

        // Permission check
        const senderId = data.senderStaffId || data.senderId;
        if (!this.isUserAllowed(senderId)) {
          logger.warn({ senderId }, 'Unauthorized DingTalk user');
          return;
        }

        // Resolve chat ID
        const chatId = this.resolveChat(data);
        const chatJid = `dd:${chatId}`;

        // Cache session webhook (dual-key: chatId and senderId)
        if (data.sessionWebhook) {
          this.sessionWebhooks.set(chatId, data.sessionWebhook);
          this.sessionWebhooks.set(senderId, data.sessionWebhook);
        }

        // Determine chat name
        const isDirect = data.conversationType === '1';
        const senderName = data.senderNick || senderId;
        const chatName = isDirect
          ? senderName
          : data.conversationTitle || chatJid;

        // Notify chat metadata (for group discovery)
        this.opts.onChatMetadata(chatJid, new Date(data.createAt).toISOString(), chatName, 'dingtalk', !isDirect);

        // Check if group is registered or auto-registerable
        let group = this.opts.registeredGroups()[chatJid];

        if (!group) {
          const isGroupAllowed = this.isGroupAllowed(chatId);

          if (isGroupAllowed && this.opts.registerGroup) {
            // Auto-register the group
            const folderName = `dingtalk-${chatId.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30)}`;
            const newGroup: RegisteredGroup = {
              name: chatName,
              folder: folderName,
              trigger: `@${ASSISTANT_NAME}`,
              added_at: new Date().toISOString(),
              requiresTrigger: !isDirect, // group chats require trigger; DMs do not
            };

            this.opts.registerGroup(chatJid, newGroup);
            logger.info(
              { chatJid, chatName, folder: folderName },
              'Auto-registered DingTalk chat',
            );

            group = this.opts.registeredGroups()[chatJid];
          } else {
            logger.info(
              { chatJid },
              'Message from unregistered DingTalk chat - To register this chat, add to DINGTALK_ALLOWED_GROUPS or use: registerGroup("dd:conversationId", {...})',
            );
            return;
          }
        }

        // Store message
        this.opts.onMessage(chatJid, {
          id: data.msgId,
          chat_jid: chatJid,
          sender: senderId,
          sender_name: senderName,
          content,
          timestamp: new Date(data.createAt).toISOString(),
          is_from_me: false,
        });

        logger.info(
          { chatJid, chatName, sender: senderName },
          'DingTalk message stored',
        );
      } catch (err) {
        logger.error({ err }, 'Error processing DingTalk message');
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('DingTalk client not initialized');
      return;
    }

    try {
      const chatId = jid.replace(/^dd:/, '');
      const webhook = this.sessionWebhooks.get(chatId);

      if (!webhook) {
        logger.warn(
          { jid },
          'No session webhook found - user must send a message first',
        );
        return;
      }

      // Build Markdown message
      const body = {
        msgtype: 'markdown',
        markdown: {
          title: ASSISTANT_NAME,
          text: text,
        },
      };

      await axios.post(webhook, body, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      logger.info({ jid, length: text.length }, 'DingTalk message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send DingTalk message');
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dd:');
  }

  async disconnect(): Promise<void> {
    this.isStopped = true;
    this.cleanupConnectionMonitoring();

    if (this.client) {
      try {
        this.client.disconnect();
      } catch (err) {
        logger.debug({ err }, 'Error disconnecting DingTalk client');
      }
      this.client = null;
      this.sessionWebhooks.clear();
      this.processedMessages.clear();
      logger.info('DingTalk bot stopped');
    }
  }

  /**
   * Check if a user is in the allowlist
   */
  private isUserAllowed(userId: string): boolean {
    if (this.allowedUsers.length === 0) return false;
    if (this.allowedUsers.includes('*')) return true;
    return this.allowedUsers.includes(userId);
  }

  /**
   * Check if a group/chat is in the allowlist (supports wildcard)
   */
  private isGroupAllowed(chatId: string): boolean {
    if (this.allowedGroups.length === 0) return false;
    if (this.allowedGroups.includes('*')) return true;
    const chatJid = `dd:${chatId}`;
    return this.allowedGroups.includes(chatId) || this.allowedGroups.includes(chatJid);
  }

  /**
   * Resolve chat ID (DMs use senderStaffId; group chats use conversationId)
   */
  private resolveChat(data: DingTalkMessage): string {
    const isPrivate = data.conversationType === '1';
    return isPrivate
      ? data.senderStaffId || data.senderId
      : data.conversationId;
  }

  /**
   * Check if a message has already been processed (deduplication)
   */
  private isMessageProcessed(msgId: string): boolean {
    const now = Date.now();
    const expiry = this.processedMessages.get(msgId);

    if (expiry === undefined) return false;

    if (now >= expiry) {
      this.processedMessages.delete(msgId);
      return false;
    }

    return true;
  }

  /**
   * Mark a message as processed
   */
  private markMessageProcessed(msgId: string): void {
    const expiresAt = Date.now() + this.MESSAGE_DEDUP_TTL;
    this.processedMessages.set(msgId, expiresAt);

    // Hard limit: prune expired entries when over max size
    if (this.processedMessages.size > this.MESSAGE_DEDUP_MAX_SIZE) {
      const now = Date.now();
      for (const [key, expiry] of this.processedMessages.entries()) {
        if (now >= expiry) {
          this.processedMessages.delete(key);
        }
      }
    }
  }
}
