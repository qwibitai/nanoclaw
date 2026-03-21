/**
 * grafana_investigate tool
 *
 * Multi-signal investigation triage: gathers metrics, logs, traces, and context
 * signals in parallel, then generates hypothesis suggestions with specific
 * tool+params for follow-up.
 *
 * Design: This is a "first step" accelerator — use it to quickly gather
 * evidence across all signal types, then follow up with individual tools
 * (grafana_query, grafana_query_logs, grafana_query_traces) for deep-dives.
 *
 * Follows the same resilient pattern as grafana_security_check:
 * Promise.allSettled for graceful degradation when signal sources are unavailable.
 */

import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import type { DatasourceListItem } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import type { AlertStore } from "../services/alert-webhook.js";

/** Lookback windows mapped to step sizes for range queries. */
const WINDOW_CONFIG: Record<string, { seconds: number; step: string }> = {
  "1h": { seconds: 3600, step: "60" },
  "6h": { seconds: 21600, step: "300" },
  "24h": { seconds: 86400, step: "900" },
};

const PLAIN_METRIC_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

interface MetricSignals {
  focus?: {
    current?: string;
    trend?: Array<{ time: string; value: string }>;
    anomalyScore?: number;
    anomalySeverity?: string;
  };
  red?: {
    rate?: string;
    errorRate?: string;
    p95Latency?: string;
  };
}

interface LogSignals {
  totalVolume: number;
  errorCount: number;
  bySeverity: Record<string, number>;
  topPatterns: Array<{ pattern: string; count: number }>;
  sampleErrors: Array<{ timestamp: string; line: string }>;
}

interface TraceSignals {
  errorTraces: Array<{ traceId: string; rootService: string; rootSpan: string; durationMs: number }>;
  slowTraces: Array<{ traceId: string; rootService: string; rootSpan: string; durationMs: number }>;
}

interface ContextSignals {
  recentAnnotations: Array<{ text: string; tags: string[]; time: string }>;
  alertsActive: Array<{ title: string; status: string; since: string }>;
}

interface Hypothesis {
  hypothesis: string;
  evidence: string;
  confidence: "low" | "medium" | "high";
  testWith: { tool: string; params: Record<string, unknown> };
}

