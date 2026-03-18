/**
 * ThagomizerClaw — Cloudflare Workers Type Definitions
 *
 * Bindings reflect wrangler.toml configuration.
 * Secrets are injected at runtime by Cloudflare — never in code or env files.
 */

// ─── Cloudflare Worker Environment Bindings ─────────────────────────────────

export interface Env {
  // D1 database (messages, groups, tasks, sessions)
  DB: D1Database;

  // R2 object storage (group CLAUDE.md files, session data, logs)
  STORAGE: R2Bucket;

  // KV store (hot state: cursors, active sessions, rate limits)
  STATE: KVNamespace;

  // Queue for async message processing
  MESSAGE_QUEUE: Queue<QueueMessage>;

  // Workers AI binding
  AI: Ai;

  // Durable Objects
  GROUP_SESSION: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;

  // Non-secret env vars (from wrangler.toml [vars])
  ASSISTANT_NAME: string;
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  MAX_CONCURRENT_AGENTS: string;
  AGENT_TIMEOUT_MS: string;
  WORKER_AI_MODEL: string;

  // Secrets (injected by Cloudflare, set via `wrangler secret put`)
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  WEBHOOK_SECRET: string;
}

// ─── Domain Types ────────────────────────────────────────────────────────────

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  channel?: string;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
  agentConfig?: AgentConfig;
}

export interface AgentConfig {
  timeout?: number;
  model?: string;
  maxTokens?: number;
  useWorkersAI?: boolean;
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
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

export interface AgentSession {
  group_folder: string;
  session_id: string;
  updated_at: string;
}

// ─── Queue Message Types ──────────────────────────────────────────────────────

export type QueueMessage =
  | InboundMessageJob
  | ScheduledTaskJob;

export interface InboundMessageJob {
  type: 'inbound_message';
  chatJid: string;
  messages: NewMessage[];
  timestamp: string;
}

export interface ScheduledTaskJob {
  type: 'scheduled_task';
  taskId: string;
  groupFolder: string;
  chatJid: string;
  prompt: string;
}

// ─── Agent I/O ────────────────────────────────────────────────────────────────

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  claudeMd?: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ─── Channel Abstraction ──────────────────────────────────────────────────────

export interface ChannelWebhookHandler {
  /** Verify the incoming webhook request is authentic */
  verify(request: Request, env: Env): Promise<boolean>;
  /** Parse the webhook payload into normalized messages */
  parse(request: Request, env: Env): Promise<ParsedWebhookEvent | null>;
  /** Send a message back to the channel */
  send(jid: string, text: string, env: Env): Promise<void>;
}

export interface ParsedWebhookEvent {
  chatJid: string;
  message: NewMessage;
  channel: 'telegram' | 'discord' | 'slack';
  /** Optional typing indicator support */
  sendTyping?: () => Promise<void>;
}

// ─── Durable Object State ─────────────────────────────────────────────────────

export interface GroupSessionState {
  sessionId?: string;
  lastAgentTimestamp?: string;
  isProcessing: boolean;
  queuedMessages: NewMessage[];
  lastActivity: string;
}
