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

/**
 * Provider selection for the agent runtime inside the container.
 *
 * - `anthropic` (default): Claude API via OneCLI gateway. No special wiring.
 * - `ollama`: Redirect the Claude SDK at a local/remote Ollama instance via
 *   `ANTHROPIC_BASE_URL` env override. Ollama 0.4+ speaks the Anthropic
 *   v1/messages API natively, so the SDK can't tell the difference and
 *   no provider-side code change is needed.
 *
 *   When `provider === 'ollama'`, the container-runner:
 *     1. Injects `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` env vars.
 *     2. Adds `NO_PROXY` for the Ollama host so the OneCLI HTTPS_PROXY
 *        doesn't intercept the redirect (NO_PROXY beats HTTPS_PROXY at
 *        request time).
 *     3. Upserts `model` into the per-group `.claude/settings.json` so
 *        the SDK picks up the local model name.
 *     4. Routes `api.anthropic.com` to 127.0.0.1 via `--add-host` so any
 *        accidental escape attempt fails closed instead of leaking traffic.
 */
export type AgentProvider = 'anthropic' | 'ollama';

export interface OllamaProviderConfig {
  /** Base URL for the Ollama HTTP server. e.g. "http://host.docker.internal:11434" */
  baseUrl: string;
  /** Ollama model tag. e.g. "qwen2.5:32b-instruct-q4_K_M" */
  model: string;
  /** API key string. Ollama ignores the value but the SDK requires one set. Default: "ollama". */
  apiKey?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  /** Agent provider. Default: 'anthropic'. Set 'ollama' for fully-local/air-gapped runs. */
  provider?: AgentProvider;
  /** Required when provider === 'ollama'. */
  ollama?: OllamaProviderConfig;
  /**
   * Raw env-var overlay. Merged after provider auto-derived vars,
   * so this can override anything (escape hatch).
   */
  env?: Record<string, string>;
  /**
   * Hostnames to route to 127.0.0.1 inside the container via `--add-host`.
   * Used to fail-closed on escape attempts (e.g. block `api.anthropic.com`
   * when running an Ollama-only container).
   */
  blockedHosts?: string[];
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
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
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
  // Optional: called when the agent finishes a turn (result.status === 'success').
  // Fired before the container goes idle — lets channels close streams without
  // waiting for the idle timeout.
  onTurnComplete?(jid: string): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
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
