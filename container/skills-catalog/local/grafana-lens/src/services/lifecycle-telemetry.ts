/**
 * Lifecycle Telemetry — gen_ai-compliant session-scoped traces
 *
 * Converts OpenClaw plugin hook events into hierarchical OTel traces
 * following the gen_ai semantic conventions (v1.27.0+).
 *
 * Trace hierarchy (all spans share the same trace_id per session):
 *   invoke_agent openclaw                        (root, INTERNAL)
 *   +-- chat {model}                             (CLIENT)
 *   +-- execute_tool {toolName}                  (INTERNAL, sibling of chat)
 *   +-- chat {model}                             (CLIENT, next turn)
 *   +-- openclaw.compaction                      (INTERNAL)
 *   +-- openclaw.subagent.spawn {agentId}        (INTERNAL)
 *   +-- openclaw.agent.end                       (INTERNAL)
 *
 * Context propagation: Explicit — no global TracerProvider.
 * Uses trace.setSpan(ROOT_CONTEXT, parentSpan) + 3rd arg to startSpan().
 *
 * Also records gen_ai standard metrics:
 *   - gen_ai.client.token.usage (histogram)
 *   - gen_ai.client.operation.duration (histogram, seconds)
 */

import { trace, ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { Span, Context } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { Counter, Histogram } from "@opentelemetry/api";
import type { OtelTraces } from "./otel-traces.js";
import type { OtelLogs } from "./otel-logs.js";
import { redactSecrets, flattenLogKeys } from "./redact.js";

// ══════════════════════════════════════════════════════════════════════
// Hook event types — NOT exported from openclaw/plugin-sdk
// Source: openclaw/src/plugins/types.ts
// ══════════════════════════════════════════════════════════════════════

export type SessionStartEvent = {
  sessionId: string;
  resumedFrom?: string;
};

export type SessionStartCtx = {
  agentId?: string;
  sessionId: string;
};

export type SessionEndEvent = {
  sessionId: string;
  messageCount: number;
  durationMs?: number;
};

export type SessionEndCtx = {
  agentId?: string;
  sessionId: string;
};

export type LlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

export type LlmInputCtx = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type LlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type LlmOutputCtx = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

export type AgentEndCtx = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type MessageReceivedEvent = {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};

export type MessageReceivedCtx = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

export type MessageSentEvent = {
  to: string;
  content: string;
  success: boolean;
  error?: string;
};

export type MessageSentCtx = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

export type BeforeCompactionEvent = {
  messageCount: number;
  compactingCount?: number;
  tokenCount?: number;
  sessionFile?: string;
};

export type BeforeCompactionCtx = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type AfterCompactionEvent = {
  messageCount: number;
  compactedCount: number;
  tokenCount?: number;
  sessionFile?: string;
};

export type AfterCompactionCtx = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type SubagentSpawnedEvent = {
  runId: string;
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: string;
  requester?: string;
  threadRequested: boolean;
};

export type SubagentSpawnedCtx = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
};

export type SubagentEndedEvent = {
  targetSessionKey: string;
  targetKind: string;
  reason: string;
  outcome?: string;
  error?: string;
  endedAt?: string;
};

export type SubagentEndedCtx = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
};

export type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

export type AfterToolCallCtx = {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
  toolCallId?: string;
};

// ── New hook types (Part 5) ─────────────────────────────────────────

export type BeforeResetEvent = {
  sessionFile?: string;
  messages?: unknown[];
  reason?: string;
};

export type BeforeResetCtx = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
};

export type BeforeToolCallCtx = {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
};

export type GatewayStartEvent = {
  port?: number;
};

export type GatewayStopEvent = {
  reason?: string;
};

// ══════════════════════════════════════════════════════════════════════
// In-memory trace state
// ══════════════════════════════════════════════════════════════════════

type SessionTraceState = {
  rootSpan: Span;
  ctx: Context;
  sessionId: string;
  startTime: number;
  // Per-session accumulators for cost attribution
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  // Cache token tracking
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  // Message type counters
  messageCountUser: number;
  messageCountAssistant: number;
  messageCountToolCalls: number;
  messageCountToolResults: number;
  messageCountErrors: number;
  // Tool usage tracking
  toolCounts: Map<string, number>;
  // Tool error tracking (for repeated failure detection)
  toolErrorCounts: Map<string, number>;
  // Accumulated tool execution time (for active duration calculation)
  totalToolDurationMs: number;
  // Latency tracking (from llm_input/llm_output pairs)
  latencies: number[];          // capped reservoir (last 200 entries) for P95
  latencySum: number;           // running accumulator: total of all latencies
  latencyMin: number;           // running accumulator: minimum latency
  latencyMax: number;           // running accumulator: maximum latency
  latencyCount: number;         // running accumulator: number of latency samples
  // Model tracking
  primaryModel: string;
  primaryProvider: string;
  // Channel (set on first message_received)
  channel: string;
  // Session identity
  sessionKey: string;
  agentId: string;
  // Cost threshold tracking (only log once per threshold per session)
  costThresholdsLogged: Set<number>;
  // Span name enrichment: only enrich root span once with first user message
  firstMessageCaptured: boolean;
  // Finalization guard: true once finalizeSession() has run (prevents double-close)
  finalized: boolean;
  // Deferred summary emission: guards against duplicate "final" summaries
  summaryEmitted?: boolean;     // guard: only emit one "final" summary
  pendingSummary?: boolean;     // true when finalized but waiting for last LLM call
  finalDurationMs?: number;     // stored for deferred emission
  // Subagent hierarchy: set by deferred linking in onLlmInput
  parentSessionId?: string;
  parentTraceId?: string;
  isSubagent: boolean;
  parentLinked: boolean;  // guard: only link once
};

type LlmCallState = {
  span: Span;
  ctx: Context;
  sessionKey: string;
  startTime: number;
};

// ══════════════════════════════════════════════════════════════════════
// Lifecycle instruments (created by caller, passed in)
// ══════════════════════════════════════════════════════════════════════

export type LifecycleInstruments = {
  // gen_ai standard metrics
  tokenUsage: Histogram;
  operationDuration: Histogram;
  // Custom lifecycle metrics
  sessionsStartedTotal: Counter;
  sessionsCompleted: Counter;
  sessionDurationMs: Histogram;
  compactionsTotal: Counter;
  compactionMessagesRemoved: Histogram;
  subagentsSpawnedTotal: Counter;
  subagentOutcomesTotal: Counter;
  subagentDurationMs: Histogram;
  messageDeliveryTotal: Counter;
  // SRE tool + cost metrics
  toolCallsTotal: Counter;
  toolDurationMs: Histogram;
  costByModel: Counter;
  // Message type tracking
  sessionMessageTypes: Counter;
  // Security metrics
  gatewayRestarts: Counter;
  sessionResets: Counter;
  toolErrorClasses: Counter;
  promptInjectionSignals: Counter;
};

// ══════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════

export type LifecycleTelemetry = {
  onSessionStart(event: SessionStartEvent, ctx: SessionStartCtx): void;
  onSessionEnd(event: SessionEndEvent, ctx: SessionEndCtx): void;
  onLlmInput(event: LlmInputEvent, ctx: LlmInputCtx): void;
  onLlmOutput(event: LlmOutputEvent, ctx: LlmOutputCtx): void;
  onAgentEnd(event: AgentEndEvent, ctx: AgentEndCtx): void;
  onMessageReceived(event: MessageReceivedEvent, ctx: MessageReceivedCtx): void;
  onMessageSent(event: MessageSentEvent, ctx: MessageSentCtx): void;
  onBeforeCompaction(event: BeforeCompactionEvent, ctx: BeforeCompactionCtx): void;
  onAfterCompaction(event: AfterCompactionEvent, ctx: AfterCompactionCtx): void;
  onSubagentSpawned(event: SubagentSpawnedEvent, ctx: SubagentSpawnedCtx): void;
  onSubagentEnded(event: SubagentEndedEvent, ctx: SubagentEndedCtx): void;
  onAfterToolCall(event: AfterToolCallEvent, ctx: AfterToolCallCtx): void;

  // New hooks (Part 5)
  onBeforeReset(event: BeforeResetEvent, ctx: BeforeResetCtx): void;
  onBeforeToolCall(event: BeforeToolCallEvent, ctx: BeforeToolCallCtx): void;
  onGatewayStart(event: GatewayStartEvent): void;
  onGatewayStop(event: GatewayStopEvent): void;

  /** Get session trace context for parenting external spans (e.g., tool calls) */
  getSessionContext(sessionKey: string): { span: Span; ctx: Context } | undefined;

  /** Get session trace context by sessionId or sessionKey (for cross-pipeline correlation) */
  getSessionContextByAny(sessionId?: string, sessionKey?: string): { span: Span; ctx: Context } | undefined;

  /** Get rolling average LLM latency in ms (for ObservableGauge in metrics-collector) */
  getAvgLatencyMs(): number;

  /** Get unique session count in the last 1h (for security ObservableGauge) */
  getUniqueSessionCount1h(): number;

  /** Flush all pending logs and traces to the backend (call after critical events) */
  flushAll(): Promise<void>;

  /** Clean up all state (call on service stop) */
  destroy(): void;
};

// ══════════════════════════════════════════════════════════════════════
// Helpers: extract gen_ai fields from lastAssistant (AssistantMessage)
// Defensive narrowing — lastAssistant comes from pi-ai via hook events
// ══════════════════════════════════════════════════════════════════════

/** Extract the actual response model from lastAssistant (may differ from request model) */
export function extractResponseModel(lastAssistant: unknown): string | undefined {
  if (
    lastAssistant &&
    typeof lastAssistant === "object" &&
    "model" in lastAssistant &&
    typeof (lastAssistant as { model: unknown }).model === "string"
  ) {
    return (lastAssistant as { model: string }).model;
  }
  return undefined;
}

/** Map pi-ai stopReason to gen_ai finish_reason values */
const STOP_REASON_MAP: Record<string, string> = {
  stop: "stop",
  length: "max_tokens",
  toolUse: "tool_calls",
  error: "error",
  aborted: "stop",
};

export function extractFinishReason(lastAssistant: unknown): string | undefined {
  if (
    lastAssistant &&
    typeof lastAssistant === "object" &&
    "stopReason" in lastAssistant &&
    typeof (lastAssistant as { stopReason: unknown }).stopReason === "string"
  ) {
    return STOP_REASON_MAP[(lastAssistant as { stopReason: string }).stopReason];
  }
  return undefined;
}

