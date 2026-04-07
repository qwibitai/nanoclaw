/**
 * ChannelDriver + ChannelDriverFactory — user-facing channel interfaces.
 *
 * Users provide a ChannelDriverFactory. The SDK calls it with config
 * (callbacks) at agent.start() or agent.addChannel() time. The factory
 * returns a ChannelDriver. The SDK wraps it into the internal Channel.
 */

/** What a channel implementor provides. */
export interface ChannelDriver {
  /** Send a message to a chat. Called by the agent VM when it responds. */
  send(chatId: string, text: string): Promise<void>;

  /** Start receiving messages. Called once by the SDK. */
  start(): Promise<void>;

  /** Stop receiving messages and clean up resources. */
  stop(): Promise<void>;

  /** Return true if this driver handles the given JID. */
  ownsJid(jid: string): boolean;

  /** Optional: get the channel's identity (bot name, username). */
  identity?(): Promise<ChannelIdentity>;

  /** Optional: typing indicator. */
  setTyping?(chatId: string, on: boolean): Promise<void>;
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
 * Called by the SDK with config — returns a driver instance.
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

export interface ChannelIdentity {
  name: string;
  username?: string;
}
