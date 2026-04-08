/**
 * ChannelDriver — user-facing interface for messaging platform adapters.
 * Method names align with the internal Channel interface.
 * ChannelDriver + { name } = Channel.
 */

/** What a channel implementor provides. */
export interface ChannelDriver {
  /** Connect to the messaging platform. Called during agent.start(). */
  connect(): Promise<void>;
  /** Disconnect from the messaging platform. Called during agent.stop(). */
  disconnect(): Promise<void>;
  /** Send a text message to a group/chat. */
  sendMessage(jid: string, text: string): Promise<void>;
  /** Whether the channel is currently connected. */
  isConnected(): boolean;
  /** Whether this channel owns the given JID (e.g. 'tg:' prefix for Telegram). */
  ownsJid(jid: string): boolean;
  /** Show a typing indicator in a group/chat. Optional. */
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  /** Sync group/chat names from the platform. Optional. */
  syncGroups?(force: boolean): Promise<void>;
}

/** Config the SDK provides to the factory at channel creation time. */
export interface ChannelDriverConfig {
  /** Callback to deliver an inbound message to the agent. */
  onMessage: (chatJid: string, msg: InboundMessage) => void;
  /** Callback to report chat/group metadata discovered from the platform. */
  onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  /** Returns the current map of registered groups (keyed by JID). */
  registeredGroups: () => Record<string, unknown>;
}

/**
 * Factory function that creates a ChannelDriver.
 * Called by the SDK with config at agent.start() time.
 */
export type ChannelDriverFactory = (
  config: ChannelDriverConfig,
) => ChannelDriver | Promise<ChannelDriver>;

/** An inbound message from a messaging platform. */
export interface InboundMessage {
  /** Group/chat identifier where the message originated. */
  chat_jid: string;
  /** Sender identifier (platform-specific). */
  sender: string;
  /** Message text content. */
  content: string;
  /** ISO timestamp when the message was received. */
  timestamp: string;
  /** Whether the message was sent by the current bot/agent. */
  is_from_me: boolean;
  /** Whether the message was sent by another bot. */
  is_bot_message?: boolean;
  /** Display name of the sender, if available. */
  sender_name?: string;
  /** File attachment paths (downloaded by the channel). */
  attachments?: string[];
}
