export function isJarvisWorkerFolder(folder: string): boolean {
  return folder.startsWith('jarvis-worker');
}

export type LaneId =
  | 'main'
  | 'andy-developer'
  | 'jarvis-worker-1'
  | 'jarvis-worker-2';

export type LaneKind = 'external' | 'agent' | 'worker';

export interface LaneAddress {
  laneId: LaneId;
  laneKind: LaneKind;
  syntheticJid?: string;
  externalChatJid?: string;
}

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Hard container timeout (default from CONTAINER_TIMEOUT, 30 minutes)
  noOutputTimeout?: number; // No-output fail-fast timeout (default from CONTAINER_NO_OUTPUT_TIMEOUT, 12 minutes)
  idleTimeout?: number; // Idle stdin-close delay (default from IDLE_TIMEOUT, 5 minutes)
  model?: string;   // Claude model to use (e.g. 'claude-haiku-4-5-20251001')
  image?: string;   // Override container image (e.g. 'nanoclaw-worker:latest')
  secrets?: string[]; // Env var names to pass (defaults to all if not specified)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // Legacy compatibility for tests and DB round-trips
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  ingest_seq?: number;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

export interface WorkerProgressEvent {
  kind: 'worker_progress';
  run_id: string;
  group_folder: string;
  timestamp: string;
  phase: string;       // active phase label (e.g. "using bash", "thinking")
  summary: string;     // 1-line human-readable progress summary
  tool_used?: string;  // last tool call name if relevant
  seq: number;         // monotonic sequence number
}

export interface WorkerSteerEvent {
  kind: 'worker_steer';
  run_id: string;
  from_group: string;
  timestamp: string;
  message: string;     // plain text steering instruction
  steer_id: string;    // unique id for ack tracking
}