export function createInvestigateToolFactory(
  config: ValidatedGrafanaLensConfig,
  store: AlertStore,
) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_investigate",
    label: "Investigate",
    description: [
      "WORKFLOW: Use as the FIRST step for investigating alerts, errors, anomalies, or any 'what's wrong?' question.",
      "Gathers multi-signal evidence in parallel (metrics, logs, traces, annotations, active alerts) and generates hypothesis suggestions with specific tool+params for follow-up.",
      "Each hypothesis includes a `testWith` field with the exact tool name and parameters to test it — use these for deep-dives.",
      "Focus can be an alert UID, metric name, or free-text symptom description.",
      "Gracefully degrades when Loki or Tempo datasources are unavailable — you still get metrics and context signals.",
      "After investigating, use grafana_annotate to mark findings and grafana_check_alerts to acknowledge alerts.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        focus: {
          type: "string",
          description: "Alert UID, metric name, or symptom description (e.g., 'alert-abc', 'openclaw_lens_daily_cost_usd', 'high error rate')",
        },
        timeWindow: {
          type: "string",
          enum: Object.keys(WINDOW_CONFIG),
          description: "Lookback window. Default: '1h'. Use '6h' for broader context, '24h' for daily patterns.",
        },
        service: {
          type: "string",
          description: "Filter logs/traces to a specific service name. Default: 'openclaw'.",
        },
      },
      required: ["focus"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const focus = readStringParam(params, "focus", { required: true, label: "Focus" });
      const timeWindow = readStringParam(params, "timeWindow") ?? "1h";
      const service = readStringParam(params, "service") ?? "openclaw";

      const windowCfg = WINDOW_CONFIG[timeWindow];
      if (!windowCfg) {
        return jsonResult({ error: `Invalid timeWindow '${timeWindow}' — use '1h', '6h', or '24h'` });
      }

      const nowMs = Date.now();
      const fromMs = nowMs - windowCfg.seconds * 1000;
      const nowSec = Math.floor(nowMs / 1000);
      const fromSec = nowSec - windowCfg.seconds;

      try {
        // ── Step 1: Auto-discover datasources ──────────────────────────
        const datasources = await client.listDatasources();
        const promDs = datasources.find((d: DatasourceListItem) => d.type === "prometheus");
        const lokiDs = datasources.find((d: DatasourceListItem) => d.type === "loki");
        const tempoDs = datasources.find((d: DatasourceListItem) => d.type === "tempo");

        if (!promDs) {
          return jsonResult({
            error: "No Prometheus datasource found — investigation requires at least Prometheus. Use grafana_explore_datasources to verify.",
          });
        }

        // ── Step 2: Resolve focus ────────────────────────────────────
        const isMetricFocus = PLAIN_METRIC_RE.test(focus);
        // Check if focus matches an alert in the store
        const pendingAlerts = store.getPendingAlerts();
        const matchingAlert = pendingAlerts.find((a) => a.id === focus);
        const focusExpr = isMetricFocus ? focus : undefined;
        const logSearchTerm = isMetricFocus ? undefined : focus;

        // ── Step 3: Gather all signals in parallel ────────────────────
        const metricPromises = gatherMetricSignals(promDs.uid, focusExpr, windowCfg, nowSec, fromSec);
        const logPromise = lokiDs
          ? gatherLogSignals(lokiDs.uid, service, logSearchTerm, timeWindow, fromMs, nowMs)
          : Promise.resolve(null);
        const tracePromise = tempoDs
          ? gatherTraceSignals(tempoDs.uid, service, timeWindow, fromMs, nowMs)
          : Promise.resolve(null);
        const contextPromise = gatherContextSignals(fromMs, nowMs);

        const [metricResult, logResult, traceResult, contextResult] = await Promise.allSettled([
          metricPromises,
          logPromise,
          tracePromise,
          contextPromise,
        ]);

        // ── Step 4: Extract results with graceful degradation ────────
        const metricSignals = metricResult.status === "fulfilled" ? metricResult.value : undefined;
        const logSignals = logResult.status === "fulfilled" ? logResult.value : undefined;
        const traceSignals = traceResult.status === "fulfilled" ? traceResult.value : undefined;
        const contextSignals = contextResult.status === "fulfilled" ? contextResult.value : undefined;

        // ── Step 5: Generate hypotheses ──────────────────────────────
        const hypotheses = generateHypotheses({
          focus,
          focusExpr,
          matchingAlert,
          metricSignals,
          logSignals,
          traceSignals,
          contextSignals,
          promDsUid: promDs.uid,
          lokiDsUid: lokiDs?.uid,
          tempoDsUid: tempoDs?.uid,
          service,
        });

        // ── Step 6: Build limitations list ───────────────────────────
        const limitations: string[] = [];
        if (!lokiDs) limitations.push("No Loki datasource found — log signals unavailable");
        if (!tempoDs) limitations.push("No Tempo datasource found — trace signals unavailable");
        if (metricResult.status === "rejected") limitations.push(`Metric queries failed: ${metricResult.reason instanceof Error ? metricResult.reason.message : String(metricResult.reason)}`);
        if (logResult.status === "rejected") limitations.push(`Log queries failed: ${logResult.reason instanceof Error ? logResult.reason.message : String(logResult.reason)}`);
        if (traceResult.status === "rejected") limitations.push(`Trace queries failed: ${traceResult.reason instanceof Error ? traceResult.reason.message : String(traceResult.reason)}`);

        return jsonResult({
          timeWindow: {
            from: new Date(fromMs).toISOString(),
            to: new Date(nowMs).toISOString(),
            duration: timeWindow,
          },
          focus,
          ...(metricSignals ? { metricSignals } : {}),
          ...(logSignals ? { logSignals } : {}),
          ...(traceSignals ? { traceSignals } : {}),
          ...(contextSignals ? { contextSignals } : {}),
          suggestedHypotheses: hypotheses,
          limitations,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Investigation failed: ${reason}` });
      }
    },
  });

  // ── Signal gathering functions ─────────────────────────────────────

  async function gatherMetricSignals(
    promDsUid: string,
    focusExpr: string | undefined,
    windowCfg: { seconds: number; step: string },
    nowSec: number,
    fromSec: number,
  ): Promise<MetricSignals> {
    const signals: MetricSignals = {};

    if (focusExpr) {
      // Query the focused metric
      const [instantResult, rangeResult] = await Promise.allSettled([
        client.queryPrometheus(promDsUid, focusExpr),
        client.queryPrometheusRange(promDsUid, focusExpr, String(fromSec), String(nowSec), windowCfg.step),
      ]);

      const focusData: MetricSignals["focus"] = {};

      if (instantResult.status === "fulfilled") {
        const first = instantResult.value.data.result[0];
        if (first) focusData.current = first.value[1];
      }

      if (rangeResult.status === "fulfilled") {
        const series = rangeResult.value.data.result[0];
        if (series && series.values.length > 0) {
          // Sample max 10 points for context efficiency
          const step = Math.max(1, Math.floor(series.values.length / 10));
          focusData.trend = series.values
            .filter((_: unknown, i: number) => i % step === 0 || i === series.values.length - 1)
            .map(([ts, v]: [number, string]) => ({
              time: new Date(ts * 1000).toISOString(),
              value: v,
            }));
        }
      }

      // Anomaly scoring against 7d baseline
      const [avgResult, stddevResult] = await Promise.allSettled([
        client.queryPrometheus(promDsUid, `avg_over_time(${focusExpr}[7d])`),
        client.queryPrometheus(promDsUid, `stddev_over_time(${focusExpr}[7d])`),
      ]);

      if (avgResult.status === "fulfilled" && stddevResult.status === "fulfilled") {
        const avgVal = avgResult.value.data.result[0]?.value[1];
        const stddevVal = stddevResult.value.data.result[0]?.value[1];
        if (avgVal && stddevVal && focusData.current) {
          const avg = parseFloat(avgVal);
          const stddev = parseFloat(stddevVal);
          const current = parseFloat(focusData.current);
          const zScore = Math.abs((current - avg) / (stddev + 1e-10));
          focusData.anomalyScore = parseFloat(zScore.toFixed(2));
          focusData.anomalySeverity = zScore >= 3 ? "critical" : zScore >= 2 ? "significant" : zScore >= 1.5 ? "mild" : "normal";
        }
      }

      if (Object.keys(focusData).length > 0) signals.focus = focusData;
    }

    // RED signals (always query these for general health context)
    const [rateResult, errorRateResult, p95Result] = await Promise.allSettled([
      client.queryPrometheus(promDsUid, "sum(rate(openclaw_lens_messages_processed_total[5m])) or vector(0)"),
      client.queryPrometheus(promDsUid, "sum(rate(openclaw_lens_messages_processed_total{outcome=\"error\"}[5m])) / (sum(rate(openclaw_lens_messages_processed_total[5m])) + 0.001)"),
      client.queryPrometheus(promDsUid, "histogram_quantile(0.95, sum(rate(gen_ai_client_operation_duration_seconds_bucket[5m])) by (le))"),
    ]);

    const red: MetricSignals["red"] = {};
    if (rateResult.status === "fulfilled") {
      red.rate = rateResult.value.data.result[0]?.value[1];
    }
    if (errorRateResult.status === "fulfilled") {
      red.errorRate = errorRateResult.value.data.result[0]?.value[1];
    }
    if (p95Result.status === "fulfilled") {
      red.p95Latency = p95Result.value.data.result[0]?.value[1];
    }
    if (Object.keys(red).length > 0) signals.red = red;

    return signals;
  }

  async function gatherLogSignals(
    lokiDsUid: string,
    service: string,
    searchTerm: string | undefined,
    timeWindow: string,
    fromMs: number,
    nowMs: number,
  ): Promise<LogSignals> {
    const fromNs = String(fromMs * 1_000_000);
    const toNs = String(nowMs * 1_000_000);

    // Statistics-first: volume, severity breakdown, top patterns, then samples
    const baseSelector = `{service_name="${service}"}`;
    const errorFilter = searchTerm
      ? `${baseSelector} | json | level="ERROR" |= "${searchTerm.replace(/"/g, '\\"')}"`
      : `${baseSelector} | json | level="ERROR"`;

    const [volumeResult, severityResult, sampleResult] = await Promise.allSettled([
      client.queryLokiRange(lokiDsUid,
        `sum(count_over_time(${baseSelector}[${timeWindow}]))`,
        fromNs, toNs, { limit: 1 }),
      client.queryLokiRange(lokiDsUid,
        `sum by (level) (count_over_time(${baseSelector} | json [${timeWindow}]))`,
        fromNs, toNs, { limit: 10 }),
      client.queryLokiRange(lokiDsUid,
        errorFilter,
        fromNs, toNs, { limit: 5, direction: "backward" }),
    ]);

    const signals: LogSignals = {
      totalVolume: 0,
      errorCount: 0,
      bySeverity: {},
      topPatterns: [],
      sampleErrors: [],
    };

    // Volume
    if (volumeResult.status === "fulfilled") {
      const result = volumeResult.value as { data?: { result?: Array<{ values?: Array<[string, string]> }> } };
      const firstStream = result?.data?.result?.[0];
      if (firstStream?.values?.length) {
        signals.totalVolume = parseInt(firstStream.values[firstStream.values.length - 1][1], 10) || 0;
      }
    }

    // Severity breakdown
    if (severityResult.status === "fulfilled") {
      const result = severityResult.value as { data?: { result?: Array<{ metric?: Record<string, string>; values?: Array<[string, string]> }> } };
      if (result?.data?.result) {
        for (const stream of result.data.result) {
          const level = stream.metric?.level ?? "unknown";
          const lastVal = stream.values?.length ? parseInt(stream.values[stream.values.length - 1][1], 10) : 0;
          signals.bySeverity[level] = lastVal || 0;
          if (level === "ERROR" || level === "error") {
            signals.errorCount = lastVal || 0;
          }
        }
      }
    }

    // Sample errors
    if (sampleResult.status === "fulfilled") {
      const result = sampleResult.value as { data?: { result?: Array<{ values?: Array<[string, string]> }> } };
      if (result?.data?.result) {
        for (const stream of result.data.result) {
          if (stream.values) {
            for (const [ts, line] of stream.values) {
              signals.sampleErrors.push({
                timestamp: new Date(parseInt(ts, 10) / 1_000_000).toISOString(),
                line: line.length > 200 ? line.slice(0, 200) + "…" : line,
              });
            }
          }
        }
        signals.sampleErrors = signals.sampleErrors.slice(0, 5);
      }
    }

    return signals;
  }

  async function gatherTraceSignals(
    tempoDsUid: string,
    service: string,
    _timeWindow: string,
    fromMs: number,
    nowMs: number,
  ): Promise<TraceSignals> {
    const fromSec = String(Math.floor(fromMs / 1000));
    const toSec = String(Math.floor(nowMs / 1000));

    const [errorResult, slowResult] = await Promise.allSettled([
      client.searchTraces(tempoDsUid,
        `{ resource.service.name = "${service}" && status = error }`,
        { start: fromSec, end: toSec, limit: 5 }),
      client.searchTraces(tempoDsUid,
        `{ resource.service.name = "${service}" && duration > 10s }`,
        { start: fromSec, end: toSec, limit: 5 }),
    ]);

    const mapTraces = (result: PromiseSettledResult<{ traces: Array<{ traceID: string; rootServiceName: string; rootTraceName: string; durationMs: number }> }>) => {
      if (result.status !== "fulfilled") return [];
      return result.value.traces.map((t) => ({
        traceId: t.traceID,
        rootService: t.rootServiceName,
        rootSpan: t.rootTraceName,
        durationMs: t.durationMs,
      }));
    };

    return {
      errorTraces: mapTraces(errorResult),
      slowTraces: mapTraces(slowResult),
    };
  }

  async function gatherContextSignals(fromMs: number, nowMs: number): Promise<ContextSignals> {
    const [annotationsResult] = await Promise.allSettled([
      client.getAnnotations({ from: fromMs, to: nowMs, limit: 10 }),
    ]);

    const recentAnnotations = annotationsResult.status === "fulfilled"
      ? annotationsResult.value.map((a) => ({
          text: a.text,
          tags: a.tags,
          time: new Date(a.time).toISOString(),
        }))
      : [];

    const pending = store.getPendingAlerts();
    const alertsActive = pending.map((a) => ({
      title: a.title,
      status: a.status,
      since: new Date(a.receivedAt).toISOString(),
    }));

    return { recentAnnotations, alertsActive };
  }
}

