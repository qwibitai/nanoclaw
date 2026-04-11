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
  //            'braintrust' (observability MCP; explicit Bearer header from BRAINTRUST_API_KEY),
  //            'omni' (analytics MCP; explicit Bearer header from OMNI_API_KEY),
  //            'browser-auth', 'browser-auth:<scope>' (e.g. 'browser-auth:illyse' → reads BROWSER_AUTH_{URL,EMAIL,PASSWORD}_ILLYSE)
  // Account-specific gmail mounts only that account's credentials as the default.
  // Account-specific calendar stages a filtered tokens.json with only allowed accounts.
  // Account-specific google-workspace stages filtered credential files (email.json) for allowed accounts.
  // Connection-specific snowflake filters connections.toml to only allowed sections + keys.
  // Scope-specific github reads GITHUB_TOKEN_<SCOPE> from .env instead of global GITHUB_TOKEN.
  // Scope-specific render reads RENDER_API_KEY_<SCOPE>, RENDER_PG_*_<SCOPE>_*, RENDER_REDIS_*_<SCOPE>_*.
  tools?: string[];
  tone?: string; // Default tone profile name (e.g. "assistant", "engineering"). Read from tone-profiles/{name}.md
  globalContext?: boolean; // Mount groups/global/ into container (default true; set false for shared groups)
  readOnlyProjectRoot?: boolean; // Mount project root read-only so agents can explore the codebase (default false)
  enableThreadSessions?: boolean; // Default true for Discord/Slack; set false to disable
  sessionIdleResetHours?: number; // Override global idle reset (0 = never auto-reset)
  threadSessionIdleHours?: number; // Override idle reset for thread sessions
  notifyJid?: string; // Additional channel for ship log / backlog notifications (sends to this JID in addition to the default)
  watchGithub?: string[]; // GitHub orgs or owner/repo to scan for team PRs in daily summary (e.g. ["Illysium-ai", "davekim917/nanoclaw"])
  plugins?: string[]; // Plugin repos to mount from ~/plugins/ (e.g. ["bootstrap", "omni-claude-skills"]). Undefined = all plugins.
  dynamicModelDowngrade?: boolean; // Auto-downgrade trivial messages to Haiku (default: false, opt-in per group)
  /**
   * Let `gitnexus analyze` write its always-on MUST/NEVER block into each repo's
   * AGENTS.md and CLAUDE.md (default: false, opt-in per group).
   *
   * Default skips because most groups work on third-party repos that don't use
   * NanoClaw/gitnexus tooling, and the block would pollute them with tool-specific
   * instructions. Even when skipped, gitnexus still appends `.gitnexus` to each
   * repo's `.gitignore` (idempotent, commit-safe) and creates `.claude/skills/gitnexus/`
   * (required for in-container skill wiring) — both intentional and accepted.
   */
  gitnexusInjectAgentsMd?: boolean;
  /**
   * Marks this channel as the canonical auto-register template for its group folder.
   * When a new channel is auto-added to the same folder (e.g. bot invited to a new
   * Slack channel), it inherits this channel's containerConfig. Without this flag,
   * the sibling lookup falls back to the first matching channel, which may have a
   * customized (non-representative) config.
   *
   * This flag is intentionally stripped from auto-registered clones — it must not
   * propagate, or the canonical identity lookup breaks after the first auto-register.
   */
  isAutoRegisterTemplate?: boolean;
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
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
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

/**
 * Decision on a destructive-command gate — matches
 * the in-memory gate state in src/ipc.ts.
 */
export type GateDecision = 'approved' | 'cancelled';

/**
 * Reason a gate's chat-native buttons are being cleared. Used by
 * Channel.clearGateButtons to render the right explanatory text.
 * `auto_cancel_text` is only reachable via the orchestrator's
 * auto-cancel-on-text path, never from the teardown/TTL sweeps.
 */
export type GateClearReason =
  | 'auto_cancel_text'
  | 'ttl_expired'
  | 'teardown'
  | 'other';

