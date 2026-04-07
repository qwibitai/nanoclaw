/**
 * Typed event map for Agent.
 * Single source of truth — IDE autocompletes event names and payload types.
 */

/** All events an Agent can emit. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AgentEvents extends Record<string, any[]> {
  'message.in': [payload: MessageInEvent];
  'message.out': [payload: MessageOutEvent];
  'chat.metadata': [payload: ChatMetadataEvent];
  'channel.connected': [payload: { key: string }];
  'channel.disconnected': [payload: { key: string }];
  'group.registered': [payload: GroupRegisteredEvent];
  started: [];
  stopped: [];
}

/** A group was registered with the agent. */
export interface GroupRegisteredEvent {
  jid: string;
  name: string;
  folder: string;
}

/** Inbound message received from a user. */
export interface MessageInEvent {
  jid: string;
  sender: string;
  text: string;
  timestamp: string;
}

/** Outbound message sent by the agent. */
export interface MessageOutEvent {
  jid: string;
  text: string;
  timestamp: string;
}

/** Chat/group metadata discovered from a channel. */
export interface ChatMetadataEvent {
  jid: string;
  timestamp: string;
  name?: string;
  channel?: string;
  isGroup?: boolean;
}
