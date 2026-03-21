/**
 * grafana_push_metrics tool
 *
 * Four actions in one tool:
 *   - push (default): Push data points into Prometheus via custom metrics
 *   - register: Pre-register a metric with explicit schema
 *   - list: List all custom metrics
 *   - delete: Remove a custom metric
 *
 * This is the bridge that turns Grafana into a general-purpose analytics
 * platform. Once data is pushed, all existing tools (query, dashboard,
 * alert, share, annotate) work on it automatically.
 */

import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { normalizeMetricName, getPromQLName, type CustomMetricsStore, type CustomMetricDataPoint, type MetricType } from "../services/custom-metrics-store.js";

// ── Workflow suggestions ────────────────────────────────────────────

interface WorkflowStep {
  tool: string;
  action: string;
  example: Record<string, unknown>;
}

/**
 * Build concrete next-step suggestions from the actual pushed/registered metric names.
 * Uses the first queryName as the representative metric for examples.
 */
function buildPushWorkflow(queryNames: Record<string, string>): WorkflowStep[] {
  const names = Object.values(queryNames);
  if (names.length === 0) return [];

  const representative = names[0];
  const steps: WorkflowStep[] = [
    {
      tool: "grafana_query",
      action: "Verify data landed",
      example: { expr: representative },
    },
    {
      tool: "grafana_create_dashboard",
      action: "Visualize with a dashboard",
      example: { template: "metric-explorer", variables: { metric: representative } },
    },
  ];

  // Only suggest alerts for single-metric pushes (multi-metric threshold is ambiguous)
  if (names.length === 1) {
    steps.push({
      tool: "grafana_create_alert",
      action: "Monitor with an alert",
      example: { name: `${representative} alert`, expr: representative, condition: "gt", threshold: "<set_threshold>" },
    });
  }

  return steps;
}

function buildRegisterWorkflow(normalizedName: string, queryName: string, type: MetricType, labelNames: string[]): WorkflowStep[] {
  const metricsEntry: Record<string, unknown> = { name: normalizedName, value: 0 };
  if (labelNames.length > 0) {
    const labelsExample: Record<string, string> = {};
    for (const l of labelNames) labelsExample[l] = `<${l}>`;
    metricsEntry.labels = labelsExample;
  }

  const steps: WorkflowStep[] = [
    {
      tool: "grafana_push_metrics",
      action: "Push data points",
      example: { metrics: [metricsEntry] },
    },
    {
      tool: "grafana_query",
      action: "Query the metric",
      example: { expr: type === "counter" ? `rate(${queryName}[5m])` : queryName },
    },
  ];

  return steps;
}

export function createPushMetricsToolFactory(
  _config: ValidatedGrafanaLensConfig,
  getCustomMetricsStore: () => CustomMetricsStore | null,
) {
  return (_ctx: unknown) => ({
    name: "grafana_push_metrics",
    label: "Grafana Push Metrics",
    description: [
      "Push custom data (calendar, git, fitness, finance, IoT) via OTLP for visualization in Grafana.",
      "WORKFLOW: Use action 'push' (default) to write data points — auto-registers metrics if needed.",
      "Use action 'register' to pre-register a metric with explicit labels/type/TTL.",
      "Use action 'list' to see all custom metrics. Use action 'delete' to remove a metric.",
      "All metric names get the 'openclaw_ext_' prefix (auto-prepended if missing).",
      "Gauge (default): last value wins — use for snapshots like 'steps today = 8000', 'weight = 72.5'. Counter: value accumulates (each push adds to total) and gets '_total' PromQL suffix — use only for incremental event counts like 'api_calls += 1'. Most life-dashboard metrics are gauges.",
      "Supports historical backfill: add 'timestamp' (ISO 8601, e.g. '2025-01-15') to any gauge data point to record it at that time instead of now. Batch multiple timestamps in one call for multi-day backfill.",
      "Response includes 'queryNames' with exact PromQL names and 'suggestedWorkflow' with concrete next-step examples (verify, visualize, alert). Data available immediately — all tools (query, dashboard, alert, share) work on pushed data.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["push", "register", "list", "delete"],
          description: "Action to perform. Default: 'push'",
        },
        metrics: {
          type: "array",
          description: "Array of data points to push (action 'push'). Each: { name, value, labels?, type?, help? }",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Metric name (openclaw_ext_ prefix auto-added if missing)" },
              value: { type: "number", description: "Numeric value" },
              labels: { type: "object", description: "Optional key-value labels (e.g., { region: 'us' })" },
              type: { type: "string", enum: ["gauge", "counter"], description: "Metric type. Default: 'gauge'" },
              help: { type: "string", description: "Description. Default: 'Custom metric'" },
              timestamp: {
                type: "string",
                description: "ISO 8601 timestamp for historical data (e.g., '2025-01-15'). Omit for real-time (current time). Gauge only — counters with timestamps are rejected.",
              },
            },
            required: ["name", "value"],
          },
        },
        name: {
          type: "string",
          description: "Metric name for 'register' or 'delete' actions",
        },
        type: {
          type: "string",
          enum: ["gauge", "counter"],
          description: "Metric type for 'register'. Default: 'gauge'",
        },
        help: {
          type: "string",
          description: "Description for 'register'. Default: 'Custom metric'",
        },
        labelNames: {
          type: "array",
          items: { type: "string" },
          description: "Label keys for 'register' (e.g., ['region', 'env'])",
        },
        ttlDays: {
          type: "number",
          description: "Auto-expire metric after N days for 'register'",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const store = getCustomMetricsStore();
      if (!store) {
        return jsonResult({
          error: "Custom metrics service not started yet — ensure metrics.enabled is true in config",
        });
      }

      const action = readStringParam(params, "action") ?? "push";

      switch (action) {
        case "push":
          return handlePush(store, params);
        case "register":
          return handleRegister(store, params);
        case "list":
          return handleList(store);
        case "delete":
          return handleDelete(store, params);
        default:
          return jsonResult({ error: `Unknown action '${action}'. Use: push, register, list, delete` });
      }
    },
  });
}