// gen_ai tool descriptions — hardcoded for our 14 tools, empty for external tools
const TOOL_DESCRIPTIONS: Record<string, string> = {
  grafana_create_dashboard: "Create dashboard from template or custom JSON spec",
  grafana_update_dashboard: "Add, remove, or update panels on an existing dashboard",
  grafana_query: "Run PromQL instant/range queries against Prometheus datasources",
  grafana_query_logs: "Run LogQL queries against Loki datasources",
  grafana_create_alert: "Create Grafana-native alert rules with PromQL conditions",
  grafana_share_dashboard: "Render panels as PNG and deliver to messaging channels",
  grafana_annotate: "Create or query annotations on dashboards",
  grafana_explore_datasources: "Discover datasources configured in Grafana",
  grafana_list_metrics: "Discover available metrics from Prometheus datasources",
  grafana_search: "Search existing dashboards by title or tag",
  grafana_get_dashboard: "Get compact dashboard summary with panels and queries",
  grafana_check_alerts: "Check, acknowledge, or set up alert webhook notifications",
  grafana_push_metrics: "Push custom data via OTLP for external data observatory",
  grafana_explain_metric: "Get metric context: current value, trend, stats, metadata",
  grafana_security_check: "Run comprehensive security health check with threat-level assessment",
};

/** Truncate a string to maxLen characters, appending "..." if truncated */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

