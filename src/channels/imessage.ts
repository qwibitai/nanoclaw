import type { Message as IMsg } from '@photon-ai/imessage-kit';
import { IMessageSDK } from '@photon-ai/imessage-kit';

import { ASSISTANT_NAME } from '../config.js';
import { updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface IMessageChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class IMessageChannel implements Channel {
  name = 'imessage';

  private sdk!: IMessageSDK;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  private opts: IMessageChannelOpts;

  constructor(opts: IMessageChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.sdk = new IMessageSDK({
      watcher: {
        pollInterval: 2000,
        unreadOnly: true,
        excludeOwnMessages: false,
      },
    });

    try {
      await this.sdk.startWatching({
        onMessage: (msg) => this.handleIncomingMessage(msg),
        onGroupMessage: (msg) => this.handleIncomingMessage(msg),
        onError: (err) => {
          logger.error({ err }, 'iMessage SDK error');
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('permission') || message.includes('Full Disk Access')) {
        logger.warn('iMessage requires Full Disk Access. Grant it in System Settings > Privacy & Security > Full Disk Access.');
      }
      throw err;
    }

    this.connected = true;
    logger.info('Connected to iMessage');

    // Flush any messages queued before connection
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush iMessage outgoing queue'),
    );

    // Sync chat metadata on startup
    this.syncChatMetadata().catch((err) =>
      logger.error({ err }, 'Initial iMessage chat sync failed'),
    );
  }

  private handleIncomingMessage(msg: IMsg): void {
    // Skip reactions — they're not real messages
    if (msg.isReaction) return;

    const jid = msg.isGroupChat
      ? `imsg-group:${msg.chatId}`
      : `imsg:${msg.sender}`;

    const timestamp = msg.date.toISOString();

    // Always emit chat metadata for discovery
    this.opts.onChatMetadata(jid, timestamp, undefined, 'imessage', msg.isGroupChat);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const content = msg.text || '';
    const senderName = msg.senderName || msg.sender;

    const isBotMessage = msg.isFromMe || content.startsWith(`${ASSISTANT_NAME}:`);

    this.opts.onMessage(jid, {
      id: msg.guid,
      chat_jid: jid,
      sender: msg.sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: msg.isFromMe,
      is_bot_message: isBotMessage,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prefixed = `${ASSISTANT_NAME}: ${text}`;
    const chatId = this.extractChatId(jid);

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info({ jid, length: prefixed.length, queueSize: this.outgoingQueue.length }, 'iMessage disconnected, message queued');
      return;
    }

    try {
      await this.sdk.send(chatId, prefixed);
      logger.info({ jid, length: prefixed.length }, 'iMessage sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send iMessage, queued');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('imsg:') || jid.startsWith('imsg-group:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      await this.sdk.stopWatching();
      await this.sdk.close();
    } catch (err) {
      logger.debug({ err }, 'Error during iMessage disconnect');
    }
  }

  /**
   * Sync chat metadata from iMessage.
   * Fetches all chats and stores their names in the database.
   */
  async syncChatMetadata(force = false): Promise<void> {
    try {
      logger.info('Syncing chat metadata from iMessage...');
      const chats = await this.sdk.listChats();

      let count = 0;
      for (const chat of chats) {
        const jid = chat.isGroup
          ? `imsg-group:${chat.chatId}`
          : `imsg:${chat.chatId}`;

        if (chat.displayName) {
          updateChatName(jid, chat.displayName);
          count++;
        }
      }

      logger.info({ count }, 'iMessage chat metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync iMessage chat metadata');
    }
  }

  private extractChatId(jid: string): string {
    if (jid.startsWith('imsg-group:')) return jid.slice('imsg-group:'.length);
    if (jid.startsWith('imsg:')) return jid.slice('imsg:'.length);
    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing iMessage outgoing queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const chatId = this.extractChatId(item.jid);
        await this.sdk.send(chatId, item.text);
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued iMessage sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}