async function handlePush(store: CustomMetricsStore, params: Record<string, unknown>) {
  const metrics = params.metrics as CustomMetricDataPoint[] | undefined;

  if (!metrics || !Array.isArray(metrics) || metrics.length === 0) {
    return jsonResult({
      error: "No metrics provided. Pass a 'metrics' array with at least one data point. Example: { metrics: [{ name: 'steps_today', value: 8000 }] }",
    });
  }

  try {
    // Partition into real-time (no timestamp) and timestamped points
    const realTime: CustomMetricDataPoint[] = [];
    const timestamped: CustomMetricDataPoint[] = [];

    for (const point of metrics) {
      if (point.timestamp) {
        timestamped.push(point);
      } else {
        realTime.push(point);
      }
    }

    // Process both paths and merge results
    let totalAccepted = 0;
    const allRejected: Array<{ name: string; reason: string }> = [];
    const allQueryNames: Record<string, string> = {};

    // Real-time path (existing)
    if (realTime.length > 0) {
      const rtResult = store.pushValues(realTime);
      totalAccepted += rtResult.accepted;
      allRejected.push(...rtResult.rejected);
      Object.assign(allQueryNames, rtResult.queryNames);

      // Force OTLP flush so real-time data is immediately queryable
      await store.forceFlush();
    }

    // Timestamped path (new)
    if (timestamped.length > 0) {
      const tsResult = await store.pushTimestampedValues(timestamped);
      totalAccepted += tsResult.accepted;
      allRejected.push(...tsResult.rejected);
      Object.assign(allQueryNames, tsResult.queryNames);
    }

    // Track push stats for the openclaw_lens_custom_metrics_pushed_total counter
    store.trackPush(totalAccepted, allRejected.length);

    const response: Record<string, unknown> = {
      status: "ok",
      accepted: totalAccepted,
      queryNames: allQueryNames,
      message: `${totalAccepted} of ${metrics.length} data points accepted. Use queryNames for PromQL queries.`,
    };

    if (allRejected.length > 0) {
      response.rejected = allRejected;
      response.message = `${totalAccepted} of ${metrics.length} accepted, ${allRejected.length} rejected. Use queryNames for PromQL queries on accepted metrics.`;
    }

    // Suggest next steps using the actual pushed metric names
    if (totalAccepted > 0) {
      response.suggestedWorkflow = buildPushWorkflow(allQueryNames);
    }

    // Warn when timestamped data points are >10 minutes old — Prometheus/Mimir
    // may silently drop out-of-order samples outside its out_of_order_time_window
    if (timestamped.length > 0) {
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      const hasOldTimestamp = timestamped.some((p) => {
        const ts = new Date(p.timestamp!).getTime();
        return !isNaN(ts) && ts < tenMinAgo;
      });
      if (hasOldTimestamp) {
        response.note =
          "Some timestamps are >10m old — verify data landed with grafana_query. If missing, the backend's out_of_order_time_window may need increasing.";
      }
    }

    return jsonResult(response);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return jsonResult({ error: `Failed to push metrics: ${reason}` });
  }
}

function handleRegister(store: CustomMetricsStore, params: Record<string, unknown>) {
  const rawName = readStringParam(params, "name", { required: true, label: "Metric name" });
  const type = (readStringParam(params, "type") ?? "gauge") as "gauge" | "counter";
  const help = readStringParam(params, "help") ?? "Custom metric";
  const labelNames = (params.labelNames as string[]) ?? [];
  const ttlDays = readNumberParam(params, "ttlDays");

  const { normalized, wasAutoPrepended } = normalizeMetricName(rawName);

  try {
    const def = store.registerMetric({
      name: normalized,
      type,
      help,
      labelNames,
      ttlMs: ttlDays ? ttlDays * 86_400_000 : undefined,
    });

    const queryName = getPromQLName(normalized, type);
    const response: Record<string, unknown> = {
      status: "registered",
      metric: def,
      queryName,
      suggestedWorkflow: buildRegisterWorkflow(normalized, queryName, type, labelNames),
    };

    if (wasAutoPrepended) {
      response.note = `Name auto-prefixed to '${normalized}' (openclaw_ext_ prefix required)`;
    }

    return jsonResult(response);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return jsonResult({ error: `Failed to register metric: ${reason}` });
  }
}

function handleList(store: CustomMetricsStore) {
  const metrics = store.listMetrics();
  return jsonResult({
    status: "success",
    count: metrics.length,
    metrics: metrics.map((m) => ({
      name: m.name,
      type: m.type,
      queryName: getPromQLName(m.name, m.type),
      help: m.help,
      labelNames: m.labelNames,
      createdAt: new Date(m.createdAt).toISOString(),
      updatedAt: new Date(m.updatedAt).toISOString(),
      ttlMs: m.ttlMs,
    })),
  });
}

function handleDelete(store: CustomMetricsStore, params: Record<string, unknown>) {
  const name = readStringParam(params, "name", { required: true, label: "Metric name" });

  const deleted = store.deleteMetric(name);
  if (!deleted) {
    const { normalized } = normalizeMetricName(name);
    return jsonResult({ error: `Metric '${normalized}' not found` });
  }

  return jsonResult({
    status: "deleted",
    name,
    note: "Metric unregistered — new data points will not be recorded. Historical data already in Grafana remains queryable until retention expires.",
  });
}
