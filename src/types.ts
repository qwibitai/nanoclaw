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

/** Minimal process interface compatible with Bun.spawn's Subprocess */
export interface ContainerProcess {
  readonly killed: boolean;
  kill(signal?: number | string): void;
  readonly pid: number;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  memory?: number;  // Container memory in MB. Default: 4096
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval: string;        // cron expression or ms interval
  scheduleType: 'cron' | 'interval';
}

export type BackendType = 'apple-container' | 'docker' | 'sprites' | 'daytona' | 'railway';

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  autoRespondToQuestions?: boolean; // Respond to messages ending with '?' (default: false)
  autoRespondKeywords?: string[]; // Keywords that trigger response without mention (e.g., ["omni", "help"])
  heartbeat?: HeartbeatConfig;
  discordGuildId?: string;  // Discord guild/server ID (for server-level context)
  serverFolder?: string;    // e.g., "servers/omniaura-discord" (shared across channels in same server)
  backend?: BackendType;     // Which backend runs this group's agent (default: apple-container)
  description?: string;      // What this agent does (for agent registry)
  devUrl?: string;           // Sprites dev URL (auto-populated for sprites backend)
  streamIntermediates?: boolean; // Stream intermediate output (thinking, tool calls) to channel threads. Default: false
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
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
  sendMessage(jid: string, text: string): Promise<string | void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: thread support for streaming intermediate output.
  createThread?(jid: string, messageId: string, name: string): Promise<any>;
  sendToThread?(thread: any, text: string): Promise<void>;
  // Optional: add/remove emoji reactions on messages.
  addReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  removeReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  // Whether to prefix outbound messages with the assistant name.
  // Telegram bots already display their name, so they return false.
  // WhatsApp returns true. Default true if not implemented.
  prefixAssistantName?: boolean;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
export type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;

// --- Agent-Channel Decoupling ---

/**
 * An Agent is an autonomous entity that handles messages for one or more channels.
 * Replaces RegisteredGroup as the primary routing unit.
 */
export interface Agent {
  id: string;                    // "main", "omniaura-discord"
  name: string;
  description?: string;
  folder: string;                // Workspace folder (= id for backwards compat)
  backend: BackendType;
  containerConfig?: ContainerConfig;
  heartbeat?: HeartbeatConfig;
  isAdmin: boolean;              // Local agent = true (can approve tasks, access local FS)
  isLocal: boolean;              // Runs on local machine (Apple Container)
  serverFolder?: string;         // Shared server context (e.g., "servers/omniaura-discord")
  createdAt: string;
}

/**
 * Maps a channel JID to an agent.
 * Multiple channels can route to the same agent.
 */
export interface ChannelRoute {
  channelJid: string;            // "dc:123", "tg:-100...", "123@g.us"
  agentId: string;               // FK to Agent.id
  trigger: string;
  requiresTrigger: boolean;
  discordGuildId?: string;
  createdAt: string;
}

/**
 * Convert a RegisteredGroup + JID into an Agent (for migration).
 */
export function registeredGroupToAgent(jid: string, group: RegisteredGroup): Agent {
  const isMainGroup = group.folder === 'main';
  const backendType = group.backend || 'apple-container';
  return {
    id: group.folder,
    name: group.name,
    description: group.description,
    folder: group.folder,
    backend: backendType,
    containerConfig: group.containerConfig,
    heartbeat: group.heartbeat,
    isAdmin: isMainGroup,
    isLocal: backendType === 'apple-container' || backendType === 'docker',
    serverFolder: group.serverFolder,
    createdAt: group.added_at,
  };
}

/**
 * Convert a RegisteredGroup + JID into a ChannelRoute (for migration).
 */
export function registeredGroupToRoute(jid: string, group: RegisteredGroup): ChannelRoute {
  return {
    channelJid: jid,
    agentId: group.folder,
    trigger: group.trigger,
    requiresTrigger: group.requiresTrigger !== false,
    discordGuildId: group.discordGuildId,
    createdAt: group.added_at,
  };
}