/** Truncate for span names: uses "…" (single char) to save space in Tempo waterfall */
function truncateForSpanName(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

// Approximate pricing weights (relative cost per million tokens)
// Used for cost attribution when exact per-type costs aren't available
const TOKEN_COST_WEIGHTS = {
  input: 15,        // $15/MTok
  output: 75,       // $75/MTok
  cacheRead: 1.5,   // $1.5/MTok
  cacheWrite: 18.75, // $18.75/MTok
};

/** Compute p95 from an array of numeric values */
function computeP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

// Safety: force-close sessions older than 24h to prevent memory leaks
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Max entries in per-session latency reservoir (for P95 computation)
const LATENCY_RESERVOIR_SIZE = 200;

// Max entries in global rolling latency window (for getAvgLatencyMs gauge)
const LATENCY_WINDOW_SIZE = 100;

// Cost thresholds for SRE severity intelligence (Part 6)
const COST_THRESHOLDS = [1, 5, 10];

export type LifecycleTelemetryOpts = {
  agentVersion?: string;
  captureContent?: boolean;
  contentMaxLength?: number;
  redactSecrets?: boolean;
  /** Estimate cost from provider/model/usage — replaces accumulateCost from diagnostic events */
  costEstimator?: (provider?: string, model?: string, usage?: {
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
  }) => number | undefined;
};

export function createLifecycleTelemetry(
  traces: OtelTraces,
  logs: OtelLogs,
  instruments: LifecycleInstruments,
  opts?: LifecycleTelemetryOpts,
): LifecycleTelemetry {
  const { tracer } = traces;

  // Resolved config options with defaults
  const captureContent = opts?.captureContent !== false;
  const contentMaxLen = opts?.contentMaxLength ?? 2000;
  const shouldRedact = opts?.redactSecrets !== false;
  const costEstimator = opts?.costEstimator;

  /** Prepare content for capture: truncate + optionally redact */
  function prepareContent(text: string): string {
    let result = text;
    if (shouldRedact) result = redactSecrets(result);
    return truncate(result, contentMaxLen);
  }

  // ── Security: prompt injection detection patterns ────────────────────
  // Copied from openclaw's external-content.ts (src/security/external-content.ts).
  // Local copy avoids runtime dependency on an internal module.
  // Detection-only — never blocks; only increments a counter for human review.
  const SUSPICIOUS_PATTERNS: RegExp[] = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|context)/i,
    /disregard\s+(all\s+)?(previous|prior|above)/i,
    /forget\s+(everything|all|your)\s+(previous|prior|above)/i,
    /you\s+are\s+now\s+(a|an|my)\s+/i,
    /new\s+instructions?:\s*/i,
    /system\s*:\s*you\s+are/i,
    /\[SYSTEM\]/i,
    /\<\|?(im_start|system|endoftext)\|?\>/i,
    /```\s*(system|prompt|injection)/i,
    /act\s+as\s+(a|an|if)\s+/i,
    /pretend\s+(you\s+are|to\s+be)\s+/i,
    /override\s+(your|the|all)\s+(instructions|rules|guidelines)/i,
  ];

  /** Broad error categories for security monitoring (tool_error_classes metric label). */
  type ErrorClass = "network" | "filesystem" | "timeout" | "other";

  /** Classify tool errors into broad categories for security monitoring. */
  function classifyToolError(error: string): ErrorClass {
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch.*fail/i.test(error)) return "network";
    if (/ENOENT|EACCES|path|directory|traversal/i.test(error)) return "filesystem";
    if (/timeout|timed?\s*out/i.test(error)) return "timeout";
    return "other";
  }

  // ── Security: unique sessions sliding window (1h) ──────────────────
  const uniqueSessionMap = new Map<string, number>(); // sessionId → latest timestamp
  const UNIQUE_SESSION_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  function evictStaleSessions(): void {
    const cutoff = Date.now() - UNIQUE_SESSION_WINDOW_MS;
    for (const [id, ts] of uniqueSessionMap) {
      if (ts < cutoff) uniqueSessionMap.delete(id);
    }
  }

  function trackUniqueSession(sessionId: string): void {
    uniqueSessionMap.set(sessionId, Date.now());
    evictStaleSessions();
  }

  function getUniqueSessionCount(): number {
    return uniqueSessionMap.size;
  }

  // State maps for span correlation
  const activeSessions = new Map<string, SessionTraceState>();
  const activeLlmCalls = new Map<string, LlmCallState>();
  const sessionKeyToId = new Map<string, string>();
  const activeCompactions = new Map<string, Span>();

  // LIFO stacks: handles concurrent same-name tool calls correctly
  // (e.g., two concurrent grafana_query calls with key ":grafana_query")
  type ToolCallEntry = { span: Span; toolName: string; startTime: number; resolvedSessionId?: string };
  const activeToolCalls = new Map<string, ToolCallEntry[]>();

  // ── Parent-child subagent tracking ──────────────────────────────────
  // Bridges the timing gap between subagent_spawned (knows childSessionKey)
  // and the child's first llm_input (knows both sessionKey and sessionId).
  type PendingChildInfo = {
    parentSessionId: string;
    parentSessionKey: string;
    parentTraceId: string;
    parentSpanId: string;
    agentId: string;
    label: string;
    mode: string;
    spawnTime: number;
  };
  const pendingChildren = new Map<string, PendingChildInfo>();       // childSessionKey → parent info
  const activeSubagentSpawns = new Map<string, { span: Span; mode: string; startTime: number }>();  // childSessionKey → spawn span + metadata
  const parentToChildren = new Map<string, Set<string>>();           // parentSessionId → Set<childSessionId>
  const childToParent = new Map<string, string>();                   // childSessionId → parentSessionId

  // Sliding window for global rolling average latency (getAvgLatencyMs gauge)
  const latencyWindow: number[] = [];

  // Safety cleanup interval
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of activeSessions) {
      if (now - session.startTime > SESSION_MAX_AGE_MS) {
        session.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: "session timed out (24h safety limit)" });
        session.rootSpan.end(now);
        activeSessions.delete(id);
        // Clean up reverse map
        for (const [key, sid] of sessionKeyToId) {
          if (sid === id) sessionKeyToId.delete(key);
        }
      }
    }
    // Clean finalized sessions (deferred from finalizeSession to allow late-arriving hooks)
    for (const [id, session] of activeSessions) {
      if (!session.finalized) continue;

      // Safety: emit deferred summary before deleting (if LLM call never resolved)
      if (session.pendingSummary && !session.summaryEmitted) {
        const durationMs = session.finalDurationMs ?? (now - session.startTime);
        emitSessionSummary(session, durationMs, "final", session.rootSpan);
        session.summaryEmitted = true;
      }

      activeSessions.delete(id);
      for (const [key, sid] of sessionKeyToId) {
        if (sid === id) sessionKeyToId.delete(key);
      }

      // Clean parent-child maps (prevents unbounded growth)
      const parentId = childToParent.get(id);
      if (parentId) {
        parentToChildren.get(parentId)?.delete(id);
        if (parentToChildren.get(parentId)?.size === 0) parentToChildren.delete(parentId);
        childToParent.delete(id);
      }
      const children = parentToChildren.get(id);
      if (children) {
        for (const childId of children) childToParent.delete(childId);
        parentToChildren.delete(id);
      }
    }
    // Clean stale pending children (subagent spawned but never linked)
    for (const [key, info] of pendingChildren) {
      if (now - info.spawnTime > SESSION_MAX_AGE_MS) {
        pendingChildren.delete(key);
        // End orphaned spawn span if still open
        const orphanEntry = activeSubagentSpawns.get(key);
        if (orphanEntry) {
          orphanEntry.span.setStatus({ code: SpanStatusCode.ERROR, message: "subagent spawn timed out (24h safety limit)" });
          orphanEntry.span.end(now);
          activeSubagentSpawns.delete(key);
        }
      }
    }
    // Clean stale tool call spans (before_tool_call without after_tool_call for >5min)
    for (const [key, stack] of activeToolCalls) {
      const filtered = stack.filter(entry => now - entry.startTime < 5 * 60_000);
      // End orphaned spans before removing
      for (const entry of stack) {
        if (now - entry.startTime >= 5 * 60_000) {
          entry.span.setAttribute("openclaw.stale_cleanup", true);
          entry.span.setStatus({ code: SpanStatusCode.ERROR, message: "tool call timed out (5min)" });
          entry.span.end(now);
        }
      }
      if (filtered.length > 0) activeToolCalls.set(key, filtered);
      else activeToolCalls.delete(key);
    }
  }, 60_000);
  if (cleanupInterval.unref) cleanupInterval.unref();

  // ── Helper: build child summary attributes for session summary logs ──

  function childSummaryAttrs(sessionId: string): Record<string, string | number | boolean> {
    const childIds = parentToChildren.get(sessionId);
    if (!childIds?.size) return {};
    return {
      "openclaw.child_session_ids": [...childIds].join(","),
      "openclaw.child_count": childIds.size,
      "openclaw.has_children": true,
    };
  }

  // ── Helper: emit correlated log record ──────────────────────────────

  function emitLog(
    severity: number,
    severityText: string,
    body: string,
    attributes: Record<string, string | number | boolean>,
    span?: Span,
  ): void {
    // Component label for Loki filtering: {service_name="openclaw"} | component="lifecycle"
    attributes["component"] = "lifecycle";
    if (span) {
      // Keep string attrs for LogQL filtering: `| trace_id = "abc"`
      attributes["trace_id"] = span.spanContext().traceId;
      attributes["span_id"] = span.spanContext().spanId;
    }
    // Flatten dotted keys → underscores for Loki structured metadata compatibility
    const flat = flattenLogKeys(attributes);
    logs.logger.emit({
      severityNumber: severity,
      severityText,
      body: shouldRedact ? redactSecrets(body) : body,
      attributes: flat,
      // Also pass OTel Context → SDK populates proto-level LogRecord.TraceId/SpanId
      // This is the canonical OTLP way; Loki stores it in structured metadata
      ...(span ? { context: trace.setSpan(ROOT_CONTEXT, span) } : {}),
    });
  }

  // ── Helper: resolve session context by sessionId or sessionKey ──────

  function resolveSessionCtx(sessionId?: string, sessionKey?: string): SessionTraceState | undefined {
    if (sessionId) {
      const direct = activeSessions.get(sessionId);
      if (direct) return direct;
    }
    if (sessionKey) {
      const id = sessionKeyToId.get(sessionKey);
      if (id) return activeSessions.get(id);
      // Fallback: sessionKey might be a sessionId itself
      const direct = activeSessions.get(sessionKey);
      if (direct) return direct;
    }
    return undefined;
  }

  // ── Helper: resolve parent context for a span ───────────────────────

  function resolveParentCtx(sessionId?: string, sessionKey?: string): Context {
    const session = resolveSessionCtx(sessionId, sessionKey);
    return session?.ctx ?? ROOT_CONTEXT;
  }

  // ── Helper: resolve session IDs for consistent log attributes ──────

  function resolveSessionIds(sessionId?: string, sessionKey?: string): Record<string, string> {
    const session = resolveSessionCtx(sessionId, sessionKey);
    return {
      "openclaw.session_id": session?.sessionId ?? sessionId ?? "",
      "openclaw.session_key": session?.sessionKey ?? sessionKey ?? "",
    };
  }

  // ── Helper: resolve child session ID from a session key ──────────────

  function resolveChildSessionId(childSessionKey: string): string | undefined {
    const childSessionId = sessionKeyToId.get(childSessionKey);
    if (childSessionId) return childSessionId;
    // Check if the sessionKey is itself a sessionId
    if (activeSessions.has(childSessionKey)) return childSessionKey;
    return undefined;
  }

  // ── Fallback: pick the best active session when sessionKey is missing ──
  // This handles the case where openclaw's hook system does NOT pass
  // sessionKey/agentId in the tool call hook context for plugin-registered
  // tools (confirmed in pi-tool-definition-adapter.ts).
  // If 1 active session → return it (CLI / single-user case).
  // If multiple → pick the one with the most recent LLM activity.
  function resolveAnyActiveSession(): SessionTraceState | undefined {
    if (activeSessions.size === 0) return undefined;
    if (activeSessions.size === 1) return activeSessions.values().next().value;

    // Multiple sessions: pick the one most likely to be executing tools right now.
    // Heuristic: session with the most accumulated LLM latency (= most active).
    let best: SessionTraceState | undefined;
    let bestLatencySum = -1;
    for (const session of activeSessions.values()) {
      if (session.latencySum > bestLatencySum) {
        bestLatencySum = session.latencySum;
        best = session;
      }
    }
    return best;
  }

  // ── Helper: compute all derived session statistics (single source of truth) ──

  type SessionStats = {
    latencyCount: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    minLatencyMs: number;
    maxLatencyMs: number;
    totalToolCalls: number;
    uniqueToolCount: number;
    topTools: string;
    totalTokens: number;
    totalMessages: number;
    activeDurationMs: number;
    costInput: number;
    costOutput: number;
    costCacheRead: number;
    costCacheWrite: number;
    cacheHitRatio: number;
    cacheSavingsUsd: number;
  };

  function computeSessionStats(session: SessionTraceState): SessionStats {
    const latencyCount = session.latencyCount;
    const avgLatencyMs = latencyCount > 0 ? session.latencySum / latencyCount : 0;
    const p95LatencyMs = computeP95(session.latencies);
    const minLatencyMs = latencyCount > 0 ? session.latencyMin : 0;
    const maxLatencyMs = latencyCount > 0 ? session.latencyMax : 0;

    const totalToolCalls = [...session.toolCounts.values()].reduce((a, b) => a + b, 0);
    const uniqueToolCount = session.toolCounts.size;
    const topTools = [...session.toolCounts.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name).join(",");

    const totalTokens = session.totalInputTokens + session.totalOutputTokens +
      session.totalCacheReadTokens + session.totalCacheWriteTokens;

    const totalMessages = session.messageCountUser + session.messageCountAssistant +
      session.messageCountToolCalls + session.messageCountToolResults +
      session.messageCountErrors;

    const activeDurationMs = session.latencySum + session.totalToolDurationMs;

    const W = TOKEN_COST_WEIGHTS;
    const weightedSum = (session.totalInputTokens * W.input) +
      (session.totalOutputTokens * W.output) +
      (session.totalCacheReadTokens * W.cacheRead) +
      (session.totalCacheWriteTokens * W.cacheWrite);

    const costInput = weightedSum > 0
      ? (session.totalInputTokens * W.input / weightedSum) * session.totalCostUsd : 0;
    const costOutput = weightedSum > 0
      ? (session.totalOutputTokens * W.output / weightedSum) * session.totalCostUsd : 0;
    const costCacheRead = weightedSum > 0
      ? (session.totalCacheReadTokens * W.cacheRead / weightedSum) * session.totalCostUsd : 0;
    const costCacheWrite = weightedSum > 0
      ? (session.totalCacheWriteTokens * W.cacheWrite / weightedSum) * session.totalCostUsd : 0;

    const cacheInputTotal = session.totalInputTokens + session.totalCacheReadTokens;
    const cacheHitRatio = cacheInputTotal > 0
      ? session.totalCacheReadTokens / cacheInputTotal : 0;
    const cacheSavingsUsd = session.totalCacheReadTokens *
      (W.input - W.cacheRead) / 1_000_000;

    return {
      latencyCount, avgLatencyMs, p95LatencyMs, minLatencyMs, maxLatencyMs,
      totalToolCalls, uniqueToolCount, topTools, totalTokens, totalMessages,
      activeDurationMs, costInput, costOutput, costCacheRead, costCacheWrite,
      cacheHitRatio, cacheSavingsUsd,
    };
  }

  // ── Helper: emit session usage summary log (reusable for interim + final) ──

  function emitSessionSummary(
    session: SessionTraceState,
    durationMs: number,
    summaryType: "final" | "interim",
    span?: Span,
  ): void {
    const s = computeSessionStats(session);

    const costStr = session.totalCostUsd > 0 ? `$${session.totalCostUsd.toFixed(2)}` : "$0";
    const typeTag = summaryType === "interim" ? " (interim)" : "";
    const summaryBody = `Session ${session.sessionId}${typeTag} | ${durationMs}ms (active: ${Math.round(s.activeDurationMs)}ms) | ${s.totalMessages} msgs (${session.messageCountUser} user, ${session.messageCountAssistant} assistant, ${session.messageCountToolCalls} tool) | ${costStr} | ${s.totalTokens.toLocaleString()}tok`;

    emitLog(SeverityNumber.INFO, "INFO", summaryBody, {
      "event.domain": "openclaw",
      "event.name": "usage.session_summary",
      "openclaw.summary.type": summaryType,
      // Session identity
      "openclaw.session_id": session.sessionId,
      "openclaw.session_key": session.sessionKey,
      "openclaw.agent_id": session.agentId,
      // Duration
      "openclaw.duration_ms": durationMs,
      "openclaw.active_duration_ms": Math.round(s.activeDurationMs),
      // Message type breakdown
      "openclaw.messages.total": s.totalMessages,
      "openclaw.messages.user": session.messageCountUser,
      "openclaw.messages.assistant": session.messageCountAssistant,
      "openclaw.messages.tool_calls": session.messageCountToolCalls,
      "openclaw.messages.tool_results": session.messageCountToolResults,
      "openclaw.messages.errors": session.messageCountErrors,
      // Tool usage
      "openclaw.tools.total_calls": s.totalToolCalls,
      "openclaw.tools.unique_count": s.uniqueToolCount,
      "openclaw.tools.top": s.topTools,
      // Latency distribution
      "openclaw.latency.count": s.latencyCount,
      "openclaw.latency.avg_ms": Math.round(s.avgLatencyMs),
      "openclaw.latency.p95_ms": Math.round(s.p95LatencyMs),
      "openclaw.latency.min_ms": Math.round(s.minLatencyMs),
      "openclaw.latency.max_ms": Math.round(s.maxLatencyMs),
      // Token totals
      "openclaw.tokens.input": session.totalInputTokens,
      "openclaw.tokens.output": session.totalOutputTokens,
      "openclaw.tokens.cache_read": session.totalCacheReadTokens,
      "openclaw.tokens.cache_write": session.totalCacheWriteTokens,
      "openclaw.tokens.total": s.totalTokens,
      // Cost
      "openclaw.cost.total": Number(session.totalCostUsd.toFixed(4)),
      "openclaw.cost.input": Number(s.costInput.toFixed(4)),
      "openclaw.cost.output": Number(s.costOutput.toFixed(4)),
      "openclaw.cost.cache_read": Number(s.costCacheRead.toFixed(4)),
      "openclaw.cost.cache_write": Number(s.costCacheWrite.toFixed(4)),
      // Cache efficiency
      "openclaw.cache.hit_ratio": Number(s.cacheHitRatio.toFixed(4)),
      "openclaw.cache.savings_usd": Number(s.cacheSavingsUsd.toFixed(4)),
      // Model + channel
      "gen_ai.provider.name": session.primaryProvider,
      "gen_ai.request.model": session.primaryModel,
      ...(session.channel ? { "openclaw.channel": session.channel } as Record<string, string | number | boolean> : {}),
      // Subagent hierarchy attributes
      ...(session.isSubagent && session.parentSessionId ? {
        "openclaw.is_subagent": true,
        "openclaw.parent_session_id": session.parentSessionId,
      } as Record<string, string | number | boolean> : {}),
      ...childSummaryAttrs(session.sessionId),
    }, span ?? session.rootSpan);
  }

  // ── Helper: finalize a session (close root span, emit FINAL, cleanup) ──
  // Idempotent: checks session.finalized flag. Called by onAgentEnd (primary)
  // and onSessionEnd (fallback).

  function finalizeSession(session: SessionTraceState, durationMs: number, errorMsg?: string, deferSummary = false): void {
    if (session.finalized) return;
    session.finalized = true;

    const now = Date.now();
    const s = computeSessionStats(session);

    // ── Enrich session root span with summary ────────────────────
    {
      const costTag = session.totalCostUsd > 0 ? ` $${session.totalCostUsd.toFixed(2)}` : "";
      const toolTag = s.totalToolCalls > 0 ? ` ${s.totalToolCalls} tools` : "";
      const modelTag = session.primaryModel ? ` [${session.primaryModel}]` : "";
      session.rootSpan.updateName(
        `invoke_agent openclaw [${session.sessionId}]${modelTag} ${s.totalMessages} msgs${toolTag}${costTag}`,
      );
    }

    // ── Enrich session root span with 20+ attributes ────────────
    session.rootSpan.setAttributes({
      "openclaw.session.duration_ms": durationMs,
      "openclaw.session.active_duration_ms": Math.round(s.activeDurationMs),
      "openclaw.session.cost_usd": session.totalCostUsd,
      "openclaw.session.total_input_tokens": session.totalInputTokens,
      "openclaw.session.total_output_tokens": session.totalOutputTokens,
      "openclaw.session.total_cache_read_tokens": session.totalCacheReadTokens,
      "openclaw.session.total_cache_write_tokens": session.totalCacheWriteTokens,
      "openclaw.session.messages.user": session.messageCountUser,
      "openclaw.session.messages.assistant": session.messageCountAssistant,
      "openclaw.session.messages.tool_calls": session.messageCountToolCalls,
      "openclaw.session.messages.tool_results": session.messageCountToolResults,
      "openclaw.session.messages.errors": session.messageCountErrors,
      "openclaw.session.latency.avg_ms": Math.round(s.avgLatencyMs),
      "openclaw.session.latency.p95_ms": Math.round(s.p95LatencyMs),
      "openclaw.session.latency.min_ms": Math.round(s.minLatencyMs),
      "openclaw.session.latency.max_ms": Math.round(s.maxLatencyMs),
      "openclaw.session.tools.unique_count": s.uniqueToolCount,
      "openclaw.session.tools.total_calls": s.totalToolCalls,
      "openclaw.session.tools.top": s.topTools,
      "openclaw.session.cost.input": Number(s.costInput.toFixed(4)),
      "openclaw.session.cost.output": Number(s.costOutput.toFixed(4)),
      "openclaw.session.cost.cache_read": Number(s.costCacheRead.toFixed(4)),
      "openclaw.session.cost.cache_write": Number(s.costCacheWrite.toFixed(4)),
      "openclaw.session.cache_hit_ratio": Number(s.cacheHitRatio.toFixed(4)),
      "openclaw.session.cache_savings_usd": Number(s.cacheSavingsUsd.toFixed(4)),
      "gen_ai.agent.name": "openclaw",
      "gen_ai.agent.id": session.agentId,
      "gen_ai.conversation.id": session.sessionId,
      "gen_ai.provider.name": session.primaryProvider,
      "gen_ai.request.model": session.primaryModel,
    });

    if (errorMsg) {
      session.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
    } else {
      session.rootSpan.setStatus({ code: SpanStatusCode.OK });
    }
    session.rootSpan.end(now);

    // Record session duration + completion outcome metrics
    instruments.sessionDurationMs.record(durationMs);
    instruments.sessionsCompleted.add(1, { outcome: errorMsg ? "error" : "success" });

    // Emit or defer final session usage summary
    if (deferSummary) {
      // LLM calls still in-flight — defer summary until last one resolves
      session.pendingSummary = true;
      session.finalDurationMs = durationMs;
    } else {
      // No pending LLM calls — emit immediately
      emitSessionSummary(session, durationMs, "final", session.rootSpan);
      session.summaryEmitted = true;
    }

    // NOTE: Do NOT delete from activeSessions/sessionKeyToId here.
    // Late-arriving hooks (e.g. llm_output after agent_end) still need to
    // resolve the session to accumulate tokens. The 60s cleanup timer
    // handles map cleanup for finalized sessions.
  }

  return {
    // ── session_start → root span ───────────────────────────────────

    onSessionStart(event, ctx) {
      // Guard: if session already exists, skip (prevents orphaned root spans in Tempo)
      if (activeSessions.has(event.sessionId)) return;

      const now = Date.now();
      const rootSpan = tracer.startSpan(`invoke_agent openclaw [${event.sessionId}]`, {
        kind: SpanKind.INTERNAL,
        startTime: now,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.provider.name": "openclaw",
          "gen_ai.agent.name": "openclaw",
          "gen_ai.agent.id": "grafana-lens",
          "gen_ai.output.type": "text",
          "gen_ai.conversation.id": event.sessionId,
          ...(opts?.agentVersion ? { "gen_ai.agent.version": opts.agentVersion } : {}),
          ...(event.resumedFrom ? { "openclaw.session.resumed_from": event.resumedFrom } : {}),
        },
      });

      const sessionCtx = trace.setSpan(ROOT_CONTEXT, rootSpan);

      activeSessions.set(event.sessionId, {
        rootSpan,
        ctx: sessionCtx,
        sessionId: event.sessionId,
        startTime: now,
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        messageCountUser: 0,
        messageCountAssistant: 0,
        messageCountToolCalls: 0,
        messageCountToolResults: 0,
        messageCountErrors: 0,
        toolCounts: new Map(),
        toolErrorCounts: new Map(),
        totalToolDurationMs: 0,
        latencies: [],
        latencySum: 0,
        latencyMin: Infinity,
        latencyMax: 0,
        latencyCount: 0,
        primaryModel: "",
        primaryProvider: "",
        channel: "",
        sessionKey: "",
        agentId: ctx.agentId ?? "",
        costThresholdsLogged: new Set(),
        firstMessageCaptured: false,
        finalized: false,
        isSubagent: false,
        parentLinked: false,
      });

      // Map agentId as a sessionKey alias if available
      if (ctx.agentId) {
        sessionKeyToId.set(ctx.agentId, event.sessionId);
      }

      instruments.sessionsStartedTotal.add(1, {
        type: event.resumedFrom ? "resumed" : "new",
      });

      // Security: track unique sessions for enumeration detection
      trackUniqueSession(event.sessionId);

      const resumedTag = event.resumedFrom ? " (resumed)" : "";
      const agentTag = ctx.agentId ? ` [agent:${ctx.agentId}]` : "";
      emitLog(SeverityNumber.INFO, "INFO", `Session started ${event.sessionId}${resumedTag}${agentTag}`, {
        "event.domain": "openclaw",
        "event.name": "session.start",
        "openclaw.session_id": event.sessionId,
        ...(event.resumedFrom ? { "openclaw.resumed_from": event.resumedFrom } : {}),
      }, rootSpan);
    },

    // ── session_end → close root span ─────────────────────────────────

    onSessionEnd(event) {
      const session = activeSessions.get(event.sessionId);
      if (!session) return; // graceful: end without start

      if (session.finalized) {
        // Safety: emit deferred summary if LLM call never resolved
        if (session.pendingSummary && !session.summaryEmitted) {
          const durationMs = session.finalDurationMs ?? (Date.now() - session.startTime);
          emitSessionSummary(session, durationMs, "final", session.rootSpan);
          session.summaryEmitted = true;
        }
        return;
      }

      const durationMs = event.durationMs ?? (Date.now() - session.startTime);
      finalizeSession(session, durationMs);
    },

    // ── llm_input → start LLM call span ──────────────────────────────

    onLlmInput(event, ctx) {
      // Lazy session creation: if session_start was missed (fires before service init),
      // create a synthetic root span so all subsequent spans have correct parenting.
      let session = resolveSessionCtx(event.sessionId, ctx.sessionKey);
      if (!session && event.sessionId) {
        const synthNow = Date.now();
        const rootSpan = tracer.startSpan(`invoke_agent openclaw [${event.sessionId}]`, {
          kind: SpanKind.INTERNAL,
          startTime: synthNow,
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.provider.name": "openclaw",
            "gen_ai.agent.name": "openclaw",
            "gen_ai.agent.id": "grafana-lens",
            "gen_ai.output.type": "text",
            "gen_ai.conversation.id": event.sessionId,
            "openclaw.session.synthetic": true,
            ...(opts?.agentVersion ? { "gen_ai.agent.version": opts.agentVersion } : {}),
          },
        });
        const sessionCtx = trace.setSpan(ROOT_CONTEXT, rootSpan);
        activeSessions.set(event.sessionId, {
          rootSpan,
          ctx: sessionCtx,
          sessionId: event.sessionId,
          startTime: synthNow,
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          messageCountUser: 0,
          messageCountAssistant: 0,
          messageCountToolCalls: 0,
          messageCountToolResults: 0,
          messageCountErrors: 0,
          toolCounts: new Map(),
          toolErrorCounts: new Map(),
          totalToolDurationMs: 0,
          latencies: [],
          latencySum: 0,
          latencyMin: Infinity,
          latencyMax: 0,
          latencyCount: 0,
          primaryModel: "",
          primaryProvider: "",
          channel: "",
          sessionKey: ctx.sessionKey ?? "",
          agentId: "",
          costThresholdsLogged: new Set(),
          firstMessageCaptured: false,
          finalized: false,
          isSubagent: false,
          parentLinked: false,
        });
        if (ctx.sessionKey) sessionKeyToId.set(ctx.sessionKey, event.sessionId);

        session = activeSessions.get(event.sessionId);

        instruments.sessionsStartedTotal.add(1, { type: "synthetic" });
        trackUniqueSession(event.sessionId);
        emitLog(SeverityNumber.INFO, "INFO",
          `Session started ${event.sessionId} (synthetic)`, {
            "event.domain": "openclaw",
            "event.name": "session.start",
            "openclaw.session_id": event.sessionId,
            "openclaw.session_key": ctx.sessionKey ?? "",
            "openclaw.synthetic": true,
          }, rootSpan);
      }

      const parentCtx = session?.ctx ?? ROOT_CONTEXT;
      const now = Date.now();

      const llmSpan = tracer.startSpan(`chat ${event.model}`, {
        kind: SpanKind.CLIENT,
        startTime: now,
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": event.provider,
          "gen_ai.request.model": event.model,
          "gen_ai.conversation.id": event.sessionId,
          "openclaw.run_id": event.runId,
          "openclaw.session_key": ctx.sessionKey ?? "",
          "openclaw.history_length": event.historyMessages.length,
          "openclaw.images_count": event.imagesCount,
        },
      }, parentCtx);

      const llmCtx = trace.setSpan(ROOT_CONTEXT, llmSpan);

      activeLlmCalls.set(event.runId, {
        span: llmSpan,
        ctx: llmCtx,
        sessionKey: ctx.sessionKey ?? "",
        startTime: now,
      });

      // Map sessionKey → sessionId for tool call parenting
      if (ctx.sessionKey && event.sessionId) {
        sessionKeyToId.set(ctx.sessionKey, event.sessionId);
      }

      // ── Deferred subagent linking ──────────────────────────────────
      // First hook where ctx.sessionKey is available for a child agent.
      // Match against pendingChildren to establish parent↔child correlation.
      if (ctx.sessionKey && session && !session.parentLinked) {
        const parentInfo = pendingChildren.get(ctx.sessionKey);
        if (parentInfo) {
          session.parentLinked = true;
          session.parentSessionId = parentInfo.parentSessionId;
          session.parentTraceId = parentInfo.parentTraceId;
          session.isSubagent = true;

          // Enrich child root span with parent info (retroactive)
          session.rootSpan.setAttributes({
            "gen_ai.conversation.parent_id": parentInfo.parentSessionId,
            "openclaw.parent_session_id": parentInfo.parentSessionId,
            "openclaw.parent_session_key": parentInfo.parentSessionKey,
            "openclaw.parent_trace_id": parentInfo.parentTraceId,
            "openclaw.is_subagent": true,
            "openclaw.subagent.agent_id": parentInfo.agentId,
            "openclaw.subagent.label": parentInfo.label,
            "openclaw.subagent.mode": parentInfo.mode,
          });

          // Span link: child root → parent spawn span (cross-trace)
          session.rootSpan.addLink?.({
            context: {
              traceId: parentInfo.parentTraceId,
              spanId: parentInfo.parentSpanId,
              traceFlags: TraceFlags.SAMPLED,
            },
            attributes: { "openclaw.link.type": "parent_agent" },
          });

          // Span link: parent spawn span → child root (bidirectional)
          const spawnEntry = activeSubagentSpawns.get(ctx.sessionKey);
          if (spawnEntry) {
            spawnEntry.span.addLink?.({
              context: session.rootSpan.spanContext(),
              attributes: {
                "openclaw.link.type": "child_agent",
                "openclaw.child_session_id": session.sessionId,
              },
            });
            spawnEntry.span.setAttribute("openclaw.subagent.child_trace_id",
              session.rootSpan.spanContext().traceId);
            spawnEntry.span.setAttribute("openclaw.subagent.child_session_id",
              session.sessionId);
          }

          // Update relationship maps
          const childSet = parentToChildren.get(parentInfo.parentSessionId) ?? new Set<string>();
          childSet.add(session.sessionId);
          parentToChildren.set(parentInfo.parentSessionId, childSet);
          childToParent.set(session.sessionId, parentInfo.parentSessionId);

          pendingChildren.delete(ctx.sessionKey);

          emitLog(SeverityNumber.INFO, "INFO",
            `Subagent linked: ${session.sessionId} → parent ${parentInfo.parentSessionId}`, {
              "event.domain": "openclaw",
              "event.name": "subagent.linked",
              "openclaw.session_id": session.sessionId,
              "openclaw.parent_session_id": parentInfo.parentSessionId,
              "openclaw.parent_trace_id": parentInfo.parentTraceId,
              "openclaw.subagent.agent_id": parentInfo.agentId,
            }, session.rootSpan);
        }
      }

      // Count as user message (each LLM input follows a user turn)
      const inputSession = resolveSessionCtx(event.sessionId, ctx.sessionKey);
      if (inputSession) {
        inputSession.messageCountUser++;
        if (ctx.sessionKey) inputSession.sessionKey = ctx.sessionKey;
      }

      const logAttrs: Record<string, string | number | boolean> = {
        "event.domain": "openclaw",
        "event.name": "llm.input",
        "openclaw.run_id": event.runId,
        "openclaw.session_id": event.sessionId,
        "openclaw.session_key": ctx.sessionKey ?? "",
        "openclaw.provider": event.provider,
        "openclaw.model": event.model,
        "openclaw.history_length": event.historyMessages.length,
        "openclaw.images_count": event.imagesCount,
      };

      // Content capture (Part 4A) — gated by captureContent
      if (captureContent) {
        if (event.prompt) logAttrs["gen_ai.prompt"] = prepareContent(event.prompt);
        if (event.systemPrompt) logAttrs["gen_ai.system_prompt"] = prepareContent(event.systemPrompt);

        // Security: scan prompt for injection patterns (detection-only, never blocking)
        if (event.prompt) {
          for (const pattern of SUSPICIOUS_PATTERNS) {
            if (pattern.test(event.prompt)) {
              // Note: also incremented in metrics-collector.ts with detector="tool_loop" (from tool.loop diagnostic event)
              instruments.promptInjectionSignals.add(1, { detector: "input_scan" });
              emitLog(SeverityNumber.WARN, "WARN",
                `Prompt injection pattern detected in user input`,
                {
                  "event.domain": "openclaw",
                  "event.name": "prompt_injection.detected",
                  "openclaw.detector": "input_scan",
                  "openclaw.session_id": event.sessionId,
                  "openclaw.session_key": ctx.sessionKey ?? "",
                  "openclaw.model": event.model,
                }, llmSpan);
              break; // One signal per LLM input — avoid double-counting overlapping patterns
            }
          }
        }
      }

      emitLog(SeverityNumber.INFO, "INFO", `LLM input ${event.provider}/${event.model} | history=${event.historyMessages.length} images=${event.imagesCount}`, logAttrs, llmSpan);
    },

    // ── llm_output → end LLM call span + record metrics ──────────────

    onLlmOutput(event) {
      const call = activeLlmCalls.get(event.runId);
      const now = Date.now();

      if (call) {
        // Set usage attributes on span
        if (event.usage) {
          call.span.setAttributes({
            "gen_ai.usage.input_tokens": event.usage.input ?? 0,
            "gen_ai.usage.output_tokens": event.usage.output ?? 0,
            "gen_ai.usage.cache_creation.input_tokens": event.usage.cacheWrite ?? 0,
            "gen_ai.usage.cache_read.input_tokens": event.usage.cacheRead ?? 0,
          });
        }

        // gen_ai.response.model — actual model served (may differ from request)
        const responseModel = extractResponseModel(event.lastAssistant);
        if (responseModel) {
          call.span.setAttribute("gen_ai.response.model", responseModel);
        }

        // gen_ai.response.finish_reasons — why the model stopped generating
        const finishReason = extractFinishReason(event.lastAssistant);
        if (finishReason) {
          call.span.setAttribute("gen_ai.response.finish_reasons", [finishReason]);
        }

        // gen_ai spec: error.type is conditionally required when operation ends in error
        const isLlmError = finishReason === "error";
        if (isLlmError) {
          call.span.setStatus({ code: SpanStatusCode.ERROR, message: "LLM call ended with error" });
          call.span.setAttribute("error.type", "LlmError");
        } else {
          call.span.setStatus({ code: SpanStatusCode.OK });
        }

        // Resolve session ONCE — used for tokens, cost, latency, and message counts
        const session = resolveSessionCtx(event.sessionId, call.sessionKey);
        if (session) {
          // Always increment assistant message count + track model/provider
          // (even when usage is undefined — the LLM still responded)
          session.messageCountAssistant++;
          if (event.model) session.primaryModel = event.model;
          if (event.provider) session.primaryProvider = event.provider;

          // Accumulate tokens per session for cost attribution
          if (event.usage) {
            session.totalInputTokens += event.usage.input ?? 0;
            session.totalOutputTokens += event.usage.output ?? 0;
            session.totalCacheReadTokens += event.usage.cacheRead ?? 0;
            session.totalCacheWriteTokens += event.usage.cacheWrite ?? 0;
          }

          // Estimate and accumulate cost via costEstimator callback
          if (costEstimator && event.usage) {
            const estimated = costEstimator(event.provider, event.model, event.usage);
            if (estimated !== undefined && estimated > 0) {
              const prevCost = session.totalCostUsd;
              session.totalCostUsd += estimated;
              // SRE cost threshold alerts — log once per threshold per session
              for (const threshold of COST_THRESHOLDS) {
                if (prevCost < threshold && session.totalCostUsd >= threshold && !session.costThresholdsLogged.has(threshold)) {
                  session.costThresholdsLogged.add(threshold);
                  const sev = threshold >= 10 ? SeverityNumber.ERROR
                    : threshold >= 5 ? SeverityNumber.WARN
                    : SeverityNumber.INFO;
                  const sevText = threshold >= 10 ? "ERROR" : threshold >= 5 ? "WARN" : "INFO";
                  const suffix = threshold >= 10 ? " — investigate" : "";
                  emitLog(sev, sevText,
                    `Session cost crossed $${threshold.toFixed(2)}${suffix}`,
                    {
                      "event.domain": "openclaw",
                      "event.name": "cost.threshold",
                      "openclaw.session_id": session.sessionId,
                      "openclaw.session_key": session.sessionKey,
                      "openclaw.cost_usd": session.totalCostUsd,
                      "openclaw.threshold_usd": threshold,
                    }, session.rootSpan);
                }
              }
            }
          }
        }

        // Record latency and update accumulators
        const latencyMs = now - call.startTime;
        {
          if (session) {
            session.latencies.push(latencyMs);
            if (session.latencies.length > LATENCY_RESERVOIR_SIZE) session.latencies.shift();
            session.latencySum += latencyMs;
            session.latencyCount++;
            session.latencyMin = Math.min(session.latencyMin, latencyMs);
            session.latencyMax = Math.max(session.latencyMax, latencyMs);
          }
          latencyWindow.push(latencyMs);
          if (latencyWindow.length > LATENCY_WINDOW_SIZE) latencyWindow.shift();
        }

        // Late arrival handled by deferred summary — no duplicate emission needed here.

        // ── Enrich chat span name with token counts ──
        {
          const inTok = event.usage?.input ?? 0;
          const outTok = event.usage?.output ?? 0;
          call.span.updateName(`chat ${event.model} (${inTok}\u2192${outTok} tok)`);

          // SRE severity: slow LLM detection
          if (latencyMs > 30_000) {
            call.span.setAttribute("sre.severity", "ERROR");
            call.span.setAttribute("sre.reason", `LLM call took ${Math.round(latencyMs / 1000)}s >30s threshold`);
          } else if (latencyMs > 10_000) {
            call.span.setAttribute("sre.severity", "WARN");
            call.span.setAttribute("sre.reason", `LLM call took ${Math.round(latencyMs / 1000)}s >10s threshold`);
          }
        }

        call.span.end(now);

        // Record gen_ai standard metrics
        const attrs = {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": event.provider,
          "gen_ai.request.model": event.model,
        };

        if (event.usage?.input) {
          instruments.tokenUsage.record(event.usage.input, {
            ...attrs,
            "gen_ai.token.type": "input",
          });
        }
        if (event.usage?.output) {
          instruments.tokenUsage.record(event.usage.output, {
            ...attrs,
            "gen_ai.token.type": "output",
          });
        }
        if (event.usage?.cacheRead) {
          instruments.tokenUsage.record(event.usage.cacheRead, {
            ...attrs,
            "gen_ai.token.type": "cache_read_input",
          });
        }
        if (event.usage?.cacheWrite) {
          instruments.tokenUsage.record(event.usage.cacheWrite, {
            ...attrs,
            "gen_ai.token.type": "cache_creation_input",
          });
        }

        // Record assistant message type counter
        instruments.sessionMessageTypes.add(1, { type: "assistant" });

        // operation.duration in seconds (spec requires unit: "s")
        // Include error.type when the LLM call ended in error (gen_ai spec requirement)
        const durationS = (now - call.startTime) / 1000;
        const durationAttrs = isLlmError ? { ...attrs, "error.type": "LlmError" } : attrs;
        instruments.operationDuration.record(durationS, durationAttrs);

        const totalTok = (event.usage?.input ?? 0) + (event.usage?.output ?? 0);

        // SRE severity intelligence — slow LLM detection (Part 6A)
        let severity = SeverityNumber.INFO;
        let severityText = "INFO";
        if (latencyMs > 30_000) {
          severity = SeverityNumber.ERROR;
          severityText = "ERROR";
        } else if (latencyMs > 10_000) {
          severity = SeverityNumber.WARN;
          severityText = "WARN";
        }
        const slowTag = latencyMs > 30_000 ? " [VERY SLOW]" : latencyMs > 10_000 ? " [SLOW]" : "";

        const outputLogAttrs: Record<string, string | number | boolean> = {
          "event.domain": "openclaw",
          "event.name": "llm.output",
          "openclaw.run_id": event.runId,
          "openclaw.session_id": event.sessionId,
          "openclaw.session_key": call.sessionKey,
          "openclaw.provider": event.provider,
          "openclaw.model": event.model,
          "openclaw.tokens.input": event.usage?.input ?? 0,
          "openclaw.tokens.output": event.usage?.output ?? 0,
          "openclaw.tokens.cache_read": event.usage?.cacheRead ?? 0,
          "openclaw.tokens.cache_write": event.usage?.cacheWrite ?? 0,
          "openclaw.duration_s": durationS,
        };

        // Content capture (Part 4B) — completion text on span + log
        if (captureContent && event.assistantTexts.length > 0) {
          const completionText = prepareContent(event.assistantTexts.join("\n"));
          call.span.setAttribute("gen_ai.completion", completionText);
          outputLogAttrs["gen_ai.completion"] = completionText;
        }

        emitLog(severity, severityText, `LLM output ${event.model} | ${durationS.toFixed(1)}s | ${totalTok}tok${slowTag}`, outputLogAttrs, call.span);

        activeLlmCalls.delete(event.runId);

        // Deferred summary: session was finalized while this LLM call was in-flight.
        // Now that this call is removed, check if it was the last pending one.
        if (session?.finalized && session.pendingSummary && !session.summaryEmitted) {
          const hasPendingLlm = [...activeLlmCalls.values()].some(
            c => c.sessionKey === session.sessionKey,
          );
          if (!hasPendingLlm) {
            // Last in-flight LLM call resolved — emit with fully accumulated data
            const durationMs = session.finalDurationMs ?? (Date.now() - session.startTime);
            emitSessionSummary(session, durationMs, "final", session.rootSpan);
            session.summaryEmitted = true;
          }
        }
      } else {
        // llm_output without llm_input — emit standalone log
        emitLog(SeverityNumber.WARN, "WARN", `LLM output ${event.model} (orphaned)`, {
          "event.domain": "openclaw",
          "event.name": "llm.output",
          "openclaw.run_id": event.runId,
          "openclaw.session_id": event.sessionId,
          "openclaw.provider": event.provider,
          "openclaw.model": event.model,
          "openclaw.orphaned": true,
        });
      }
    },

    // ── agent_end → completion span ───────────────────────────────────

    onAgentEnd(event, ctx) {
      const parentCtx = resolveParentCtx(ctx.sessionId, ctx.sessionKey);
      const now = Date.now();
      const startMs = event.durationMs ? now - event.durationMs : now;

      const span = tracer.startSpan("openclaw.agent.end", {
        kind: SpanKind.INTERNAL,
        startTime: startMs,
        attributes: {
          "openclaw.success": event.success,
          "openclaw.message_count": event.messages.length,
          "openclaw.duration_ms": event.durationMs ?? 0,
          "openclaw.session_key": ctx.sessionKey ?? "",
        },
      }, parentCtx);

      if (event.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.error });
        span.setAttribute("error.type", "agent_error");
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end(now);

      const agentBody = event.error
        ? `Agent FAILED | ${event.error}`
        : `Agent completed | ${event.messages.length} messages`;
      emitLog(
        event.error ? SeverityNumber.ERROR : SeverityNumber.INFO,
        event.error ? "ERROR" : "INFO",
        agentBody,
        {
          "event.domain": "openclaw",
          "event.name": "agent.end",
          "openclaw.success": event.success,
          "openclaw.message_count": event.messages.length,
          "openclaw.error": event.error ?? "",
          ...resolveSessionIds(ctx.sessionId, ctx.sessionKey),
        },
        span,
      );

      // Finalize session — emits FINAL summary, closes root span, cleans up maps.
      // This is the primary session-close signal (session_end is unreliable in CLI mode).
      const agentSession = resolveSessionCtx(ctx.sessionId, ctx.sessionKey);
      if (agentSession && !agentSession.finalized) {
        const durationMs = event.durationMs ?? (Date.now() - agentSession.startTime);
        // Check if any LLM calls are still in-flight for this session
        const hasPendingLlm = [...activeLlmCalls.values()].some(
          c => c.sessionKey === agentSession.sessionKey,
        );
        finalizeSession(agentSession, durationMs, event.error, /* deferSummary */ hasPendingLlm);
      }
    },

    // ── message_received → span + log ─────────────────────────────────

    onMessageReceived(event, ctx) {
      const now = Date.now();

      // Fix span parenting (Part 10) — resolve session context via conversationId
      let parentCtx: Context = ROOT_CONTEXT;
      if (ctx.conversationId) {
        const session = resolveSessionCtx(undefined, ctx.conversationId);
        if (session) parentCtx = session.ctx;
      }

      const spanAttrs: Record<string, string | number | boolean> = {
        "openclaw.from": event.from,
        "openclaw.channel": ctx.channelId,
      };

      // Content capture (Part 4C)
      if (captureContent && event.content) {
        spanAttrs["openclaw.content"] = prepareContent(event.content);
      }

      const span = tracer.startSpan("openclaw.message.received", {
        kind: SpanKind.SERVER,
        startTime: now,
        attributes: spanAttrs,
      }, parentCtx);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end(now);

      // ── Enrich root span name on first message (once per session) ──
      if (ctx.conversationId) {
        const session = resolveSessionCtx(undefined, ctx.conversationId);
        if (session && !session.firstMessageCaptured) {
          session.firstMessageCaptured = true;
          if (ctx.channelId) session.channel = ctx.channelId;
          const channel = ctx.channelId ? ` [${ctx.channelId}]` : "";
          const excerpt = event.content
            ? ` "${truncateForSpanName(event.content, 40)}"`
            : "";
          session.rootSpan.updateName(`invoke_agent openclaw [${session.sessionId}]${channel}${excerpt}`);
          session.rootSpan.setAttribute("openclaw.channel", ctx.channelId ?? "");
          session.rootSpan.setAttribute("openclaw.user_intent",
            event.content ? truncate(event.content, 200) : "");
        }
      }

      // Record user message type counter
      instruments.sessionMessageTypes.add(1, { type: "user" });

      const logAttrs: Record<string, string | number | boolean> = {
        "event.domain": "openclaw",
        "event.name": "message.received",
        "openclaw.from": event.from,
        "openclaw.channel": ctx.channelId,
        ...resolveSessionIds(undefined, ctx.conversationId),
      };
      if (captureContent && event.content) {
        logAttrs["openclaw.content"] = prepareContent(event.content);
      }

      emitLog(SeverityNumber.INFO, "INFO", `Message received from ${event.from} (${ctx.channelId})`, logAttrs, span);
    },

    // ── message_sent → span + log + metric ────────────────────────────

    onMessageSent(event, ctx) {
      const now = Date.now();

      // Fix span parenting (Part 10) — resolve session context via conversationId
      let parentCtx: Context = ROOT_CONTEXT;
      if (ctx.conversationId) {
        const session = resolveSessionCtx(undefined, ctx.conversationId);
        if (session) parentCtx = session.ctx;
      }

      const spanAttrs: Record<string, string | number | boolean> = {
        "openclaw.to": event.to,
        "openclaw.channel": ctx.channelId,
        "openclaw.success": event.success,
      };

      // Content capture (Part 4D)
      if (captureContent && event.content) {
        spanAttrs["openclaw.content"] = prepareContent(event.content);
      }

      const span = tracer.startSpan("openclaw.message.sent", {
        kind: SpanKind.CLIENT,
        startTime: now,
        attributes: spanAttrs,
      }, parentCtx);

      if (event.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.error });
        span.setAttribute("error.type", "delivery_error");
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end(now);

      instruments.messageDeliveryTotal.add(1, {
        channel: ctx.channelId,
        success: String(event.success),
      });

      const sentBody = event.error
        ? `FAILED to ${event.to}: ${event.error}`
        : `Message sent to ${event.to} (${ctx.channelId})`;
      const logAttrs: Record<string, string | number | boolean> = {
        "event.domain": "openclaw",
        "event.name": "message.sent",
        "openclaw.to": event.to,
        "openclaw.channel": ctx.channelId,
        "openclaw.success": event.success,
        "openclaw.error": event.error ?? "",
        ...resolveSessionIds(undefined, ctx.conversationId),
      };
      if (captureContent && event.content) {
        logAttrs["openclaw.content"] = prepareContent(event.content);
      }

      emitLog(
        event.error ? SeverityNumber.ERROR : SeverityNumber.INFO,
        event.error ? "ERROR" : "INFO",
        sentBody,
        logAttrs,
        span,
      );
    },

    // ── before_compaction → start compaction span ─────────────────────

    onBeforeCompaction(event, ctx) {
      const parentCtx = resolveParentCtx(ctx.sessionId, ctx.sessionKey);
      const now = Date.now();

      const span = tracer.startSpan("openclaw.compaction", {
        kind: SpanKind.INTERNAL,
        startTime: now,
        attributes: {
          "openclaw.compaction.messages_before": event.messageCount,
          "openclaw.compaction.compacting_count": event.compactingCount ?? 0,
          "openclaw.compaction.tokens_before": event.tokenCount ?? 0,
        },
      }, parentCtx);

      const key = ctx.sessionId ?? ctx.sessionKey ?? "__unknown__";
      activeCompactions.set(key, span);

      emitLog(SeverityNumber.INFO, "INFO", `Compaction started | ${event.messageCount} messages | ${event.tokenCount ?? 0} tokens`, {
        "event.domain": "openclaw",
        "event.name": "compaction.start",
        "openclaw.message_count": event.messageCount,
        "openclaw.token_count": event.tokenCount ?? 0,
        ...resolveSessionIds(ctx.sessionId, ctx.sessionKey),
      }, span);
    },

    // ── after_compaction → end compaction span + metric ────────────────

    onAfterCompaction(event, ctx) {
      const key = ctx.sessionId ?? ctx.sessionKey ?? "__unknown__";
      const span = activeCompactions.get(key);
      const now = Date.now();

      if (span) {
        span.setAttributes({
          "openclaw.compaction.messages_after": event.messageCount,
          "openclaw.compaction.messages_removed": event.compactedCount,
          "openclaw.compaction.tokens_after": event.tokenCount ?? 0,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end(now);
        activeCompactions.delete(key);

        emitLog(SeverityNumber.INFO, "INFO", `Compaction done | removed ${event.compactedCount} messages`, {
          "event.domain": "openclaw",
          "event.name": "compaction.end",
          "openclaw.messages_after": event.messageCount,
          "openclaw.compacted_count": event.compactedCount,
          "openclaw.token_count": event.tokenCount ?? 0,
          ...resolveSessionIds(ctx.sessionId, ctx.sessionKey),
        }, span);
      }

      instruments.compactionsTotal.add(1);
      instruments.compactionMessagesRemoved.record(event.compactedCount);
    },

    // ── subagent_spawned → span + log + metric ────────────────────────

    onSubagentSpawned(event, ctx) {
      const parentSession = ctx.requesterSessionKey
        ? resolveSessionCtx(undefined, ctx.requesterSessionKey)
        : undefined;
      const parentCtx = parentSession?.ctx ?? ROOT_CONTEXT;
      const now = Date.now();

      const span = tracer.startSpan(`openclaw.subagent.spawn ${event.agentId}`, {
        kind: SpanKind.INTERNAL,
        startTime: now,
        attributes: {
          "openclaw.subagent.agent_id": event.agentId,
          "openclaw.subagent.mode": event.mode,
          "openclaw.subagent.label": event.label ?? "",
          "openclaw.subagent.child_session_key": event.childSessionKey,
          "openclaw.subagent.thread_requested": event.threadRequested,
        },
      }, parentCtx);

      // Long-lived span: do NOT end immediately — subagent_ended will close it.
      // Store for deferred linking when the child's first llm_input fires.
      activeSubagentSpawns.set(event.childSessionKey, { span, mode: event.mode, startTime: now });

      // Store parent context for deferred child linking
      if (parentSession) {
        const parentSpanCtx = parentSession.rootSpan.spanContext();
        pendingChildren.set(event.childSessionKey, {
          parentSessionId: parentSession.sessionId,
          parentSessionKey: parentSession.sessionKey,
          parentTraceId: parentSpanCtx.traceId,
          parentSpanId: parentSpanCtx.spanId,
          agentId: event.agentId,
          label: event.label ?? "",
          mode: event.mode,
          spawnTime: now,
        });
      }

      instruments.subagentsSpawnedTotal.add(1, { mode: event.mode });

      const labelTag = event.label ? ` label=${event.label}` : "";
      emitLog(SeverityNumber.INFO, "INFO", `Subagent spawned ${event.agentId} (${event.mode})${labelTag}`, {
        "event.domain": "openclaw",
        "event.name": "subagent.spawn",
        "openclaw.agent_id": event.agentId,
        "openclaw.mode": event.mode,
        "openclaw.child_session_key": event.childSessionKey,
        "openclaw.label": event.label ?? "",
        ...resolveSessionIds(undefined, ctx.requesterSessionKey),
      }, span);
    },

    // ── subagent_ended → span + log + metric ──────────────────────────

    onSubagentEnded(event, ctx) {
      const now = Date.now();

      // Look up the long-lived spawn span created by onSubagentSpawned
      const storedEntry = activeSubagentSpawns.get(event.targetSessionKey);

      let span: Span;
      let spawnMode: string | undefined;
      if (storedEntry) {
        // ── Paired path: end the long-lived span with outcome attributes ──
        span = storedEntry.span;
        spawnMode = storedEntry.mode;
        span.setAttributes({
          "openclaw.subagent.target_kind": event.targetKind,
          "openclaw.subagent.reason": event.reason,
          "openclaw.subagent.outcome": event.outcome ?? "",
        });

        // Record subagent duration histogram
        const durationMs = now - storedEntry.startTime;
        instruments.subagentDurationMs.record(durationMs, { mode: storedEntry.mode });

        // Resolve child session ID from the relationship maps
        const childSessionId = resolveChildSessionId(event.targetSessionKey);
        if (childSessionId) {
          span.setAttribute("openclaw.subagent.child_session_id", childSessionId);
        }

        activeSubagentSpawns.delete(event.targetSessionKey);
      } else {
        // ── Fallback: spawn was missed — create standalone end span ──
        const parentCtx = ctx.requesterSessionKey
          ? resolveParentCtx(undefined, ctx.requesterSessionKey)
          : ROOT_CONTEXT;

        span = tracer.startSpan("openclaw.subagent.end", {
          kind: SpanKind.INTERNAL,
          startTime: now,
          attributes: {
            "openclaw.subagent.target_session_key": event.targetSessionKey,
            "openclaw.subagent.target_kind": event.targetKind,
            "openclaw.subagent.reason": event.reason,
            "openclaw.subagent.outcome": event.outcome ?? "",
          },
        }, parentCtx);
      }

      if (event.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.error });
        span.setAttribute("error.type", "subagent_error");
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end(now);

      // Clean up pending children for this session key (in case linking never happened)
      pendingChildren.delete(event.targetSessionKey);

      instruments.subagentOutcomesTotal.add(1, {
        outcome: event.outcome ?? "unknown",
        mode: spawnMode ?? "unknown",
      });

      emitLog(
        event.error ? SeverityNumber.ERROR : SeverityNumber.INFO,
        event.error ? "ERROR" : "INFO",
        `Subagent ended ${event.targetSessionKey} | ${event.reason}`,
        {
          "event.domain": "openclaw",
          "event.name": "subagent.end",
          "openclaw.target_session_key": event.targetSessionKey,
          "openclaw.reason": event.reason,
          "openclaw.outcome": event.outcome ?? "",
          "openclaw.error": event.error ?? "",
          ...resolveSessionIds(undefined, ctx.requesterSessionKey),
        },
        span,
      );
    },

    // ── after_tool_call → gen_ai execute_tool span ────────────────────

    onAfterToolCall(event, ctx) {
      const now = Date.now();

      // Pop from LIFO stack (handles concurrent same-name tool calls)
      let toolCallKey = `${ctx.sessionKey ?? ""}:${event.toolName}`;
      let stack = activeToolCalls.get(toolCallKey);
      // Fallback: when ctx.sessionKey is undefined in after_tool_call (plugin-registered tools),
      // scan all keys ending with ":toolName" to find the matching before_tool_call entry
      if (!stack?.length && !ctx.sessionKey) {
        const suffix = `:${event.toolName}`;
        for (const [key, s] of activeToolCalls) {
          if (key.endsWith(suffix) && s.length > 0) {
            toolCallKey = key;
            stack = s;
            break;
          }
        }
      }
      const beforeEntry = stack?.pop();
      if (stack && stack.length === 0) activeToolCalls.delete(toolCallKey);

      // Resolve session key: prefer ctx, fall back to the key found by scan
      const resolvedSessionKey = ctx.sessionKey
        ?? (beforeEntry ? toolCallKey.slice(0, toolCallKey.lastIndexOf(":")) : "");

      const truncatedArgs = prepareContent(JSON.stringify(event.params ?? {}));
      const truncatedResult = event.result
        ? prepareContent(JSON.stringify(event.result))
        : "";
      const toolDescription = TOOL_DESCRIPTIONS[event.toolName] ?? "";

      let span: Span;

      if (beforeEntry) {
        // ── Paired path: complete the span started by before_tool_call ──
        span = beforeEntry.span;
        span.setAttributes({
          "gen_ai.tool.call.id": ctx.toolCallId ?? "",
          "gen_ai.tool.call.result": truncatedResult,
          ...(toolDescription ? { "gen_ai.tool.description": toolDescription } : {}),
          "tool.duration_ms": event.durationMs ?? (now - beforeEntry.startTime),
          "tool.param_keys": Object.keys(event.params ?? {}).join(","),
        });
      } else {
        // ── Fallback: no matching before_tool_call — create span from scratch ──
        const startMs = event.durationMs ? now - event.durationMs : now;
        let parentCtx: Context = ROOT_CONTEXT;
        let sessionInferred = false;
        let fallbackSessionId = "";
        if (ctx.sessionKey) {
          const session = resolveSessionCtx(undefined, ctx.sessionKey);
          if (session) {
            parentCtx = session.ctx;
            fallbackSessionId = session.sessionId;
          }
        }
        // Fallback: when ctx.sessionKey is undefined, pick the best active session
        if (parentCtx === ROOT_CONTEXT) {
          const fallback = resolveAnyActiveSession();
          if (fallback) {
            parentCtx = fallback.ctx;
            fallbackSessionId = fallback.sessionId;
            sessionInferred = true;
          }
        }

        span = tracer.startSpan(`execute_tool ${event.toolName}`, {
          kind: SpanKind.INTERNAL,
          startTime: startMs,
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.provider.name": "openclaw",
            "gen_ai.tool.name": event.toolName,
            "gen_ai.tool.call.id": ctx.toolCallId ?? "",
            "gen_ai.tool.type": "function",
            "gen_ai.tool.call.arguments": truncatedArgs,
            "gen_ai.tool.call.result": truncatedResult,
            ...(toolDescription ? { "gen_ai.tool.description": toolDescription } : {}),
            "gen_ai.conversation.id": fallbackSessionId,
            "openclaw.session_key": resolvedSessionKey,
            "tool.duration_ms": event.durationMs ?? 0,
            "tool.param_keys": Object.keys(event.params ?? {}).join(","),
            ...(sessionInferred ? { "openclaw.session_inferred": true } : {}),
          },
        }, parentCtx);
      }

      // ── Set status + enrich span name (common path) ──
      const toolDurationMs = event.durationMs ?? (beforeEntry ? now - beforeEntry.startTime : 0);
      if (event.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.error });
        span.setAttribute("error.type", "tool_error");
        span.setAttribute("openclaw.tool_status", "error");
        span.updateName(`execute_tool ${event.toolName} [ERROR: ${truncateForSpanName(event.error, 30)}]`);
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttribute("openclaw.tool_status", "success");
        span.updateName(`execute_tool ${event.toolName} [ok ${toolDurationMs}ms]`);
      }
      span.end(now);

      // Record tool metrics
      const toolStatus = event.error ? "error" : "success";
      instruments.toolCallsTotal.add(1, { tool: event.toolName, status: toolStatus });
      if (event.durationMs !== undefined) {
        instruments.toolDurationMs.record(event.durationMs, { tool: event.toolName });
      }

      // Security: classify tool errors for anomaly detection
      if (event.error) {
        const errorClass = classifyToolError(event.error);
        instruments.toolErrorClasses.add(1, { tool: event.toolName, error_class: errorClass });
      }

      // Accumulate tool usage in session state + record message type counters
      {
        let session = resolveSessionCtx(undefined, ctx.sessionKey);
        // Fallback: try session resolved during before_tool_call, or pick any active session
        if (!session && beforeEntry?.resolvedSessionId) {
          session = activeSessions.get(beforeEntry.resolvedSessionId);
        }
        if (!session) {
          const fallback = resolveAnyActiveSession();
          if (fallback) session = fallback;
        }
        if (session) {
          session.totalToolDurationMs += toolDurationMs;
          const count = session.toolCounts.get(event.toolName) ?? 0;
          session.toolCounts.set(event.toolName, count + 1);
          session.messageCountToolCalls++;
          if (event.result !== undefined) session.messageCountToolResults++;
          if (event.error) {
            session.messageCountErrors++;
            // SRE tool error pattern detection (Part 6D)
            const errorCount = (session.toolErrorCounts.get(event.toolName) ?? 0) + 1;
            session.toolErrorCounts.set(event.toolName, errorCount);
            if (errorCount >= 3) {
              emitLog(SeverityNumber.WARN, "WARN",
                `Tool ${event.toolName} repeated failures (${errorCount} errors in session)`,
                {
                  "event.domain": "openclaw",
                  "event.name": "tool.repeated_failure",
                  "gen_ai.tool.name": event.toolName,
                  "openclaw.error_count": errorCount,
                  ...resolveSessionIds(undefined, resolvedSessionKey),
                }, span);
            }
          }
        }
      }
      instruments.sessionMessageTypes.add(1, { type: "tool_call" });
      if (event.result !== undefined) {
        instruments.sessionMessageTypes.add(1, { type: "tool_result" });
      }
      if (event.error) {
        instruments.sessionMessageTypes.add(1, { type: "error" });
      }

      // Emit correlated log record
      const toolBody = event.error
        ? `Tool ERROR ${event.toolName}: ${event.error}`
        : `Tool ${event.toolName} ${event.durationMs ?? 0}ms | ${Object.keys(event.params ?? {}).join(",")}`;
      emitLog(
        event.error ? SeverityNumber.ERROR : SeverityNumber.INFO,
        event.error ? "ERROR" : "INFO",
        toolBody,
        {
          "event.domain": "openclaw",
          "event.name": "tool.call",
          // gen_ai attributes in log too
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": event.toolName,
          "tool.duration_ms": event.durationMs ?? 0,
          "tool.error": event.error ?? "",
          // NOTE: tool.params and tool.result intentionally omitted from logs —
          // truncated JSON strings cause Loki JSONParserErr. Full values live on Tempo spans.
          "tool.param_keys": Object.keys(event.params ?? {}).join(","),
          ...resolveSessionIds(beforeEntry?.resolvedSessionId, resolvedSessionKey),
        },
        span,
      );
    },

    // ── before_reset → session context wipe detection (Part 5A) ────────

    onBeforeReset(event, ctx) {
      const parentCtx = resolveParentCtx(ctx.sessionId, ctx.sessionKey);
      const now = Date.now();
      const messageCount = event.messages?.length ?? 0;
      const reason = event.reason ?? "unknown";
      instruments.sessionResets.add(1, { reason });

      const span = tracer.startSpan("openclaw.session.reset", {
        kind: SpanKind.INTERNAL,
        startTime: now,
        attributes: {
          "openclaw.reset.message_count": messageCount,
          "openclaw.reset.reason": reason,
          ...(event.sessionFile ? { "openclaw.reset.session_file": event.sessionFile } : {}),
          "openclaw.session_key": ctx.sessionKey ?? "",
        },
      }, parentCtx);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end(now);

      emitLog(SeverityNumber.WARN, "WARN",
        `Session reset | ${messageCount} messages lost | reason=${reason}`,
        {
          "event.domain": "openclaw",
          "event.name": "session.reset",
          "openclaw.reset.message_count": messageCount,
          "openclaw.reset.reason": reason,
          ...resolveSessionIds(ctx.sessionId, ctx.sessionKey),
        }, span);
    },

    // ── before_tool_call → create execute_tool span (ended by after_tool_call) ──

    onBeforeToolCall(event, ctx) {
      const now = Date.now();

      // Resolve parent: session root > ROOT_CONTEXT
      // Tools execute between LLM turns (after llm_output ends the chat span),
      // so they are siblings of chat spans under the invoke_agent root — not children of chat.
      let parentCtx: Context = ROOT_CONTEXT;
      let resolvedSessionId: string | undefined;
      if (ctx.sessionKey) {
        const session = resolveSessionCtx(undefined, ctx.sessionKey);
        if (session) {
          parentCtx = session.ctx;
          resolvedSessionId = session.sessionId;
        }
      }

      // Fallback: when ctx.sessionKey is undefined (plugin-registered tools),
      // pick the best active session instead of orphaning to ROOT_CONTEXT
      if (parentCtx === ROOT_CONTEXT) {
        const fallback = resolveAnyActiveSession();
        if (fallback) {
          parentCtx = fallback.ctx;
          resolvedSessionId = fallback.sessionId;
        }
      }

      const truncatedArgs = prepareContent(JSON.stringify(event.params ?? {}));

      // Create the definitive execute_tool span — onAfterToolCall will end it
      const span = tracer.startSpan(`execute_tool ${event.toolName}`, {
        kind: SpanKind.INTERNAL,
        startTime: now,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.provider.name": "openclaw",
          "gen_ai.tool.name": event.toolName,
          "gen_ai.tool.type": "function",
          "gen_ai.tool.call.arguments": truncatedArgs,
          "gen_ai.conversation.id": resolvedSessionId ?? "",
          "openclaw.session_key": ctx.sessionKey ?? "",
          // Mark when session was inferred (not provided by hook context)
          ...(!ctx.sessionKey && resolvedSessionId ? { "openclaw.session_inferred": true } : {}),
        },
      }, parentCtx);

      // Push onto LIFO stack (handles concurrent same-name tool calls)
      const toolCallKey = `${ctx.sessionKey ?? ""}:${event.toolName}`;
      const stack = activeToolCalls.get(toolCallKey) ?? [];
      stack.push({ span, toolName: event.toolName, startTime: now, resolvedSessionId });
      activeToolCalls.set(toolCallKey, stack);

      // Don't end the span — it will be ended by onAfterToolCall or cleaned up on destroy
    },

    // ── gateway_start → infrastructure availability (Part 5B) ──────────

    onGatewayStart(event) {
      instruments.gatewayRestarts.add(1);
      emitLog(SeverityNumber.INFO, "INFO",
        `Gateway started on port ${event.port ?? "unknown"}`,
        {
          "event.domain": "openclaw",
          "event.name": "gateway.start",
          ...(event.port !== undefined ? { "openclaw.gateway.port": event.port } : {}),
        });
    },

    // ── gateway_stop → infrastructure shutdown (Part 5C) ───────────────

    onGatewayStop(event) {
      const reason = event.reason ?? "unknown";
      emitLog(SeverityNumber.WARN, "WARN",
        `Gateway stopped | reason=${reason}`,
        {
          "event.domain": "openclaw",
          "event.name": "gateway.stop",
          "openclaw.gateway.reason": reason,
        });
    },

    // ── getSessionContext ──────────────────────────────────────────────

    getSessionContext(sessionKey) {
      const session = resolveSessionCtx(undefined, sessionKey);
      if (session && !session.finalized) return { span: session.rootSpan, ctx: session.ctx };
      return undefined;
    },

    // ── getSessionContextByAny ────────────────────────────────────────

    getSessionContextByAny(sessionId, sessionKey) {
      const session = resolveSessionCtx(sessionId, sessionKey);
      if (session && !session.finalized) return { span: session.rootSpan, ctx: session.ctx };
      return undefined;
    },

    // ── getAvgLatencyMs ─────────────────────────────────────────────

    getAvgLatencyMs() {
      return latencyWindow.length > 0
        ? latencyWindow.reduce((a, b) => a + b, 0) / latencyWindow.length : 0;
    },

    getUniqueSessionCount1h() {
      return getUniqueSessionCount();
    },

    // ── flushAll ──────────────────────────────────────────────────────

    async flushAll() {
      await Promise.all([
        logs.forceFlush().catch(() => {}),
        traces.forceFlush().catch(() => {}),
      ]);
    },

    // ── destroy ───────────────────────────────────────────────────────

    destroy() {
      clearInterval(cleanupInterval);
      // Finalize all active sessions — setAttribute BEFORE finalizeSession because
      // finalizeSession calls rootSpan.end(), and OTel ignores attributes set after end()
      const now = Date.now();
      const shutdownMsg = "gateway shutdown — unclean span close";
      for (const [, session] of activeSessions) {
        // Emit any deferred summaries that never resolved
        if (session.pendingSummary && !session.summaryEmitted) {
          const durationMs = session.finalDurationMs ?? (now - session.startTime);
          emitSessionSummary(session, durationMs, "final", session.rootSpan);
          session.summaryEmitted = true;
        }
        if (session.finalized) continue;
        session.rootSpan.setAttribute("openclaw.unclean_shutdown", true);
        const durationMs = now - session.startTime;
        finalizeSession(session, durationMs, shutdownMsg);
      }
      for (const [, call] of activeLlmCalls) {
        call.span.setAttribute("openclaw.unclean_shutdown", true);
        call.span.setStatus({ code: SpanStatusCode.ERROR, message: shutdownMsg });
        call.span.end(now);
      }
      for (const [, span] of activeCompactions) {
        span.setAttribute("openclaw.unclean_shutdown", true);
        span.setStatus({ code: SpanStatusCode.ERROR, message: shutdownMsg });
        span.end(now);
      }
      // LIFO stacks: iterate all entries
      for (const [, stack] of activeToolCalls) {
        for (const entry of stack) {
          entry.span.setAttribute("openclaw.unclean_shutdown", true);
          entry.span.setStatus({ code: SpanStatusCode.ERROR, message: shutdownMsg });
          entry.span.end(now);
        }
      }
      // End orphaned subagent spawn spans
      for (const [, entry] of activeSubagentSpawns) {
        entry.span.setAttribute("openclaw.unclean_shutdown", true);
        entry.span.setStatus({ code: SpanStatusCode.ERROR, message: shutdownMsg });
        entry.span.end(now);
      }
      activeSessions.clear();
      activeLlmCalls.clear();
      sessionKeyToId.clear();
      activeCompactions.clear();
      activeToolCalls.clear();
      activeSubagentSpawns.clear();
      pendingChildren.clear();
      parentToChildren.clear();
      childToParent.clear();
      uniqueSessionMap.clear();
      latencyWindow.length = 0;
    },
  };
}
