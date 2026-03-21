/**
 * Metrics Collector Service
 *
 * Subscribes to OpenClaw diagnostic events and converts them to OpenTelemetry
 * signals pushed via OTLP to the configured collector (LGTM stack, Grafana Cloud, etc.).
 *
 * Three pillars, one handler:
 *   - Metrics: operational gauges (sessions, cost, context, queues) → Mimir → Grafana dashboards
 *   - Logs: verbose structured log records for ALL events → Loki → Grafana Explore
 *   - Traces: agent lifecycle spans (model calls, messages, webhooks) → Tempo → Grafana Explore
 *
 * Log-to-trace correlation: span-producing events include trace_id in the log record,
 * enabling Grafana's "Logs to Traces" feature (click Loki log → jump to Tempo trace).
 */

import type {
  DiagnosticEventPayload,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk";
import { onDiagnosticEvent, registerLogTransport } from "openclaw/plugin-sdk";
import { redactSecrets, flattenLogKeys } from "./redact.js";

// tool.loop event type exists in openclaw source but is not yet published
// in the npm package. Define locally until the next openclaw release.
type DiagnosticToolLoopEvent = {
  type: "tool.loop";
  sessionKey?: string;
  sessionId?: string;
  toolName: string;
  level: "warning" | "critical";
  action: "warn" | "block";
  detector: string;
  count: number;
  message: string;
  pairedToolName?: string;
};

type ExtendedDiagnosticEvent = DiagnosticEventPayload | DiagnosticToolLoopEvent;

import { createOtelMetrics, type OtelMetrics } from "./otel-metrics.js";
import { createOtelLogs, type OtelLogs, SeverityNumber } from "./otel-logs.js";
import { createOtelTraces, type OtelTraces, SpanKind, SpanStatusCode } from "./otel-traces.js";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { createLifecycleTelemetry, type LifecycleTelemetry, type LifecycleTelemetryOpts } from "./lifecycle-telemetry.js";
import { deriveOtlpEndpoints, type ValidatedGrafanaLensConfig } from "../config.js";
import type { ObservableResult } from "@opentelemetry/api";
import type { AlertStore } from "./alert-webhook.js";
import { CustomMetricsStore } from "./custom-metrics-store.js";
import { OtlpJsonWriter } from "./otlp-json-writer.js";
import { estimateCostFallback, resolveModelCostFromConfig, estimateUsageCost } from "./model-pricing.js";
import { DEFINITIONS_BY_OTEL_NAME } from "../metric-definitions.js";

/**
 * Look up the description for an openclaw_lens_* metric from the shared
 * metric-definitions registry. Throws at startup if the metric is missing
 * from the registry — catches drift immediately.
 */
function desc(otelName: string): string {
  const def = DEFINITIONS_BY_OTEL_NAME.get(otelName);
  if (!def) throw new Error(`Metric '${otelName}' not found in METRIC_DEFINITIONS — add it to src/metric-definitions.ts`);
  return def.help;
}

// gen_ai.client.operation.duration explicit bucket boundaries (from OTel gen_ai spec)
const GEN_AI_DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];

