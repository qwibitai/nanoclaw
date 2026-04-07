/**
 * ChannelDriver — user-facing interface for messaging platform adapters.
 *
 * Implement this to connect AgentLite to a messaging platform
 * (Telegram, Slack, Discord, custom UI, etc.).
 */

/** What a channel implementor provides. */
export interface ChannelDriver {
  /** Send a message to a chat. Called by the agent VM when it responds. */
  send(chatId: string, text: string): Promise<void>;

  /**
   * Start receiving messages. The SDK calls this once at agent.start().
   * Call `onMessage` whenever an inbound message arrives.
   */
  start(onMessage: OnMessage): Promise<void>;

  /** Stop receiving messages and clean up resources. */
  stop(): Promise<void>;

  /** Optional: get the channel's identity (bot name, username). */
  identity?(): Promise<ChannelIdentity>;

  /** Optional: typing indicator. */
  setTyping?(chatId: string, on: boolean): Promise<void>;
}

/** Callback for delivering inbound messages to the agent. */
export type OnMessage = (chatId: string, message: Message) => void;

/** An inbound message from a messaging platform. */
export interface Message {
  sender: string;
  content: string;
  timestamp: string;
  senderName?: string;
}

export interface ChannelIdentity {
  name: string;
  username?: string;
}
