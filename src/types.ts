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
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
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
}

export interface User {
  id: string;        // human-readable slug: "admin", "mom", "sarah"
  name: string;      // display name: "Mom", "Sarah"
  phone: string | null;  // normalized digits: "14155551234"
  email: string | null;  // for iMessage email IDs: "sarah@icloud.com"
  role: 'admin' | 'member';
  created_at: string;
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
}

export interface TradingPreset {
  id: string;
  name: string;
  platform: string;          // polymarket, kalshi, all
  strategy: string;          // rsi_mean_reversion, probability_mispricing
  mode: string;              // paper, live
  initial_capital: number;
  risk_params: string;       // JSON: { max_drawdown, max_position_size, min_confidence, time_stop_days }
  schedule_type: string | null;
  schedule_value: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TradingRun {
  id: string;
  preset_id: string | null;
  task_id: string | null;
  type: string;              // backtest, paper, live
  status: string;            // pending, running, completed, failed, stopped
  platform: string;
  strategy: string;
  mode: string;              // paper, live
  initial_capital: number;
  risk_params: string;       // JSON snapshot
  start_date: string | null;
  end_date: string | null;
  results: string | null;    // JSON: { total_pnl, win_rate, max_drawdown, sharpe_ratio, equity_curve, trades }
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface MarketWatcher {
  id: string;
  name: string;
  token_ids: string;       // JSON array of token IDs
  market_slugs: string | null; // JSON array of display names
  interval_ms: number;     // 300000=5m, 900000=15m
  duration_ms: number;
  started_at: string;
  expires_at: string;
  status: string;          // active, completed, stopped
  data_points: number;
}

export interface OptimizationResult {
  id: string;
  watcher_id: string;
  strategy: string;
  param_ranges: string;    // JSON
  results: string;         // JSON: top combos
  optimize_for: string;
  created_at: string;
}

export interface PaperTrade {
  id: string;
  ticker: string;
  market_title: string | null;
  side: string;
  action: string;
  qty: number;
  entry_price: number;
  exit_price: number | null;
  status: string;
  strategy: string;
  market_type: string | null;
  event_ticker: string | null;
  close_time: string | null;
  notes: string | null;
  created_at: string;
  settled_at: string | null;
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
