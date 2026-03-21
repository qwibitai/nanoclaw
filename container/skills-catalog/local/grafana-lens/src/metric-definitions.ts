/**
 * Shared metric definitions — single source of truth for all openclaw_lens_* metrics.
 *
 * This module is consumed by:
 *   - metrics-collector.ts   → OTel instrument name + description for meter.create*()
 *   - list-metrics.ts        → Prometheus name + type + help for OTLP metadata fallback
 *   - explain-metric.ts      → labels for drill-down breakdown suggestions
 *   - health-context.ts      → thresholds for SRE health evaluation
 *
 * Adding a new metric? Add it here and all four consumers pick it up automatically.
 *
 * Naming conventions:
 *   - OTel name: `openclaw_lens_<name>` (no _total suffix for counters)
 *   - Prometheus name: derived automatically — counters get `_total`, histograms expose _bucket/_count/_sum
 *   - Gauges: as-is
 */

// ── Types ────────────────────────────────────────────────────────────

/** Direction for health threshold evaluation. Canonical definition — re-exported by health-context.ts. */
export type HealthDirection = "higher_is_worse" | "lower_is_worse";

/** Prometheus metric type (matches OTel instrument type mapped to Prometheus conventions). */
export type PrometheusMetricType = "counter" | "gauge" | "histogram" | "unknown";

/** OTel instrument kind — determines how the instrument is created in metrics-collector. */
export type OtelInstrumentKind =
  | "counter"          // meter.createCounter()
  | "histogram"        // meter.createHistogram()
  | "updown_counter"   // meter.createUpDownCounter()
  | "observable_gauge"; // meter.createObservableGauge()