// ── Hypothesis generation ─────────────────────────────────────────────

interface HypothesisContext {
  focus: string;
  focusExpr: string | undefined;
  matchingAlert: { title: string; id: string } | undefined;
  metricSignals: MetricSignals | undefined;
  logSignals: LogSignals | null | undefined;
  traceSignals: TraceSignals | null | undefined;
  contextSignals: ContextSignals | undefined;
  promDsUid: string;
  lokiDsUid: string | undefined;
  tempoDsUid: string | undefined;
  service: string;
}

function generateHypotheses(ctx: HypothesisContext): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];

  // H1: Error spike + recent annotation → deployment may have caused issues
  if (ctx.logSignals?.errorCount && ctx.logSignals.errorCount > 0 && ctx.contextSignals?.recentAnnotations?.length) {
    const recentAnnotation = ctx.contextSignals.recentAnnotations[0];
    hypotheses.push({
      hypothesis: `Recent event "${recentAnnotation.text}" may have caused the error increase`,
      evidence: `${ctx.logSignals.errorCount} errors found, annotation "${recentAnnotation.text}" at ${recentAnnotation.time}`,
      confidence: "medium",
      testWith: {
        tool: "grafana_query",
        params: {
          datasourceUid: ctx.promDsUid,
          expr: `sum(rate(openclaw_lens_messages_processed_total{outcome="error"}[5m]))`,
          queryType: "range",
          start: recentAnnotation.time,
        },
      },
    });
  }

  // H2: High latency + context pressure → context window saturation
  const p95 = ctx.metricSignals?.red?.p95Latency ? parseFloat(ctx.metricSignals.red.p95Latency) : 0;
  if (p95 > 10) {
    hypotheses.push({
      hypothesis: "High LLM latency may indicate context window saturation or provider throttling",
      evidence: `P95 latency is ${p95.toFixed(1)}s (>10s threshold)`,
      confidence: "medium",
      testWith: {
        tool: "grafana_query",
        params: {
          datasourceUid: ctx.promDsUid,
          expr: "openclaw_lens_context_tokens{type=\"used\"} / openclaw_lens_context_tokens{type=\"limit\"} * 100",
        },
      },
    });
  }

  // H3: Error rate is elevated
  const errorRate = ctx.metricSignals?.red?.errorRate ? parseFloat(ctx.metricSignals.red.errorRate) : 0;
  if (errorRate > 0.01) {
    hypotheses.push({
      hypothesis: `Error rate is elevated at ${(errorRate * 100).toFixed(1)}%`,
      evidence: `Error rate: ${(errorRate * 100).toFixed(1)}%, message rate: ${ctx.metricSignals?.red?.rate ?? "unknown"}`,
      confidence: "high",
      testWith: ctx.lokiDsUid
        ? {
            tool: "grafana_query_logs",
            params: {
              datasourceUid: ctx.lokiDsUid,
              expr: `topk(10, sum by (event_name) (count_over_time({service_name="${ctx.service}"} | json | level="ERROR" [1h])))`,
            },
          }
        : {
            tool: "grafana_query",
            params: {
              datasourceUid: ctx.promDsUid,
              expr: `sum by (outcome) (rate(openclaw_lens_messages_processed_total[5m]))`,
            },
          },
    });
  }

  // H4: Anomaly detected on focus metric
  if (ctx.metricSignals?.focus?.anomalyScore && ctx.metricSignals.focus.anomalyScore >= 2) {
    hypotheses.push({
      hypothesis: `Focus metric shows ${ctx.metricSignals.focus.anomalySeverity} anomaly (${ctx.metricSignals.focus.anomalyScore}σ from baseline)`,
      evidence: `Current: ${ctx.metricSignals.focus.current}, z-score: ${ctx.metricSignals.focus.anomalyScore}σ`,
      confidence: ctx.metricSignals.focus.anomalyScore >= 3 ? "high" : "medium",
      testWith: {
        tool: "grafana_explain_metric",
        params: {
          datasourceUid: ctx.promDsUid,
          expr: ctx.focusExpr ?? ctx.focus,
          period: "24h",
        },
      },
    });
  }

  // H5: Error traces available → specific request paths failing
  if (ctx.traceSignals?.errorTraces && ctx.traceSignals.errorTraces.length > 0) {
    const trace = ctx.traceSignals.errorTraces[0];
    hypotheses.push({
      hypothesis: `Specific request paths are failing — ${ctx.traceSignals.errorTraces.length} error trace(s) found`,
      evidence: `Error trace: ${trace.rootSpan} (${trace.durationMs}ms) in ${trace.rootService}`,
      confidence: "high",
      testWith: ctx.tempoDsUid
        ? {
            tool: "grafana_query_traces",
            params: {
              datasourceUid: ctx.tempoDsUid,
              traceId: trace.traceId,
              queryType: "get",
            },
          }
        : {
            tool: "grafana_query",
            params: {
              datasourceUid: ctx.promDsUid,
              expr: `sum by (tool) (rate(openclaw_lens_tool_error_classes_total[5m]))`,
            },
          },
    });
  }

  // H6: Slow traces → performance degradation
  if (ctx.traceSignals?.slowTraces && ctx.traceSignals.slowTraces.length > 0 && hypotheses.length < 5) {
    const trace = ctx.traceSignals.slowTraces[0];
    hypotheses.push({
      hypothesis: `Performance degradation — ${ctx.traceSignals.slowTraces.length} slow trace(s) found (>10s)`,
      evidence: `Slow trace: ${trace.rootSpan} (${trace.durationMs}ms) in ${trace.rootService}`,
      confidence: "medium",
      testWith: ctx.tempoDsUid
        ? {
            tool: "grafana_query_traces",
            params: {
              datasourceUid: ctx.tempoDsUid,
              traceId: trace.traceId,
              queryType: "get",
            },
          }
        : {
            tool: "grafana_query",
            params: {
              datasourceUid: ctx.promDsUid,
              expr: "histogram_quantile(0.95, sum by (le, gen_ai_request_model) (rate(gen_ai_client_operation_duration_seconds_bucket[5m])))",
            },
          },
    });
  }

  // H7: Active alerts suggest ongoing issues
  if (ctx.contextSignals?.alertsActive && ctx.contextSignals.alertsActive.length > 0 && !ctx.matchingAlert) {
    hypotheses.push({
      hypothesis: `${ctx.contextSignals.alertsActive.length} active alert(s) may be related to the investigation`,
      evidence: ctx.contextSignals.alertsActive.map((a) => `${a.title} (${a.status} since ${a.since})`).join("; "),
      confidence: "low",
      testWith: {
        tool: "grafana_check_alerts",
        params: { action: "list" },
      },
    });
  }

  // If no hypotheses generated, provide generic investigation path
  if (hypotheses.length === 0) {
    hypotheses.push({
      hypothesis: "No clear anomaly detected — investigate further with focused queries",
      evidence: "All metric signals within normal range, no error traces found",
      confidence: "low",
      testWith: {
        tool: "grafana_explain_metric",
        params: {
          datasourceUid: ctx.promDsUid,
          expr: ctx.focusExpr ?? "openclaw_lens_daily_cost_usd",
          period: "24h",
        },
      },
    });
  }

  return hypotheses;
}
