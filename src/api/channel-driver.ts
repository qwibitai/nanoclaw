/**
 * ChannelDriver — user-facing interface for messaging platform adapters.
 * Method names align with the internal Channel interface.
 * ChannelDriver + { name } = Channel.
 */

/** What a channel implementor provides. */
export interface ChannelDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}

/** Config the SDK provides to the factory at channel creation time. */
export interface ChannelDriverConfig {
  onMessage: (chatJid: string, msg: InboundMessage) => void;
  onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
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
  chat_jid: string;
  sender: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  sender_name?: string;
  attachments?: string[];
}