export function createMetricsCollectorService(
  config: ValidatedGrafanaLensConfig,
  alertStore?: AlertStore,
  pluginVersion?: string,
): {
  service: OpenClawPluginService;
  getCustomMetricsStore: () => CustomMetricsStore | null;
  getOtelTraces: () => OtelTraces | null;
  getOtelLogs: () => OtelLogs | null;
  getLifecycleTelemetry: () => LifecycleTelemetry | null;
} {
  let unsubscribe: (() => void) | null = null;
  let unsubscribeLogTransport: (() => void) | null = null;
  let midnightTimeout: NodeJS.Timeout | null = null;
  let customStore: CustomMetricsStore | null = null;
  let otel: OtelMetrics | null = null;
  let otelLogs: OtelLogs | null = null;
  let otelTraces: OtelTraces | null = null;
  let lifecycle: LifecycleTelemetry | null = null;

  const service: OpenClawPluginService = {
    id: "grafana-lens-metrics",

    async start(ctx: OpenClawPluginServiceContext) {
      if (config.metrics?.enabled === false) {
        ctx.logger.info("grafana-lens: metrics collection disabled");
        return;
      }

      // ── Derive per-signal OTLP endpoints ────────────────────────
      const otlpConfig = config.otlp ?? {};
      const endpoints = deriveOtlpEndpoints(otlpConfig.endpoint);

      // ── Initialize OTLP metrics provider ────────────────────────
      otel = createOtelMetrics({
        endpoint: endpoints.metrics,
        headers: otlpConfig.headers,
        exportIntervalMs: otlpConfig.exportIntervalMs,
        serviceVersion: pluginVersion,
      });

      // ── Initialize OTLP logs provider ───────────────────────────
      if (otlpConfig.logs !== false) {
        otelLogs = createOtelLogs({
          endpoint: endpoints.logs,
          headers: otlpConfig.headers,
          serviceVersion: pluginVersion,
        });
        ctx.logger.info(`grafana-lens: logs push enabled (OTLP → ${endpoints.logs})`);
      }

      // ── Initialize OTLP traces provider ─────────────────────────
      if (otlpConfig.traces !== false) {
        otelTraces = createOtelTraces({
          endpoint: endpoints.traces,
          headers: otlpConfig.headers,
          serviceVersion: pluginVersion,
        });
        ctx.logger.info(`grafana-lens: traces push enabled (OTLP → ${endpoints.traces})`);
      }

      // ── Non-blocking OTLP endpoint connectivity check ─────────
      // Fires a probe POST immediately so the user gets early feedback
      // if the OTLP collector is unreachable (instead of silent data loss).
      const checkOtlpEndpoint = async (url: string) => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 3_000);
          await fetch(url, {
            method: "POST",
            body: "{}",
            signal: ctrl.signal,
            headers: { "Content-Type": "application/json", ...otlpConfig.headers },
          });
          clearTimeout(t);
        } catch {
          ctx.logger.warn(`grafana-lens: OTLP endpoint unreachable at ${url} — telemetry data may be lost`);
        }
      };
      checkOtlpEndpoint(endpoints.metrics).catch(() => {});

      const { meter } = otel;

      // ── Custom metrics push tracking (Counter) ─────────────────
      const customMetricsPushedTotal = meter.createCounter("openclaw_lens_custom_metrics_pushed_total", {
        description: desc("openclaw_lens_custom_metrics_pushed_total"),
      });

      // ── Custom metrics store ─────────────────────────────────────
      if (config.customMetrics?.enabled !== false) {
        const otlpWriter = new OtlpJsonWriter({
          endpoint: endpoints.metrics,
          headers: otlpConfig.headers,
        });

        customStore = new CustomMetricsStore(
          meter,
          () => otel?.forceFlush() ?? Promise.resolve(),
          ctx.stateDir,
          ctx.logger,
          {
            maxMetrics: config.customMetrics?.maxMetrics,
            maxLabelsPerMetric: config.customMetrics?.maxLabelsPerMetric,
            maxLabelValues: config.customMetrics?.maxLabelValues,
          },
          otlpWriter,
          customMetricsPushedTotal,
        );
        await customStore.load();
        customStore.startPeriodicFlush();
        ctx.logger.info("grafana-lens: custom metrics store initialized");
      }

      // ══════════════════════════════════════════════════════════════
      // gen_ai STANDARD METRICS (Grafana Cloud AI Observability compatible)
      // ══════════════════════════════════════════════════════════════

      const tokenUsage = meter.createHistogram("gen_ai.client.token.usage", {
        description: "Measures number of input and output tokens used",
        unit: "{token}",
      });

      const operationDuration = meter.createHistogram("gen_ai.client.operation.duration", {
        description: "GenAI operation duration",
        unit: "s",
        advice: { explicitBucketBoundaries: GEN_AI_DURATION_BUCKETS },
      });

      // ══════════════════════════════════════════════════════════════
      // LIFECYCLE METRICS — session, compaction, subagent, delivery
      // ══════════════════════════════════════════════════════════════

      const sessionsStartedTotal = meter.createCounter("openclaw_lens_sessions_started_total", {
        description: desc("openclaw_lens_sessions_started_total"),
      });

      const sessionDurationMs = meter.createHistogram("openclaw_lens_session_duration_ms", {
        description: desc("openclaw_lens_session_duration_ms"),
      });

      const compactionsTotal = meter.createCounter("openclaw_lens_compactions_total", {
        description: desc("openclaw_lens_compactions_total"),
      });

      const compactionMessagesRemoved = meter.createHistogram("openclaw_lens_compaction_messages_removed", {
        description: desc("openclaw_lens_compaction_messages_removed"),
      });

      const subagentsSpawnedTotal = meter.createCounter("openclaw_lens_subagents_spawned_total", {
        description: desc("openclaw_lens_subagents_spawned_total"),
      });

      const sessionsCompleted = meter.createCounter("openclaw_lens_sessions_completed", {
        description: desc("openclaw_lens_sessions_completed"),
      });

      const subagentOutcomesTotal = meter.createCounter("openclaw_lens_subagent_outcomes_total", {
        description: desc("openclaw_lens_subagent_outcomes_total"),
      });

      const messageDeliveryTotal = meter.createCounter("openclaw_lens_message_delivery_total", {
        description: desc("openclaw_lens_message_delivery_total"),
      });

      // ── SRE tool + cost metrics ────────────────────────────────────
      const toolCallsTotal = meter.createCounter("openclaw_lens_tool_calls_total", {
        description: desc("openclaw_lens_tool_calls_total"),
      });

      const toolDurationMs = meter.createHistogram("openclaw_lens_tool_duration_ms", {
        description: desc("openclaw_lens_tool_duration_ms"),
        advice: { explicitBucketBoundaries: [10, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000] },
      });

      const subagentDurationMs = meter.createHistogram("openclaw_lens_subagent_duration_ms", {
        description: desc("openclaw_lens_subagent_duration_ms"),
        advice: { explicitBucketBoundaries: [100, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000] },
      });

      const costByModel = meter.createCounter("openclaw_lens_cost_by_model", {
        description: desc("openclaw_lens_cost_by_model"),
      });

      // ── Message type tracking (Counter) ────────────────────────
      const sessionMessageTypes = meter.createCounter("openclaw_lens_session_message_types", {
        description: desc("openclaw_lens_session_message_types"),
      });

      // ── Cost by token type (Counter) ───────────────────────────
      const costByTokenType = meter.createCounter("openclaw_lens_cost_by_token_type", {
        description: desc("openclaw_lens_cost_by_token_type"),
      });

      // ══════════════════════════════════════════════════════════════
      // SELF-SUFFICIENT COUNTERS/HISTOGRAMS — replicate diagnostics-otel
      // data so templates work without the diagnostics-otel extension
      // ══════════════════════════════════════════════════════════════

      // ── Token counter (replaces openclaw_tokens_total) ───────────
      const tokensCounter = meter.createCounter("openclaw_lens_tokens", {
        description: desc("openclaw_lens_tokens"),
      });

      // ── Messages processed (replaces openclaw_message_processed_total) ──
      const messagesProcessed = meter.createCounter("openclaw_lens_messages_processed", {
        description: desc("openclaw_lens_messages_processed"),
      });

      // ── Webhook received (replaces openclaw_webhook_received_total) ──
      const webhookReceived = meter.createCounter("openclaw_lens_webhook_received", {
        description: desc("openclaw_lens_webhook_received"),
      });

      // ── Webhook error (replaces openclaw_webhook_error_total) ────
      const webhookError = meter.createCounter("openclaw_lens_webhook_error", {
        description: desc("openclaw_lens_webhook_error"),
      });

      // ── Webhook duration (replaces openclaw_webhook_duration_ms_milliseconds) ──
      // NO unit param → avoids ugly _milliseconds suffix in Prometheus name
      const webhookDurationMs = meter.createHistogram("openclaw_lens_webhook_duration_ms", {
        description: desc("openclaw_lens_webhook_duration_ms"),
        advice: { explicitBucketBoundaries: [10, 50, 100, 250, 500, 1000, 2000, 5000, 10000] },
      });

      // ── Queue lane enqueue (replaces openclaw_queue_lane_enqueue_total) ──
      const queueLaneEnqueue = meter.createCounter("openclaw_lens_queue_lane_enqueue", {
        description: desc("openclaw_lens_queue_lane_enqueue"),
      });

      // ── Queue lane dequeue (replaces openclaw_queue_lane_dequeue_total) ──
      const queueLaneDequeue = meter.createCounter("openclaw_lens_queue_lane_dequeue", {
        description: desc("openclaw_lens_queue_lane_dequeue"),
      });

      // ── Queue wait time (replaces openclaw_queue_wait_ms_milliseconds) ──
      // NO unit param → avoids _milliseconds suffix
      const queueWaitMs = meter.createHistogram("openclaw_lens_queue_wait_ms", {
        description: desc("openclaw_lens_queue_wait_ms"),
        advice: { explicitBucketBoundaries: [10, 50, 100, 500, 1000, 5000, 10000, 30000, 60000] },
      });

      // ══════════════════════════════════════════════════════════════
      // SECURITY METRICS — detection counters for threat monitoring
      // ══════════════════════════════════════════════════════════════

      const gatewayRestarts = meter.createCounter("openclaw_lens_gateway_restarts", {
        description: desc("openclaw_lens_gateway_restarts"),
      });

      const sessionResets = meter.createCounter("openclaw_lens_session_resets", {
        description: desc("openclaw_lens_session_resets"),
      });

      const toolErrorClasses = meter.createCounter("openclaw_lens_tool_error_classes", {
        description: desc("openclaw_lens_tool_error_classes"),
      });

      const promptInjectionSignals = meter.createCounter("openclaw_lens_prompt_injection_signals", {
        description: desc("openclaw_lens_prompt_injection_signals"),
      });

      // ── Initialize lifecycle telemetry (session-scoped traces) ────
      if (otelTraces && otelLogs) {
        const lifecycleOpts: LifecycleTelemetryOpts = {
          ...(pluginVersion ? { agentVersion: pluginVersion } : {}),
          captureContent: otlpConfig.captureContent,
          contentMaxLength: otlpConfig.contentMaxLength,
          redactSecrets: otlpConfig.redactSecrets,
          costEstimator: (provider, model, usage) => {
            const configPricing = resolveModelCostFromConfig(ctx.config, provider, model);
            if (configPricing) return estimateUsageCost(configPricing, usage);
            return estimateCostFallback(provider, model, usage);
          },
        };
        lifecycle = createLifecycleTelemetry(otelTraces, otelLogs, {
          tokenUsage,
          operationDuration,
          sessionsStartedTotal,
          sessionsCompleted,
          sessionDurationMs,
          compactionsTotal,
          compactionMessagesRemoved,
          subagentsSpawnedTotal,
          subagentOutcomesTotal,
          subagentDurationMs,
          messageDeliveryTotal,
          toolCallsTotal,
          toolDurationMs,
          costByModel,
          sessionMessageTypes,
          gatewayRestarts,
          sessionResets,
          toolErrorClasses,
          promptInjectionSignals,
        }, lifecycleOpts);
        ctx.logger.info("grafana-lens: lifecycle telemetry initialized (gen_ai traces + metrics)");
      } else {
        const missing: string[] = [];
        if (!otelLogs) missing.push("otlp.logs");
        if (!otelTraces) missing.push("otlp.traces");
        ctx.logger.warn(`grafana-lens: lifecycle telemetry disabled (${missing.join(" + ")} not enabled) — session traces and gen_ai metrics will not be collected`);
      }

      // ══════════════════════════════════════════════════════════════
      // APP LOG FORWARDING (Part 3) — forward openclaw's tslog output to Loki
      // ══════════════════════════════════════════════════════════════

      if (otelLogs && otlpConfig.forwardAppLogs !== false) {
        const SEVERITY_MAP: Record<string, number> = {
          TRACE: SeverityNumber.TRACE,
          DEBUG: SeverityNumber.DEBUG,
          INFO: SeverityNumber.INFO,
          WARN: SeverityNumber.WARN,
          ERROR: SeverityNumber.ERROR,
          FATAL: SeverityNumber.FATAL,
        };

        const SEVERITY_FLOOR_MAP: Record<string, number> = {
          trace: SeverityNumber.TRACE,
          debug: SeverityNumber.DEBUG,
          info: SeverityNumber.INFO,
          warn: SeverityNumber.WARN,
          error: SeverityNumber.ERROR,
          fatal: SeverityNumber.FATAL,
        };

        const minSeverity = SEVERITY_FLOOR_MAP[otlpConfig.appLogMinSeverity ?? "debug"] ?? SeverityNumber.DEBUG;
        const shouldRedactAppLogs = otlpConfig.redactSecrets !== false;
        const appLogger = otelLogs.logger;

        try {
          unsubscribeLogTransport = registerLogTransport((logObj: unknown) => {
            try {
              const obj = logObj as Record<string, unknown>;
              const meta = obj._meta as Record<string, unknown> | undefined;

              // Parse severity from tslog's logLevelName
              const logLevelName = (meta?.logLevelName as string)?.toUpperCase() ?? "INFO";
              const severityNum = SEVERITY_MAP[logLevelName] ?? SeverityNumber.INFO;

              // Apply severity floor filter
              if (severityNum < minSeverity) return;

              // Extract message from tslog's numeric-keyed args (last string arg)
              let message = "";
              for (let i = 0; i < 10; i++) {
                const val = obj[String(i)];
                if (typeof val === "string") message = val;
                else if (val === undefined) break;
              }

              // Extract JSON bindings from first arg if it's an object
              const bindings: Record<string, unknown> = {};
              if (typeof obj["0"] === "object" && obj["0"] !== null) {
                Object.assign(bindings, obj["0"]);
              }

              // Build attributes
              const attrs: Record<string, string | number | boolean> = {
                "event.domain": "openclaw",
                "event.name": "app.log",
                "component": "app",
              };

              // tslog metadata
              if (meta?.name) attrs["openclaw.logger"] = String(meta.name);
              if (meta?.parentNames && Array.isArray(meta.parentNames)) {
                attrs["openclaw.logger.parents"] = (meta.parentNames as string[]).join(".");
              }
              if (meta?.path) {
                const path = meta.path as Record<string, unknown>;
                if (path.filePath) attrs["code.filepath"] = String(path.filePath);
                if (path.lineNumber) attrs["code.lineno"] = Number(path.lineNumber);
                if (path.functionName) attrs["code.function"] = String(path.functionName);
              }

              // Add bindings as openclaw.* attributes
              for (const [key, val] of Object.entries(bindings)) {
                if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
                  attrs[`openclaw.${key}`] = val;
                }
              }

              // Redact and emit (flatten dotted keys for Loki)
              const body = shouldRedactAppLogs ? redactSecrets(message) : message;
              appLogger.emit({
                severityNumber: severityNum,
                severityText: logLevelName,
                body,
                attributes: flattenLogKeys(attrs),
              });
            } catch {
              // Never crash the log pipeline
            }
          });

          // Emit synthetic confirmation log so Loki has at least one component="app" entry
          // immediately after startup — verifies the forwarding pipeline is working
          appLogger.emit({
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            body: "App log forwarding initialized — tslog output now streaming to Loki",
            attributes: flattenLogKeys({
              "event.domain": "openclaw",
              "event.name": "app.log_forwarding.init",
              "component": "app",
            }),
          });

          ctx.logger.info("grafana-lens: app log forwarding enabled (tslog → Loki)");
        } catch {
          ctx.logger.warn("grafana-lens: registerLogTransport not available — app log forwarding disabled");
        }
      }

      // ══════════════════════════════════════════════════════════════
      // UNIQUE INSTRUMENTS — data only grafana-lens can provide
      // (counters/histograms for tokens, cost, messages, webhooks,
      //  LLM duration are now provided by diagnostics-otel)
      // ══════════════════════════════════════════════════════════════

      // ── Safe gauge callback wrapper ─────────────────────────────
      // ObservableGauge callbacks run during the MeterProvider export cycle.
      // An unhandled throw in any callback aborts the entire batch, silencing
      // ALL gauges for that export interval. Wrap each to isolate failures.
      function safeCallback(name: string, fn: (result: ObservableResult) => void) {
        return (result: ObservableResult) => {
          try { fn(result); }
          catch (err) {
            ctx.logger.warn?.(`grafana-lens: gauge callback error (${name}): ${err instanceof Error ? err.message : err}`);
          }
        };
      }

      // ── Session state (UpDownCounter) ──────────────────────────
      const sessionsActive = meter.createUpDownCounter("openclaw_lens_sessions_active", {
        description: desc("openclaw_lens_sessions_active"),
      });

      // ── Queue depth (ObservableGauge) ──────────────────────────
      let queueDepthValue = 0;
      meter.createObservableGauge("openclaw_lens_queue_depth", {
        description: desc("openclaw_lens_queue_depth"),
      }).addCallback(safeCallback("queue_depth", (result) => {
        result.observe(queueDepthValue);
      }));

      // ── Context window usage (ObservableGauge) ─────────────────
      let contextLimit = 0;
      let contextUsed = 0;
      meter.createObservableGauge("openclaw_lens_context_tokens", {
        description: desc("openclaw_lens_context_tokens"),
      }).addCallback(safeCallback("context_tokens", (result) => {
        if (contextLimit > 0) {
          result.observe(contextLimit, { type: "limit" });
          result.observe(contextUsed, { type: "used" });
        }
      }));

      // ── Active sessions snapshot (ObservableGauge) ──────────────
      let activeSnapshot = 0;
      meter.createObservableGauge("openclaw_lens_sessions_active_snapshot", {
        description: desc("openclaw_lens_sessions_active_snapshot"),
      }).addCallback(safeCallback("sessions_active_snapshot", (result) => {
        result.observe(activeSnapshot);
      }));

      // ── Stuck sessions tracking (ObservableGauge) ──────────────
      const stuckSessions = new Map<string, number>(); // sessionKey → ageMs
      meter.createObservableGauge("openclaw_lens_sessions_stuck", {
        description: desc("openclaw_lens_sessions_stuck"),
      }).addCallback(safeCallback("sessions_stuck", (result) => {
        result.observe(stuckSessions.size);
      }));

      meter.createObservableGauge("openclaw_lens_stuck_session_max_age_ms", {
        description: desc("openclaw_lens_stuck_session_max_age_ms"),
      }).addCallback(safeCallback("stuck_session_max_age_ms", (result) => {
        const maxAge = stuckSessions.size > 0 ? Math.max(...stuckSessions.values()) : 0;
        result.observe(maxAge);
      }));

      // ── Cache read ratio (ObservableGauge) ─────────────────────
      let totalInputTokens = 0;
      let totalCacheReadTokens = 0;
      meter.createObservableGauge("openclaw_lens_cache_read_ratio", {
        description: desc("openclaw_lens_cache_read_ratio"),
      }).addCallback(safeCallback("cache_read_ratio", (result) => {
        const total = totalInputTokens + totalCacheReadTokens;
        if (total > 0) result.observe(totalCacheReadTokens / total);
      }));

      // ── Tool loop detection (ObservableGauge) ──────────────────
      const loopingSessions = new Map<string, string>(); // sessionKey → level
      meter.createObservableGauge("openclaw_lens_tool_loops_active", {
        description: desc("openclaw_lens_tool_loops_active"),
      }).addCallback(safeCallback("tool_loops_active", (result) => {
        let warning = 0;
        let critical = 0;
        for (const level of loopingSessions.values()) {
          if (level === "critical") critical++;
          else warning++;
        }
        result.observe(warning, { level: "warning" });
        result.observe(critical, { level: "critical" });
      }));

      // ── Queue lane depth (ObservableGauge) ─────────────────────
      const laneDepths = new Map<string, number>();
      meter.createObservableGauge("openclaw_lens_queue_lane_depth", {
        description: desc("openclaw_lens_queue_lane_depth"),
      }).addCallback(safeCallback("queue_lane_depth", (result) => {
        for (const [lane, depth] of laneDepths) result.observe(depth, { lane });
      }));

      // ── Alert webhook metrics (ObservableGauge — reads from alertStore) ──
      meter.createObservableGauge("openclaw_lens_alert_webhooks_received", {
        description: desc("openclaw_lens_alert_webhooks_received"),
      }).addCallback(safeCallback("alert_webhooks_received", (result) => {
        if (alertStore) {
          const received = alertStore.totalReceived();
          result.observe(received.firing, { status: "firing" });
          result.observe(received.resolved, { status: "resolved" });
        }
      }));

      meter.createObservableGauge("openclaw_lens_alert_webhooks_pending", {
        description: desc("openclaw_lens_alert_webhooks_pending"),
      }).addCallback(safeCallback("alert_webhooks_pending", (result) => {
        if (alertStore) {
          result.observe(alertStore.getPendingAlerts().length);
        }
      }));

      // ── Daily cost accumulator (ObservableGauge) ───────────────
      let dailyCostUsd = 0;
      meter.createObservableGauge("openclaw_lens_daily_cost_usd", {
        description: desc("openclaw_lens_daily_cost_usd"),
      }).addCallback(safeCallback("daily_cost_usd", (result) => {
        result.observe(dailyCostUsd);
      }));

      // Reset daily cost at midnight — schedule exactly at next midnight
      // rather than polling every 60s (avoids drift, sleep/wake issues)
      function scheduleNextMidnightReset() {
        const now = new Date();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const msUntilMidnight = tomorrow.getTime() - now.getTime() + 100; // +100ms margin
        midnightTimeout = setTimeout(() => {
          dailyCostUsd = 0;
          scheduleNextMidnightReset();
        }, msUntilMidnight);
        if (midnightTimeout.unref) midnightTimeout.unref();
      }
      scheduleNextMidnightReset();

      // ── Cache savings accumulator (ObservableGauge) ─────────────
      // Savings: difference between input pricing and cache_read pricing
      // for tokens served from cache (cache reads are ~10x cheaper)
      let cacheSavingsUsd = 0;
      let totalCacheWriteTokens = 0;
      meter.createObservableGauge("openclaw_lens_cache_savings_usd", {
        description: desc("openclaw_lens_cache_savings_usd"),
      }).addCallback(safeCallback("cache_savings_usd", (result) => {
        result.observe(cacheSavingsUsd);
      }));

      // ── Cache token ratio (ObservableGauge) ─────────────────────
      meter.createObservableGauge("openclaw_lens_cache_token_ratio", {
        description: desc("openclaw_lens_cache_token_ratio"),
      }).addCallback(safeCallback("cache_token_ratio", (result) => {
        const cacheTokens = totalCacheReadTokens + totalCacheWriteTokens;
        const allTokens = totalInputTokens + cacheTokens;
        if (allTokens > 0) result.observe(cacheTokens / allTokens);
      }));

      // ── Session latency average (ObservableGauge) ───────────────
      meter.createObservableGauge("openclaw_lens_session_latency_avg_ms", {
        description: desc("openclaw_lens_session_latency_avg_ms"),
      }).addCallback(safeCallback("session_latency_avg_ms", (result) => {
        if (lifecycle) result.observe(lifecycle.getAvgLatencyMs());
      }));

      // ── Unique sessions 1h (ObservableGauge — security) ──────────
      meter.createObservableGauge("openclaw_lens_unique_sessions_1h", {
        description: desc("openclaw_lens_unique_sessions_1h"),
      }).addCallback(safeCallback("unique_sessions_1h", (result) => {
        if (lifecycle) result.observe(lifecycle.getUniqueSessionCount1h());
      }));

      // ══════════════════════════════════════════════════════════════
      // DIAGNOSTIC EVENT HANDLER — metrics + logs + traces
      // ══════════════════════════════════════════════════════════════

      unsubscribe = onDiagnosticEvent(((evt: ExtendedDiagnosticEvent) => {
        // ── Metrics (gauge updates) ────────────────────────────────
        switch (evt.type) {
          case "model.usage": {
            // Cost resolution chain (3 tiers):
            // 1. evt.costUsd — from openclaw, most authoritative (config-driven pricing at source)
            // 2. resolveModelCostFromConfig() → estimateUsageCost() — same config, catches edge cases
            // 3. estimateCostFallback() — hardcoded pricing for common models (last resort)
            let costUsd: number | undefined;
            if (evt.costUsd != null && evt.costUsd > 0) {
              costUsd = evt.costUsd;
            } else {
              const configPricing = resolveModelCostFromConfig(ctx.config as Record<string, unknown>, evt.provider, evt.model);
              costUsd = configPricing
                ? estimateUsageCost(configPricing, evt.usage)
                : estimateCostFallback(evt.provider, evt.model, evt.usage);
            }
            if (costUsd) dailyCostUsd += costUsd;
            // Debug log when cost resolves to zero (helps trace root cause in Loki)
            if (!costUsd && otelLogs) {
              otelLogs.logger.emit({
                severityNumber: SeverityNumber.DEBUG,
                severityText: "DEBUG",
                body: `model.usage cost=0 for ${evt.model ?? "unknown"} — neither costUsd, config pricing, nor fallback resolved`,
                attributes: flattenLogKeys({
                  "event.domain": "openclaw",
                  "event.name": "cost.zero",
                  "component": "diagnostic",
                  "openclaw.model": evt.model ?? "unknown",
                  "openclaw.provider": evt.provider ?? "unknown",
                  "openclaw.cost_usd_raw": evt.costUsd ?? 0,
                }),
              });
            }
            if (evt.context?.limit !== undefined) contextLimit = evt.context.limit;
            if (evt.context?.used !== undefined) contextUsed = evt.context.used;
            if (evt.usage.input) totalInputTokens += evt.usage.input;
            if (evt.usage.cacheRead) totalCacheReadTokens += evt.usage.cacheRead;
            if (evt.usage.cacheWrite) totalCacheWriteTokens += evt.usage.cacheWrite;
            // Record per-token-type counters (self-sufficient — replaces openclaw_tokens_total)
            const tokenLabels = { provider: evt.provider ?? "unknown", model: evt.model ?? "unknown" };
            if (evt.usage.input) tokensCounter.add(evt.usage.input, { ...tokenLabels, token: "input" });
            if (evt.usage.output) tokensCounter.add(evt.usage.output, { ...tokenLabels, token: "output" });
            if (evt.usage.cacheRead) tokensCounter.add(evt.usage.cacheRead, { ...tokenLabels, token: "cacheRead" });
            if (evt.usage.cacheWrite) tokensCounter.add(evt.usage.cacheWrite, { ...tokenLabels, token: "cacheWrite" });
            // Accumulate cache savings: cache reads are ~10x cheaper than fresh input
            // savings = cacheRead * (inputPrice - cacheReadPrice) / 1M tokens
            if (evt.usage.cacheRead) {
              cacheSavingsUsd += evt.usage.cacheRead * (15 - 1.5) / 1_000_000;
            }
            // Context window pressure warning (Part 6B)
            if (otelLogs && evt.context?.used && evt.context?.limit && evt.context.limit > 0) {
              const ratio = evt.context.used / evt.context.limit;
              if (ratio > 0.8) {
                const pct = Math.round(ratio * 100);
                otelLogs.logger.emit({
                  severityNumber: SeverityNumber.WARN,
                  severityText: "WARN",
                  body: `Context window ${pct}% full (${evt.context.used}/${evt.context.limit} tokens) — compaction imminent`,
                  attributes: flattenLogKeys({
                    "event.domain": "openclaw",
                    "event.name": "context.pressure",
                    "component": "diagnostic",
                    "openclaw.context.used": evt.context.used,
                    "openclaw.context.limit": evt.context.limit,
                    "openclaw.context.ratio": ratio,
                    "openclaw.model": evt.model ?? "",
                  }),
                });
              }
            }
            // Cost is now estimated directly in onLlmOutput via costEstimator callback
            // (no longer piped via accumulateCost from diagnostic events — prevents double-counting)
            // Record per-model cost
            if (costUsd) {
              costByModel.add(costUsd, {
                model: evt.model ?? "unknown",
                provider: evt.provider ?? "unknown",
              });
            }
            // Record per-token-type cost (estimated from pricing weights)
            if (costUsd && costUsd > 0) {
              const input = evt.usage.input ?? 0;
              const output = evt.usage.output ?? 0;
              const cacheRead = evt.usage.cacheRead ?? 0;
              const cacheWrite = evt.usage.cacheWrite ?? 0;
              const wSum = (input * 15) + (output * 75) + (cacheRead * 1.5) + (cacheWrite * 18.75);
              if (wSum > 0) {
                const labels = { model: evt.model ?? "unknown", provider: evt.provider ?? "unknown" };
                if (input > 0) costByTokenType.add((input * 15 / wSum) * costUsd, { ...labels, token_type: "input" });
                if (output > 0) costByTokenType.add((output * 75 / wSum) * costUsd, { ...labels, token_type: "output" });
                if (cacheRead > 0) costByTokenType.add((cacheRead * 1.5 / wSum) * costUsd, { ...labels, token_type: "cache_read" });
                if (cacheWrite > 0) costByTokenType.add((cacheWrite * 18.75 / wSum) * costUsd, { ...labels, token_type: "cache_write" });
              }
            }
            break;
          }
          case "session.state": {
            sessionsActive.add(1, { state: evt.state });
            if (evt.prevState) sessionsActive.add(-1, { state: evt.prevState });
            if (evt.queueDepth !== undefined) queueDepthValue = evt.queueDepth;
            const clearKey = evt.sessionKey ?? evt.sessionId ?? "__unknown__";
            stuckSessions.delete(clearKey);
            loopingSessions.delete(clearKey);
            break;
          }
          case "session.stuck": {
            const stuckKey = evt.sessionKey ?? evt.sessionId ?? "__unknown__";
            stuckSessions.set(stuckKey, evt.ageMs);
            break;
          }
          case "message.processed":
            messagesProcessed.add(1, {
              outcome: (evt as Record<string, unknown>).outcome as string ?? "unknown",
              channel: (evt as Record<string, unknown>).channel as string ?? "unknown",
            });
            break;
          case "webhook.received":
            webhookReceived.add(1, {
              channel: (evt as Record<string, unknown>).channel as string ?? "unknown",
              update_type: (evt as Record<string, unknown>).updateType as string ?? "unknown",
            });
            break;
          case "webhook.processed":
            webhookDurationMs.record(
              ((evt as Record<string, unknown>).durationMs as number) ?? 0,
              {
                channel: (evt as Record<string, unknown>).channel as string ?? "unknown",
                update_type: (evt as Record<string, unknown>).updateType as string ?? "unknown",
              },
            );
            break;
          case "webhook.error":
            webhookError.add(1, {
              channel: (evt as Record<string, unknown>).channel as string ?? "unknown",
              update_type: (evt as Record<string, unknown>).updateType as string ?? "unknown",
            });
            break;
          case "diagnostic.heartbeat":
            queueDepthValue = evt.queued;
            activeSnapshot = evt.active;
            break;
          case "tool.loop": {
            const loopKey = evt.sessionKey ?? evt.sessionId ?? "__unknown__";
            loopingSessions.set(loopKey, evt.level);
            // Security: tool loops are a prompt injection indicator
            if (evt.level === "warning" || evt.level === "critical") {
              // Note: also incremented in lifecycle-telemetry.ts with detector="input_scan" (from llm_input hook pattern scan)
              promptInjectionSignals.add(1, { detector: evt.detector ?? "tool_loop" });
            }
            break;
          }
          case "queue.lane.enqueue":
            laneDepths.set(evt.lane, evt.queueSize);
            queueLaneEnqueue.add(1, { lane: evt.lane });
            break;
          case "queue.lane.dequeue":
            if (evt.queueSize === 0) laneDepths.delete(evt.lane);
            else laneDepths.set(evt.lane, evt.queueSize);
            queueLaneDequeue.add(1, { lane: evt.lane });
            queueWaitMs.record(evt.waitMs, { lane: evt.lane });
            break;
          default:
            break;
        }

        // ── Traces (agent lifecycle spans) ─────────────────────────
        let spanResult: { traceId: string; context: Context } | undefined;
        if (otelTraces) {
          spanResult = emitTraceSpan(otelTraces, evt, lifecycle);
        }

        // ── Logs (verbose structured log records) ──────────────────
        if (otelLogs) {
          emitLogRecord(otelLogs, evt, spanResult, lifecycle);
        }

        // ── Flush logs/traces for critical events (avoid batch delay data loss)
        const isCritical = evt.type === "session.state" || evt.type === "message.processed";
        if (isCritical) {
          if (otelLogs) otelLogs.forceFlush().catch(() => {});
          if (otelTraces && spanResult) otelTraces.forceFlush().catch(() => {});
        }
      }) as (evt: DiagnosticEventPayload) => void);

      // ── Check diagnostics-otel availability ────────────────────
      const ocConfig = ctx.config as Record<string, unknown>;
      const diagnostics = ocConfig.diagnostics as Record<string, unknown> | undefined;
      const otelDiag = diagnostics?.otel as Record<string, unknown> | undefined;
      if (!diagnostics?.enabled || !otelDiag?.enabled) {
        ctx.logger.info(
          "grafana-lens: diagnostics-otel is not enabled — dashboards are self-sufficient " +
          "(using openclaw_lens_* metrics). Enable diagnostics.otel for additional openclaw_* metrics.",
        );
      } else {
        ctx.logger.info("grafana-lens: diagnostics-otel detected — both openclaw_* and openclaw_lens_* metrics available");
      }

      ctx.logger.info(`grafana-lens: metrics collector started (OTLP push → ${endpoints.metrics})`);
    },

    async stop(_ctx: OpenClawPluginServiceContext) {
      if (lifecycle) {
        lifecycle.destroy();
        lifecycle = null;
      }
      if (customStore) {
        await customStore.stopPeriodicFlush();
        customStore = null;
      }
      // Unsubscribe log transport BEFORE shutting down log provider (follows diagnostics-otel order)
      if (unsubscribeLogTransport) {
        unsubscribeLogTransport();
        unsubscribeLogTransport = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      if (midnightTimeout) {
        clearTimeout(midnightTimeout);
        midnightTimeout = null;
      }
      if (otelLogs) {
        await otelLogs.shutdown();
        otelLogs = null;
      }
      if (otelTraces) {
        await otelTraces.shutdown();
        otelTraces = null;
      }
      if (otel) {
        await otel.shutdown();
        otel = null;
      }
    },
  };

  return {
    service,
    getCustomMetricsStore: () => customStore,
    getOtelTraces: () => otelTraces,
    getOtelLogs: () => otelLogs,
    getLifecycleTelemetry: () => lifecycle,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Rich log body formatting — human-readable summaries for Loki
// ══════════════════════════════════════════════════════════════════════

function formatLogBody(evt: ExtendedDiagnosticEvent): string {
  switch (evt.type) {
    case "model.usage": {
      const model = evt.model ?? "unknown";
      const dur = evt.durationMs ? `${(evt.durationMs / 1000).toFixed(1)}s` : "?s";
      const input = evt.usage.input ?? 0;
      const output = evt.usage.output ?? 0;
      const total = input + output;
      const cost = evt.costUsd ? ` | $${evt.costUsd.toFixed(2)}` : "";
      return `LLM ${model} | ${dur} | ${total.toLocaleString()}tok (${input}in+${output}out)${cost}`;
    }
    case "session.state": {
      const prev = evt.prevState ?? "?";
      const queue = evt.queueDepth !== undefined ? ` (queue=${evt.queueDepth})` : "";
      return `Session ${prev}→${evt.state}${queue}`;
    }
    case "session.stuck": {
      const age = (evt.ageMs / 1000).toFixed(1);
      return `SESSION STUCK ${evt.state} ${age}s`;
    }
    case "webhook.received":
      return `Webhook received ${evt.channel ?? "?"} (${evt.updateType ?? "?"})`;
    case "webhook.processed": {
      const dur = evt.durationMs ? ` ${evt.durationMs}ms` : "";
      return `Webhook processed ${evt.channel ?? "?"} (${evt.updateType ?? "?"})${dur}`;
    }
    case "webhook.error":
      return `Webhook ERROR ${evt.channel ?? "?"}: ${evt.error}`;
    case "message.queued": {
      const depth = evt.queueDepth !== undefined ? ` depth=${evt.queueDepth}` : "";
      return `Message queued from ${evt.source} (${evt.channel ?? "?"})${depth}`;
    }
    case "message.processed": {
      const dur = evt.durationMs ? ` ${evt.durationMs}ms` : "";
      return `Message ${evt.outcome} (${evt.channel ?? "?"})${dur}`;
    }
    case "diagnostic.heartbeat":
      return `Heartbeat: ${evt.active} active, ${evt.queued} queued, ${evt.waiting} waiting`;
    case "tool.loop":
      return `Tool loop ${evt.level.toUpperCase()} ${evt.toolName} (${evt.detector} x${evt.count}): ${evt.message}`;
    case "queue.lane.enqueue":
      return `Queue enqueue lane=${evt.lane} size=${evt.queueSize}`;
    case "queue.lane.dequeue": {
      const wait = evt.waitMs ? ` wait=${evt.waitMs}ms` : "";
      return `Queue dequeue lane=${evt.lane} size=${evt.queueSize}${wait}`;
    }
    case "run.attempt":
      return `Run attempt #${evt.attempt} (${evt.runId})`;
    default:
      return `openclaw.${(evt as { type: string }).type}`;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Log emission — verbose structured records for ALL diagnostic events
// ══════════════════════════════════════════════════════════════════════

function emitLogRecord(
  logs: OtelLogs,
  evt: ExtendedDiagnosticEvent,
  spanResult?: { traceId: string; context: Context },
  lifecycle?: LifecycleTelemetry | null,
): void {
  const base: Record<string, string | number | boolean> = {
    "event.domain": "openclaw",
    "event.name": evt.type,
    "component": "diagnostic",
  };

  // Resolve OTel context for proto-level trace correlation (Loki → Tempo click-through)
  // Belt and suspenders: both proto-level context AND string attribute for max compatibility
  let logContext: Context | undefined;
  const sessionId = "sessionId" in evt ? (evt as { sessionId?: string }).sessionId : undefined;
  const sessionKey = "sessionKey" in evt ? (evt as { sessionKey?: string }).sessionKey : undefined;
  if (lifecycle && (sessionId || sessionKey)) {
    const sessionCtx = lifecycle.getSessionContextByAny(sessionId, sessionKey);
    if (sessionCtx) {
      logContext = trace.setSpan(ROOT_CONTEXT, sessionCtx.span);
      // Keep string attr for LogQL filtering: `| trace_id = "abc"`
      base["trace_id"] = sessionCtx.span.spanContext().traceId;
      base["span_id"] = sessionCtx.span.spanContext().spanId;
    } else if (spanResult) {
      logContext = spanResult.context;
      base["trace_id"] = spanResult.traceId;
    }
  } else if (spanResult) {
    logContext = spanResult.context;
    base["trace_id"] = spanResult.traceId;
  }

  let severity = SeverityNumber.INFO;
  let severityText = "INFO";

  // ── Severity downgrades (Part 7) — reduce noise for high-volume low-value events ──
  switch (evt.type) {
    case "diagnostic.heartbeat":
    case "queue.lane.enqueue":
    case "queue.lane.dequeue":
    case "message.queued":
      severity = SeverityNumber.DEBUG;
      severityText = "DEBUG";
      break;
    case "run.attempt": {
      const attempt = (evt as { attempt?: number }).attempt ?? 1;
      if (attempt <= 1) {
        severity = SeverityNumber.DEBUG;
        severityText = "DEBUG";
      } else {
        severity = SeverityNumber.WARN;
        severityText = "WARN";
      }
      break;
    }
    default:
      break;
  }

  switch (evt.type) {
    case "model.usage":
      Object.assign(base, {
        "openclaw.provider": evt.provider ?? "",
        "openclaw.model": evt.model ?? "",
        "openclaw.channel": evt.channel ?? "",
        "openclaw.tokens.input": evt.usage.input ?? 0,
        "openclaw.tokens.output": evt.usage.output ?? 0,
        "openclaw.tokens.cache_read": evt.usage.cacheRead ?? 0,
        "openclaw.tokens.cache_write": evt.usage.cacheWrite ?? 0,
        "openclaw.tokens.total": (evt.usage.input ?? 0) + (evt.usage.output ?? 0) +
          (evt.usage.cacheRead ?? 0) + (evt.usage.cacheWrite ?? 0),
        "openclaw.cost_usd": evt.costUsd ?? 0,
        "openclaw.duration_ms": evt.durationMs ?? 0,
        "openclaw.context.limit": evt.context?.limit ?? 0,
        "openclaw.context.used": evt.context?.used ?? 0,
      });
      if (evt.sessionKey) base["openclaw.session_key"] = evt.sessionKey;
      if (evt.sessionId) base["openclaw.session_id"] = evt.sessionId;
      break;

    case "session.state":
      Object.assign(base, {
        "openclaw.state": evt.state,
        "openclaw.prev_state": evt.prevState ?? "",
        "openclaw.reason": evt.reason ?? "",
        "openclaw.queue_depth": evt.queueDepth ?? 0,
      });
      if (evt.sessionKey) base["openclaw.session_key"] = evt.sessionKey;
      if (evt.sessionId) base["openclaw.session_id"] = evt.sessionId;
      break;

    case "session.stuck":
      severity = SeverityNumber.WARN;
      severityText = "WARN";
      Object.assign(base, {
        "openclaw.state": evt.state,
        "openclaw.age_ms": evt.ageMs,
        "openclaw.queue_depth": evt.queueDepth ?? 0,
      });
      if (evt.sessionKey) base["openclaw.session_key"] = evt.sessionKey;
      if (evt.sessionId) base["openclaw.session_id"] = evt.sessionId;
      break;

    case "webhook.received": {
      const whRecv = evt as typeof evt & { chatId?: string };
      Object.assign(base, {
        "openclaw.channel": evt.channel ?? "",
        "openclaw.update_type": evt.updateType ?? "",
        ...(whRecv.chatId ? { "openclaw.chat_id": whRecv.chatId } : {}),
      });
      break;
    }

    case "webhook.processed": {
      const whProc = evt as typeof evt & { chatId?: string };
      Object.assign(base, {
        "openclaw.channel": evt.channel ?? "",
        "openclaw.update_type": evt.updateType ?? "",
        "openclaw.duration_ms": evt.durationMs ?? 0,
        ...(whProc.chatId ? { "openclaw.chat_id": whProc.chatId } : {}),
      });
      break;
    }

    case "webhook.error": {
      severity = SeverityNumber.ERROR;
      severityText = "ERROR";
      const whErr = evt as typeof evt & { chatId?: string };
      Object.assign(base, {
        "openclaw.channel": evt.channel ?? "",
        "openclaw.update_type": evt.updateType ?? "",
        "openclaw.error": evt.error,
        ...(whErr.chatId ? { "openclaw.chat_id": whErr.chatId } : {}),
      });
      break;
    }

    case "message.queued": {
      const mqEvt = evt as typeof evt & { sessionId?: string; sessionKey?: string };
      Object.assign(base, {
        "openclaw.source": evt.source,
        "openclaw.channel": evt.channel ?? "",
        "openclaw.queue_depth": evt.queueDepth ?? 0,
      });
      if (mqEvt.sessionId) base["openclaw.session_id"] = mqEvt.sessionId;
      if (mqEvt.sessionKey) base["openclaw.session_key"] = mqEvt.sessionKey;
      break;
    }

    case "message.processed": {
      const isError = evt.outcome === "error";
      if (isError) {
        severity = SeverityNumber.ERROR;
        severityText = "ERROR";
      }
      const mpEvt = evt as typeof evt & { sessionId?: string; sessionKey?: string };
      Object.assign(base, {
        "openclaw.outcome": evt.outcome,
        "openclaw.channel": evt.channel ?? "",
        "openclaw.duration_ms": evt.durationMs ?? 0,
      });
      if (mpEvt.sessionId) base["openclaw.session_id"] = mpEvt.sessionId;
      if (mpEvt.sessionKey) base["openclaw.session_key"] = mpEvt.sessionKey;
      break;
    }

    case "diagnostic.heartbeat":
      Object.assign(base, {
        "openclaw.active": evt.active,
        "openclaw.waiting": evt.waiting,
        "openclaw.queued": evt.queued,
        "openclaw.webhooks_received": evt.webhooks.received ?? 0,
        "openclaw.webhooks_processed": evt.webhooks.processed ?? 0,
      });
      break;

    case "tool.loop": {
      severity = evt.level === "critical" ? SeverityNumber.ERROR : SeverityNumber.WARN;
      severityText = evt.level === "critical" ? "ERROR" : "WARN";
      Object.assign(base, {
        "openclaw.tool_name": evt.toolName,
        "openclaw.paired_tool_name": evt.pairedToolName ?? "",
        "openclaw.level": evt.level,
        "openclaw.action": evt.action,
        "openclaw.detector": evt.detector,
        "openclaw.count": evt.count,
        "openclaw.message": evt.message,
      });
      if (evt.sessionKey) base["openclaw.session_key"] = evt.sessionKey;
      if (evt.sessionId) base["openclaw.session_id"] = evt.sessionId;
      break;
    }

    case "queue.lane.enqueue":
      Object.assign(base, {
        "openclaw.lane": evt.lane,
        "openclaw.queue_size": evt.queueSize,
      });
      break;

    case "queue.lane.dequeue":
      Object.assign(base, {
        "openclaw.lane": evt.lane,
        "openclaw.queue_size": evt.queueSize,
        "openclaw.wait_ms": evt.waitMs,
      });
      break;

    case "run.attempt":
      Object.assign(base, {
        "openclaw.run_id": evt.runId,
        "openclaw.attempt": evt.attempt,
      });
      break;

    default:
      break;
  }

  // Flatten dotted keys → underscores for Loki structured metadata compatibility
  logs.logger.emit({
    severityNumber: severity,
    severityText,
    body: formatLogBody(evt),
    attributes: flattenLogKeys(base),
    ...(logContext ? { context: logContext } : {}),
  });
}

// ══════════════════════════════════════════════════════════════════════
// Trace emission — agent lifecycle spans for key events
// ══════════════════════════════════════════════════════════════════════

function emitTraceSpan(
  traces: OtelTraces,
  evt: ExtendedDiagnosticEvent,
  lifecycle?: LifecycleTelemetry | null,
): { traceId: string; context: Context } | undefined {
  // Helper: resolve parent context from session trace (or ROOT_CONTEXT fallback)
  function resolveParentCtx(): import("@opentelemetry/api").Context {
    if (!lifecycle) return ROOT_CONTEXT;
    const sessionId = "sessionId" in evt ? (evt as { sessionId?: string }).sessionId : undefined;
    const sessionKey = "sessionKey" in evt ? (evt as { sessionKey?: string }).sessionKey : undefined;
    if (sessionId || sessionKey) {
      const sessionCtx = lifecycle.getSessionContextByAny(sessionId, sessionKey);
      if (sessionCtx) return sessionCtx.ctx;
    }
    return ROOT_CONTEXT;
  }

  switch (evt.type) {
    // model.usage: REMOVED — lifecycle telemetry creates `chat {model}` spans from llm_output hook

    // REMOVED: session.state, message.processed, webhook.processed, webhook.error, session.stuck
    // — session.state transitions are already logged via emitLogRecord() (available in Loki).
    //   Creating trace spans for state transitions produced orphaned root spans in Tempo
    //   with NaN duration that drowned out meaningful invoke_agent traces.
    // — diagnostics-otel (global NodeSDK) already creates flat spans for the other events.
    // Keeping only tool.loop which is unique to grafana-lens
    // (session-parented span with richer context).

    case "tool.loop": {
      const now = Date.now();
      const parentCtx = resolveParentCtx();
      const span = traces.tracer.startSpan(`openclaw.tool.loop ${evt.toolName}`, {
        kind: SpanKind.INTERNAL,
        startTime: now,
        attributes: {
          "openclaw.tool_name": evt.toolName,
          "openclaw.level": evt.level,
          "openclaw.action": evt.action,
          "openclaw.detector": evt.detector,
          "openclaw.count": evt.count,
          "openclaw.message": evt.message,
        },
      }, parentCtx);
      if (evt.level === "critical") {
        span.setStatus({ code: SpanStatusCode.ERROR, message: evt.message });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end(now);
      return { traceId: span.spanContext().traceId, context: trace.setSpan(ROOT_CONTEXT, span) };
    }

    default:
      return undefined;
  }
}
