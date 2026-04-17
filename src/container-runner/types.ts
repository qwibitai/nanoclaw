// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}
