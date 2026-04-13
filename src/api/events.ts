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
  'run.sdk_message': [payload: RunSdkMessageEvent];
  'run.tool': [payload: RunToolEvent];
  'run.tool_progress': [payload: RunToolProgressEvent];
  'run.subagent': [payload: RunSubagentEvent];
  'run.status': [payload: RunStatusEvent];
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

/**
 * Raw SDK message from the agent runtime.
 * Exposes all 21 SDK message types — consumers can filter by sdkType/sdkSubtype.
 *
 * Common sdkType values: 'assistant', 'result', 'system', 'stream_event',
 * 'tool_progress', 'tool_use_summary', 'auth_status', 'rate_limit_event',
 * 'prompt_suggestion'.
 *
 * Common sdkSubtype values (when sdkType='system'): 'init', 'status',
 * 'task_started', 'task_progress', 'task_notification', 'compact_boundary',
 * 'local_command_output', 'hook_started', 'hook_progress', 'hook_response',
 * 'files_persisted', 'elicitation_complete'.
 */
export interface RunSdkMessageEvent {
  /** Stable agent identifier. */
  agentId: string;
  /** Group/chat identifier. */
  jid: string;
  /** Top-level SDK message type. */
  sdkType: string;
  /** For system messages: the subtype. */
  sdkSubtype?: string;
  /** The raw SDK message object. Shape depends on sdkType. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any;
  /** ISO timestamp when the event was received by the host. */
  timestamp: string;
}

// ── Curated convenience events (derived from sdk_message) ────────

/** The agent is invoking a tool. */
export interface RunToolEvent {
  /** Stable agent identifier. */
  agentId: string;
  /** Group/chat identifier. */
  jid: string;
  /** Tool name (e.g. 'Bash', 'Read', 'WebSearch'). */
  toolName: string;
  /** SDK tool use ID. */
  toolUseId: string;
  /** Truncated tool input for observability. */
  input?: string;
  /** ISO timestamp. */
  timestamp: string;
}

/** Tool execution progress heartbeat. */
export interface RunToolProgressEvent {
  /** Stable agent identifier. */
  agentId: string;
  /** Group/chat identifier. */
  jid: string;
  /** Tool name. */
  toolName: string;
  /** SDK tool use ID. */
  toolUseId: string;
  /** Seconds since tool invocation started. */
  elapsedSeconds: number;
  /** ISO timestamp. */
  timestamp: string;
}

/** Subagent lifecycle event. */
export interface RunSubagentEvent {
  /** Stable agent identifier. */
  agentId: string;
  /** Group/chat identifier. */
  jid: string;
  /** Subagent lifecycle phase. */
  subtype: 'started' | 'progress' | 'completed' | 'failed' | 'stopped';
  /** SDK task ID for the subagent. */
  taskId: string;
  /** Description of what the subagent is doing. */
  description: string;
  /** Summary of progress or result. */
  summary?: string;
  /** Last tool the subagent used. */
  lastToolName?: string;
  /** ISO timestamp. */
  timestamp: string;
}

/** Agent status change (e.g. context compaction). */
export interface RunStatusEvent {
  /** Stable agent identifier. */
  agentId: string;
  /** Group/chat identifier. */
  jid: string;
  /** Status string (e.g. 'compacting'). */
  status: string;
  /** ISO timestamp. */
  timestamp: string;
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
