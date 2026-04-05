export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
  useWorktree?: boolean; // Create a detached git worktree instead of mounting the repo directly
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
  assistantName?: string; // Per-group assistant name override (falls back to ASSISTANT_NAME)
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  model?: string; // Default model for this group (e.g. "claude-sonnet-4-6")
  // Integrations available inside this group's container.
  // Undefined = all tools (backwards compatible).
  // Supported: 'gmail', 'gmail:<account>' (full minus perma-delete),
  //            'gmail-readonly:<account>' (read-only), 'calendar',
  //            'calendar:<account>' (e.g. 'calendar:illysium'), 'granola',
  //            'google-workspace', 'google-workspace:<account>' (e.g. 'google-workspace:illysium'),
  //            'dbt', 'dbt:<profile>' (e.g. 'dbt:sunday-snowflake-db', 'dbt:apollo-snowflake'),
  //            'snowflake', 'snowflake:<connection>' (e.g. 'snowflake:sunday', 'snowflake:apollo'),
  //            'github', 'github:<scope>' (e.g. 'github:illysium' → reads GITHUB_TOKEN_ILLYSIUM from .env),
  //            'render', 'render:<scope>' (e.g. 'render:illysium' → API key + PG/Redis URLs for that scope),
  //            'aws', 'aws:<profile>' (e.g. 'aws:apollo' → only [apollo] + [default] from ~/.aws/),
  //            'railway' (passes RAILWAY_API_TOKEN env var),
  //            'gcloud', 'gcloud:<scope>' (e.g. 'gcloud:sunday' → mounts key from GCLOUD_KEY_SUNDAY),
  //            'exa' (web search + websets MCP; API key from EXA_API_KEY in .env),
  //            'braintrust' (observability MCP; auth via OneCLI proxy),
  //            'omni' (analytics MCP; auth via OneCLI proxy)
  // Account-specific gmail mounts only that account's credentials as the default.
  // Account-specific calendar stages a filtered tokens.json with only allowed accounts.
  // Account-specific google-workspace stages filtered credential files (email.json) for allowed accounts.
  // Connection-specific snowflake filters connections.toml to only allowed sections + keys.
  // Scope-specific github reads GITHUB_TOKEN_<SCOPE> from .env instead of global GITHUB_TOKEN.
  // Scope-specific render reads RENDER_API_KEY_<SCOPE>, RENDER_PG_*_<SCOPE>_*, RENDER_REDIS_*_<SCOPE>_*.
  tools?: string[];
  tone?: string; // Default tone profile name (e.g. "assistant", "engineering"). Read from tone-profiles/{name}.md
  globalContext?: boolean; // Mount groups/global/ into container (default true; set false for shared groups)
  enableThreadSessions?: boolean; // Default true for Discord/Slack; set false to disable
  sessionIdleResetHours?: number; // Override global idle reset (0 = never auto-reset)
  threadSessionIdleHours?: number; // Override idle reset for thread sessions
  notifyJid?: string; // Additional channel for ship log / backlog notifications (sends to this JID in addition to the default)
  watchGithub?: string[]; // GitHub orgs or owner/repo to scan for team PRs in daily summary (e.g. ["Illysium-ai", "davekim917/nanoclaw"])
  plugins?: string[]; // Plugin repos to mount from ~/plugins/ (e.g. ["bootstrap", "omni-claude-skills"]). Undefined = all plugins.
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  is_any_bot?: boolean; // True for messages from any bot (own or external)
  attachments?: Attachment[];
}

export interface Attachment {
  filename: string;
  mimeType: string;
  localPath: string; // absolute host path
  size: number;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  task_type?: 'container' | 'system'; // default 'container'
  schedule_tz?: string | null; // IANA timezone (e.g. 'America/New_York'). Null = use TIMEZONE from config
  blueprint_id?: string | null; // Links task to an installed Blueprint
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

export interface ShipLogEntry {
  id: string;
  group_folder: string;
  title: string;
  description: string | null;
  pr_url: string | null;
  branch: string | null;
  tags: string | null; // JSON array
  shipped_at: string;
}

export interface Memory {
  id: string;
  group_folder: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  name: string;
  description: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface PendingGate {
  id: string;
  group_folder: string;
  chat_jid: string;
  label: string;
  summary: string;
  context_data: string | null; // JSON blob
  resume_prompt: string | null;
  session_key: string | null;
  status: 'pending' | 'approved' | 'cancelled';
  created_at: string;
  resolved_at: string | null;
}

export interface BacklogItem {
  id: string;
  group_folder: string;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'resolved' | 'wont_fix';
  priority: 'low' | 'medium' | 'high';
  tags: string | null; // JSON array
  notes: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

// --- Outbound file attachments ---

export interface OutboundFile {
  hostPath: string;
  filename: string;
  mimeType: string;
}

// --- Channel abstraction ---

export interface SendMessageOptions {
  /** When true, suppress interactive elements like merge buttons. */
  suppressActions?: boolean;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    triggerMessageId?: string | null,
    options?: SendMessageOptions,
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: snapshot the trigger message ts for emoji reactions.
  // Call before setTyping(true) so reactions target the correct message
  // even when multiple parent messages are processing in parallel.
  setTriggerMessage?(jid: string, messageTs: string): void;
  // Optional: add/remove emoji reactions on a specific message.
  addReaction?(jid: string, messageTs: string, emoji: string): Promise<void>;
  removeReaction?(jid: string, messageTs: string, emoji: string): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: clear per-JID thread redirect state after container processing completes.
  // Prevents stale redirects from sending task/recap output into old threads.
  // When threadId is provided, only clear state for that specific thread.
  clearThreadState?(parentJid: string, threadId?: string): void;
  // Optional: fetch a single message by ID from the platform API.
  // Used as fallback when the message isn't in the local DB (e.g. external bot messages).
  fetchMessage?(
    jid: string,
    messageId: string,
  ): Promise<NewMessage | undefined>;
  // Optional: send a message with a custom sender identity (agent swarm).
  // Discord uses webhooks, Slack uses username override.
  // Channels that don't implement this fall back to normal sendMessage.
  sendSwarmMessage?(jid: string, text: string, sender: string): Promise<void>;
  // Optional: send a file (image, document) as a platform-native attachment.
  // Channels that don't implement this fall back to text-only with [File: name] placeholder.
  sendFile?(
    jid: string,
    file: OutboundFile,
    caption?: string,
    triggerMessageId?: string | null,
  ): Promise<void>;
  // Optional: resolve a parent JID to its active thread JID for IPC routing.
  // When a container sends IPC messages using its NANOCLAW_CHAT_JID (parent),
  // this resolves to the thread JID created by the streaming output path.
  // threadId narrows to the specific conversation (prevents cross-thread misrouting).
  resolveIpcJid?(jid: string, threadId?: string): string;
}

// --- Cockpit user management ---

export interface User {
  id: string;
  username: string;
  display_name: string | null;
  role: 'admin' | 'member';
  created_at: string;
  updated_at: string;
}

export interface McpServerConfig {
  id: string;
  group_folder: string;
  name: string;
  url: string;
  server_type: 'sse' | 'stdio' | 'streamable-http';
  created_at: string;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