/**
 * User-facing explanation shown when a gate's buttons are cleared via
 * Channel.clearGateButtons. Single source of truth so Slack and Discord
 * can't drift on safety-relevant copy.
 */
export const GATE_CLEAR_REASON_TEXT: Record<GateClearReason, string> = {
  auto_cancel_text: 'auto-cancelled by your text reply',
  ttl_expired: 'expired (no decision within the TTL)',
  teardown: 'cancelled (session ended)',
  other: 'resolved via another path',
};

/**
 * Payload a channel needs to render an interactive destructive-command gate.
 * Channels that support interactive components (buttons) render approve/cancel
 * controls so the user doesn't have to type `approve`/`cancel` as text.
 */
export interface InteractiveGate {
  /**
   * Opaque gate identifier — round-tripped through button action IDs.
   * Constraints:
   * - ASCII alphanumeric + `-` + `_`. Unicode is NOT safe through Slack/Discord button payloads.
   * - Max ~80 chars so Discord's 100-char custom_id limit (prefixed with `gate_approve:` / `gate_cancel:`) is not exceeded.
   * - Lifetime bounded by GATE_TTL_MS (10 min); buttons no-op after expiry.
   */
  gateId: string;
  /** Short label (e.g. "Destructive Snowflake SQL (DROP/TRUNCATE/DELETE)"). */
  label: string;
  /** Longer description of what the agent is about to do. */
  summary: string;
  /** Optional command preview (truncated before display). */
  command?: string;
}

/**
 * Callback a channel invokes when the user resolves a gate via an
 * interactive component (button/action). The orchestrator wires this to
 * resolveInMemoryGate so the plugin hook poll unblocks.
 *
 * Returns `true` when the gate was found and resolved by this call, `false`
 * when it was already gone (TTL expired, auto-cancelled by a text reply,
 * duplicate click, or bot restart). Channels MUST branch on this value and
 * render an "already resolved" indicator instead of a success/cancel
 * indicator when it returns false — otherwise a stale button click falsely
 * tells the user a destructive command was authorised when it was not.
 *
 * Synchronous because `resolveInMemoryGate` is synchronous (writes a file via
 * writeFileSync + Map.delete, no event-loop yield). If gate resolution
 * becomes async, this signature must change to `Promise<boolean>` and all
 * button handlers must `await` before rendering UI.
 */
export type OnGateAction = (gateId: string, decision: GateDecision) => boolean;

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
  /**
   * Post a destructive-command gate as an interactive message with native
   * approve/cancel buttons. Channels that implement this MUST also dispatch
   * button clicks into ChannelOpts.onGateAction. Channels that do NOT
   * implement it fall back to the plain-text gate prompt handled by ipc.ts.
   *
   * Failures (API errors, unsendable channel, missing client) MUST throw —
   * the IpcDeps wrapper translates throws into a text fallback.
   *
   * @param jid chat JID (may be parent or thread-scoped)
   * @param gate gate payload (see `InteractiveGate` for constraints)
   * @param triggerMessageId optional trigger message anchor; Discord uses
   *   this to create a fresh thread when the gate fires before any agent
   *   text output has created one. Slack threads are anchored by the
   *   user's triggering message ts (replyThreadTs).
   */
  sendInteractiveGate?(
    jid: string,
    gate: InteractiveGate,
    triggerMessageId?: string | null,
  ): Promise<void>;
  /**
   * Clear the approve/cancel buttons on a previously-posted interactive
   * gate message and replace them with a resolution indicator. Called
   * when a gate resolves via a non-click path (auto-cancel-on-text, TTL
   * expiry, container teardown) to keep the chat UI consistent with the
   * actual gate state. Non-fatal on failure — log and return.
   */
  clearGateButtons?(
    channelId: string,
    messageId: string,
    decision: GateDecision,
    reason: GateClearReason,
  ): Promise<void>;
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
