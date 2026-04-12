/**
 * Typed event map for Agent.
 * Single source of truth — IDE autocompletes event names and payload types.
 */

/** All events an Agent can emit. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AgentEvents extends Record<string, any[]> {
  'message.in': [payload: MessageInEvent];
  'message.out': [payload: MessageOutEvent];
  'run.state': [payload: RunStateEvent];
  'chat.metadata': [payload: ChatMetadataEvent];
  'channel.connected': [payload: { key: string }];
  'channel.disconnected': [payload: { key: string }];
  'group.registered': [payload: GroupRegisteredEvent];
  started: [];
  stopped: [];
}

/** A group was registered with the agent. */
export interface GroupRegisteredEvent {
  /** Stable group/chat identifier from the channel. */
  jid: string;
  /** Human-readable group name. */
  name: string;
  /** Folder name for group data. */
  folder: string;
}

/** Inbound message received from a user. */
export interface MessageInEvent {
  /** Group/chat identifier where the message originated. */
  jid: string;
  /** Display name of the sender. */
  sender: string;
  /** Message text content. */
  text: string;
  /** ISO timestamp when the message was received. */
  timestamp: string;
}

/** Outbound message sent by the agent. */
export interface MessageOutEvent {
  /** Group/chat identifier where the message was sent. */
  jid: string;
  /** Message text content. */
  text: string;
  /** ISO timestamp when the message was sent. */
  timestamp: string;
}

/** The runtime state of a container-backed agent run. */
export interface RunStateEvent {
  /** Stable agent identifier that owns the runtime. */
  agentId: string;
  /** Group/chat identifier where the run is executing. */
  jid: string;
  /** Human-readable group name. */
  name: string;
  /** Folder name for the group's data. */
  folder: string;
  /** Current lifecycle state. */
  state: 'active' | 'idle' | 'stopped';
  /** ISO timestamp when the transition was observed. */
  timestamp: string;
  /** Optional stop/transition reason from the runtime. */
  reason?: string;
  /** Exit code when the runtime reaches stopped. */
  exitCode?: number;
}

/** Chat/group metadata discovered from a channel. */
export interface ChatMetadataEvent {
  /** Group/chat identifier. */
  jid: string;
  /** ISO timestamp of the metadata update. */
  timestamp: string;
  /** Human-readable chat/group name, if available. */
  name?: string;
  /** Channel key that discovered this metadata (e.g. 'telegram'). */
  channel?: string;
  /** Whether this is a group chat (vs. a direct message). */
  isGroup?: boolean;
}
