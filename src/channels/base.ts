/**
 * Base Channel Abstraction for NanoClaw
 *
 * All communication channels (WhatsApp, Telegram, Discord) implement this interface.
 * Inspired by nanobot's channel architecture but keeping NanoClaw's simplicity.
 */
import { EventEmitter } from 'events';

export interface InboundMessage {
  /** Unique message ID from the platform */
  id: string;
  /** Channel type identifier */
  channel: string;
  /** Chat/group identifier on the platform */
  chatId: string;
  /** Sender identifier */
  senderId: string;
  /** Sender display name */
  senderName: string;
  /** Message text content */
  content: string;
  /** ISO timestamp */
  timestamp: string;
  /** Whether this message was sent by the bot itself */
  isFromMe: boolean;
  /** Optional raw platform-specific data */
  raw?: unknown;
}

export interface OutboundMessage {
  /** Target channel */
  channel: string;
  /** Target chat/group ID */
  chatId: string;
  /** Message text */
  content: string;
}

export interface ChannelConfig {
  /** Whether this channel is enabled */
  enabled: boolean;
  /** Allowed sender IDs (empty = allow all) */
  allowedUsers: string[];
}

/**
 * Abstract base class for all communication channels.
 * Emits 'message' events when new messages arrive.
 */
export abstract class BaseChannel extends EventEmitter {
  readonly channelType: string;
  protected config: ChannelConfig;
  private allowedUsersSet: Set<string>;

  constructor(channelType: string, config: ChannelConfig) {
    super();
    this.channelType = channelType;
    this.config = config;
    this.allowedUsersSet = new Set(config.allowedUsers);
  }

  /** Start listening for messages */
  abstract start(): Promise<void>;

  /** Stop the channel gracefully */
  abstract stop(): Promise<void>;

  /** Send a message to a chat */
  abstract sendMessage(chatId: string, text: string): Promise<void>;

  /** Check if a sender is allowed to interact (O(1) Set lookup) */
  isAllowed(senderId: string): boolean {
    if (this.allowedUsersSet.size === 0) return true;
    return this.allowedUsersSet.has(senderId);
  }

  /** Emit an inbound message (called by subclass implementations) */
  protected emitMessage(msg: InboundMessage): void {
    if (!this.isAllowed(msg.senderId)) {
      return; // Silently drop unauthorized messages
    }
    this.emit('message', msg);
  }
}