export interface MetricDefinition {
  /** OTel instrument name (no _total suffix — OTel SDK appends it for counters in Prometheus export). */
  readonly otelName: string;
  /** Human-readable description (used as both OTel description and Prometheus HELP). */
  readonly help: string;
  /** OTel instrument kind. */
  readonly instrument: OtelInstrumentKind;
  /** Known label keys for drill-down suggestions (ordered by analytical importance). */
  readonly labels?: readonly string[];
  /** SRE health thresholds (only for gauge-type metrics). */
  readonly health?: {
    readonly warning: number;
    readonly critical: number;
    readonly direction: HealthDirection;
    /** Optional SRE-oriented description (richer than `help`). Falls back to `help` if omitted. */
    readonly description?: string;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Derive the Prometheus metric type from the OTel instrument kind. */
export function prometheusType(kind: OtelInstrumentKind): PrometheusMetricType {
  switch (kind) {
    case "counter": return "counter";
    case "histogram": return "histogram";
    case "updown_counter":
    case "observable_gauge": return "gauge";
  }
}

/**
 * Derive the Prometheus metric name from the OTel instrument name and kind.
 * Counters get `_total` appended (OTel→Prometheus convention).
 * Histograms and gauges keep their name as-is.
 */
export function prometheusName(def: MetricDefinition): string {
  return def.instrument === "counter" ? `${def.otelName}_total` : def.otelName;
}

// ── Metric Definitions ──────────────────────────────────────────────
//
// Grouped by functional area. Order matches metrics-collector.ts instrument creation.

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  // ── Counters ────────────────────────────────────────────────────────
  {
    otelName: "openclaw_lens_custom_metrics_pushed_total",
    help: "Data points pushed via grafana_push_metrics",
    instrument: "counter",
  },
  {
    otelName: "openclaw_lens_sessions_started_total",
    help: "Total sessions started",
    instrument: "counter",
    labels: ["type"],
  },
  {
    otelName: "openclaw_lens_compactions_total",
    help: "Total context compactions performed",
    instrument: "counter",
  },
  {
    otelName: "openclaw_lens_subagents_spawned_total",
    help: "Total subagents spawned",
    instrument: "counter",
    labels: ["mode"],
  },
  {
    otelName: "openclaw_lens_sessions_completed",
    help: "Sessions completed by outcome (success/error)",
    instrument: "counter",
    labels: ["outcome"],
  },
  {
    otelName: "openclaw_lens_subagent_outcomes_total",
    help: "Subagent completion outcomes",
    instrument: "counter",
    labels: ["outcome", "mode"],
  },
  {
    otelName: "openclaw_lens_message_delivery_total",
    help: "Messages delivered to channels",
    instrument: "counter",
    labels: ["channel", "success"],
  },
  {
    otelName: "openclaw_lens_tool_calls_total",
    help: "Total tool calls by tool name and status",
    instrument: "counter",
    labels: ["tool", "status"],
  },
  {
    otelName: "openclaw_lens_cost_by_model",
    help: "Cost accumulated per model and provider",
    instrument: "counter",
    labels: ["model", "provider"],
  },
  {
    otelName: "openclaw_lens_session_message_types",
    help: "Message type breakdown (user, assistant, tool_call, tool_result, error)",
    instrument: "counter",
    labels: ["type"],
  },
  {
    otelName: "openclaw_lens_cost_by_token_type",
    help: "Cost breakdown by token type (input, output, cache_read, cache_write)",
    instrument: "counter",
    labels: ["model", "token_type", "provider"],
  },
  {
    otelName: "openclaw_lens_tokens",
    help: "Token usage by type, provider, and model",
    instrument: "counter",
    labels: ["model", "token", "provider"],
  },
  {
    otelName: "openclaw_lens_messages_processed",
    help: "Messages processed by outcome and channel",
    instrument: "counter",
    labels: ["outcome", "channel"],
  },
  {
    otelName: "openclaw_lens_webhook_received",
    help: "Webhook notifications received by channel and type",
    instrument: "counter",
    labels: ["channel", "update_type"],
  },
  {
    otelName: "openclaw_lens_webhook_error",
    help: "Webhook processing errors by channel and type",
    instrument: "counter",
    labels: ["channel", "update_type"],
  },
  {
    otelName: "openclaw_lens_queue_lane_enqueue",
    help: "Queue lane enqueue events by lane",
    instrument: "counter",
    labels: ["lane"],
  },
  {
    otelName: "openclaw_lens_queue_lane_dequeue",
    help: "Queue lane dequeue events by lane",
    instrument: "counter",
    labels: ["lane"],
  },

  // ── Security Counters ──────────────────────────────────────────────
  {
    otelName: "openclaw_lens_gateway_restarts",
    help: "Gateway process restarts (infrastructure instability indicator)",
    instrument: "counter",
  },
  {
    otelName: "openclaw_lens_session_resets",
    help: "Session context resets by reason",
    instrument: "counter",
    labels: ["reason"],
  },
  {
    otelName: "openclaw_lens_tool_error_classes",
    help: "Tool errors classified by error type (network, filesystem, timeout, other)",
    instrument: "counter",
    labels: ["tool", "error_class"],
  },
  {
    otelName: "openclaw_lens_prompt_injection_signals",
    help: "Prompt injection pattern detections by detector source",
    instrument: "counter",
    labels: ["detector"],
  },

  // ── Histograms ─────────────────────────────────────────────────────
  {
    otelName: "openclaw_lens_session_duration_ms",
    help: "Session duration in milliseconds",
    instrument: "histogram",
  },
  {
    otelName: "openclaw_lens_compaction_messages_removed",
    help: "Messages removed per compaction",
    instrument: "histogram",
  },
  {
    otelName: "openclaw_lens_tool_duration_ms",
    help: "Tool call duration in milliseconds by tool name",
    instrument: "histogram",
    labels: ["tool"],
  },
  {
    otelName: "openclaw_lens_subagent_duration_ms",
    help: "Subagent execution duration in milliseconds by mode",
    instrument: "histogram",
    labels: ["mode"],
  },
  {
    otelName: "openclaw_lens_webhook_duration_ms",
    help: "Webhook processing duration in milliseconds",
    instrument: "histogram",
    labels: ["channel", "update_type"],
  },
  {
    otelName: "openclaw_lens_queue_wait_ms",
    help: "Time messages wait in queue before processing, in milliseconds",
    instrument: "histogram",
    labels: ["lane"],
  },

  // ── Gauges (UpDownCounter) ─────────────────────────────────────────
  {
    otelName: "openclaw_lens_sessions_active",
    help: "Currently active sessions by state",
    instrument: "updown_counter",
    labels: ["state"],
  },

  // ── Gauges (ObservableGauge) ───────────────────────────────────────
  {
    otelName: "openclaw_lens_queue_depth",
    help: "Current queue depth",
    instrument: "observable_gauge",
    health: { warning: 10, critical: 50, direction: "higher_is_worse", description: "Message queue depth — messages waiting for processing" },
  },
  {
    otelName: "openclaw_lens_context_tokens",
    help: "Context window token usage",
    instrument: "observable_gauge",
    labels: ["type"],
  },
  {
    otelName: "openclaw_lens_sessions_active_snapshot",
    help: "Active sessions snapshot from heartbeat (cross-check for UpDownCounter drift)",
    instrument: "observable_gauge",
  },
  {
    otelName: "openclaw_lens_sessions_stuck",
    help: "Number of currently stuck sessions",
    instrument: "observable_gauge",
    health: { warning: 1, critical: 3, direction: "higher_is_worse", description: "Number of stuck sessions — sessions not making progress" },
  },
  {
    otelName: "openclaw_lens_stuck_session_max_age_ms",
    help: "Maximum age of any stuck session in milliseconds",
    instrument: "observable_gauge",
    health: { warning: 60_000, critical: 300_000, direction: "higher_is_worse", description: "Age of the longest-stuck session in milliseconds" },
  },
  {
    otelName: "openclaw_lens_cache_read_ratio",
    help: "Ratio of tokens served from cache vs total input (0-1)",
    instrument: "observable_gauge",
    health: { warning: 0.3, critical: 0.1, direction: "lower_is_worse", description: "Prompt cache hit ratio — low values mean poor cache utilization and higher costs" },
  },
  {
    otelName: "openclaw_lens_tool_loops_active",
    help: "Sessions currently in detected tool loops",
    instrument: "observable_gauge",
    labels: ["level"],
    health: { warning: 1, critical: 3, direction: "higher_is_worse", description: "Active tool loop detections — agent may be stuck in a retry loop" },
  },
  {
    otelName: "openclaw_lens_queue_lane_depth",
    help: "Current queue depth per command lane",
    instrument: "observable_gauge",
    labels: ["lane"],
  },
  {
    otelName: "openclaw_lens_alert_webhooks_received",
    help: "Total alert webhook notifications received from Grafana",
    instrument: "observable_gauge",
    labels: ["status"],
  },
  {
    otelName: "openclaw_lens_alert_webhooks_pending",
    help: "Number of pending (unacknowledged) alert webhook notifications",
    instrument: "observable_gauge",
    health: { warning: 5, critical: 20, direction: "higher_is_worse", description: "Pending alert webhooks — unprocessed alert notifications" },
  },
  {
    otelName: "openclaw_lens_daily_cost_usd",
    help: "Cost accumulated since last daily reset",
    instrument: "observable_gauge",
    health: { warning: 5, critical: 20, direction: "higher_is_worse", description: "Accumulated AI spend for the current day (USD)" },
  },
  {
    otelName: "openclaw_lens_cache_savings_usd",
    help: "Estimated USD saved by serving tokens from cache instead of fresh input",
    instrument: "observable_gauge",
  },
  {
    otelName: "openclaw_lens_cache_token_ratio",
    help: "Ratio of cache tokens (read+write) to all tokens (0-1)",
    instrument: "observable_gauge",
  },
  {
    otelName: "openclaw_lens_session_latency_avg_ms",
    help: "Rolling average LLM call latency in milliseconds",
    instrument: "observable_gauge",
  },

  // ── Security Gauges ────────────────────────────────────────────────
  {
    otelName: "openclaw_lens_unique_sessions_1h",
    help: "Unique session IDs seen in the last 1 hour (session enumeration indicator)",
    instrument: "observable_gauge",
    health: { warning: 50, critical: 200, direction: "higher_is_worse", description: "Unique sessions in the last hour — sudden spikes may indicate token theft or session enumeration" },
  },
] as const;

// ── Pre-built lookup maps (derived from METRIC_DEFINITIONS) ─────────

/** Prometheus name → { type, help } — used by list-metrics.ts OTLP fallback. */
export const KNOWN_METRICS_MAP: ReadonlyMap<string, { type: PrometheusMetricType; help: string }> =
  new Map(
    METRIC_DEFINITIONS.map((d) => [
      prometheusName(d),
      { type: prometheusType(d.instrument), help: d.help },
    ]),
  );

/** Prometheus name → string[] — used by explain-metric.ts for drill-down labels. */
export const KNOWN_BREAKDOWNS_MAP: Readonly<Record<string, string[]>> =
  Object.fromEntries(
    METRIC_DEFINITIONS
      .filter((d): d is MetricDefinition & { labels: readonly string[] } =>
        !!d.labels && d.labels.length > 0)
      .map((d) => [prometheusName(d), [...d.labels]]),
  );

/** Prometheus name → health rule — used by health-context.ts for SRE thresholds. */
export const HEALTH_RULES_MAP: Readonly<Record<string, {
  warning: number;
  critical: number;
  description: string;
  direction: HealthDirection;
}>> = Object.fromEntries(
  METRIC_DEFINITIONS
    .filter((d): d is MetricDefinition & { health: NonNullable<MetricDefinition["health"]> } =>
      !!d.health)
    .map((d) => [
      prometheusName(d),
      {
        warning: d.health.warning,
        critical: d.health.critical,
        description: d.health.description ?? d.help,
        direction: d.health.direction,
      },
    ]),
);

/** OTel name → MetricDefinition — used by metrics-collector.ts for instrument creation. */
export const DEFINITIONS_BY_OTEL_NAME: ReadonlyMap<string, MetricDefinition> =
  new Map(METRIC_DEFINITIONS.map((d) => [d.otelName, d]));
