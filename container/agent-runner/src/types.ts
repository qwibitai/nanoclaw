export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  model?: string;
  effort?: string;
  thinking_budget?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** true = streaming chunk (not final); omit or false = final result */
  partial?: boolean;
  /** Cumulative token usage from the SDK result message */
  usage?: { inputTokens: number; outputTokens: number; numTurns: number };
  /** Model context window size in tokens (from SDK modelUsage) */
  contextWindow?: number;
  /** True when a compact_boundary event was observed during this query */
  compacted?: boolean;
  /** Rate limit info from SDKRateLimitEvent (subscription users) */
  rateLimit?: {
    utilization?: number;
    resetsAt?: number;
    rateLimitType?: string;
  };
}

export interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

export interface SessionsIndex {
  entries: SessionEntry[];
}

export interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}
