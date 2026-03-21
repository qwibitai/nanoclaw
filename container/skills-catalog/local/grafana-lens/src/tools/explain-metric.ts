/**
 * grafana_explain_metric tool
 *
 * Gathers structured data about a metric — current value, trend over a period,
 * min/max/avg statistics, and metadata (type/help/unit). The agent uses this
 * enriched context to explain what a metric means and why it changed.
 *
 * Counter-aware: auto-detects counter metrics (via metadata or _total suffix)
 * and wraps the trend query in rate() so the agent sees actual rate of change
 * instead of raw monotonically-increasing cumulative values.
 */

import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { GrafanaClient, type MetricMetadataItem } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { getHealthContext } from "./health-context.js";
import { KNOWN_BREAKDOWNS_MAP } from "../metric-definitions.js";

const PERIOD_CONFIG: Record<string, { seconds: number; step: string; label: string }> = {
  "24h": { seconds: 86_400, step: "300", label: "24 hours" },
  "7d": { seconds: 604_800, step: "3600", label: "7 days" },
  "30d": { seconds: 2_592_000, step: "21600", label: "30 days" },
};

const PLAIN_METRIC_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** Rate window for counter trend queries — standard Prometheus default. */
const RATE_WINDOW = "5m";

/**
 * Standard Prometheus/OTel infrastructure labels that aren't useful for
 * drill-down suggestions. Users want to break down by semantic labels
 * (token_type, model, channel) not by deployment topology.
 */
const EXCLUDED_LABELS = new Set([
  "__name__", "instance", "job", "le",
  "service_name", "service_namespace", "service_version",
]);

/**
 * Static label breakdown knowledge for well-known metric families.
 * Derived from the shared metric-definitions registry (src/metric-definitions.ts).
 * Labels are ordered by analytical importance (most useful first).
 * Uses Prometheus names (with _total suffix for counters) since the tool queries Prometheus.
 */
const KNOWN_BREAKDOWNS: Readonly<Record<string, string[]>> = KNOWN_BREAKDOWNS_MAP;

/**
 * Resolve meaningful label names for breaking down a metric.
 * Uses static knowledge for well-known metrics (works even with no data);
 * falls back to dynamically-discovered labels from query results.
 *
 * Suffix-tolerant: tries the exact name first, then strips Prometheus
 * suffixes (_total, _bucket, _count, _sum) to match the base definition.
 * This handles the OTel→Prometheus naming gap — agents may pass either form.
 */
export function resolveBreakdowns(
  metricName: string,
  dynamicLabels: string[],
): string[] {
  // Exact match first
  if (KNOWN_BREAKDOWNS[metricName]) return KNOWN_BREAKDOWNS[metricName];
  // Strip Prometheus suffixes to find base metric
  const stripped = metricName
    .replace(/_bucket$/, "")
    .replace(/_count$/, "")
    .replace(/_sum$/, "")
    .replace(/_total$/, "");
  // Try the stripped name, then try with _total (counter convention)
  return KNOWN_BREAKDOWNS[stripped]
    ?? KNOWN_BREAKDOWNS[`${stripped}_total`]
    ?? dynamicLabels;
}

/** Round to 4 significant digits for context efficiency. */
const sig4 = (n: number) => Number(n.toPrecision(4));

/** Compute min/max/avg from a numeric array in a single pass. */
function computeStats(values: number[]): { min: number; max: number; avg: number } {
  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: sum / values.length };
}

/** Determine direction using 1% hysteresis threshold. */
function detectDirection(current: number, baseline: number): "up" | "down" | "flat" {
  if (current > baseline * 1.01) return "up";
  if (current < baseline * 0.99) return "down";
  return "flat";
}

/**
 * Detect metric type using metadata API + naming convention fallback.
 * OTLP-pushed metrics often lack metadata, so _total suffix is a reliable fallback.
 */
function detectMetricType(
  metricName: string,
  metadata?: MetricMetadataItem,
): string | undefined {
  if (metadata?.type) return metadata.type;
  if (metricName.endsWith("_total")) return "counter";
  if (metricName.endsWith("_bucket")) return "histogram";
  return undefined;
}

/**
 * Extract unique semantic label names from instant query results.
 * Excludes infrastructure labels (__name__, job, instance, etc.)
 * that don't provide useful drill-down dimensions.
 */
export function extractLabelNames(
  results: Array<{ metric: Record<string, string> }>,
): string[] {
  const labelSet = new Set<string>();
  for (const r of results) {
    for (const key of Object.keys(r.metric)) {
      if (!EXCLUDED_LABELS.has(key)) labelSet.add(key);
    }
  }
  return Array.from(labelSet).sort();
}

type SuggestedQuery = { query: string; description: string };

/**
 * Generate suggested drill-down queries based on discovered labels and metric type.
 * Counter metrics get rate() wrapping; gauges/unknown use raw expressions.
 * Returns empty array when no labels are available.
 */
export function buildSuggestedQueries(
  expr: string,
  labels: string[],
  metricType: string | undefined,
): SuggestedQuery[] {
  if (labels.length === 0) return [];

  const isCounter = metricType === "counter";
  const baseExpr = isCounter ? `rate(${expr}[${RATE_WINDOW}])` : expr;
  const queries: SuggestedQuery[] = [];

  // Top-k by first label — most useful as a starting point
  queries.push({
    query: `topk(5, sum by (${labels[0]}) (${baseExpr}))`,
    description: `Top 5 by ${labels[0]}`,
  });

  // Breakdown by each label
  for (const label of labels) {
    queries.push({
      query: `sum by (${label}) (${baseExpr})`,
      description: `Breakdown by ${label}`,
    });
  }

  // Full multi-label breakdown if 2+ labels
  if (labels.length >= 2) {
    queries.push({
      query: `sum by (${labels.join(", ")}) (${baseExpr})`,
      description: `Full breakdown by all labels`,
    });
  }

  return queries;
}

export function createExplainMetricToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_explain_metric",
    label: "Explain Metric",
    description: [
      "Get structured context about a metric: current value, trend (change %, direction), stats (min/max/avg), and metadata (type/help/unit).",
      "WORKFLOW: Use when user asks 'what does this metric mean?', 'why did it spike?', 'is this normal?', or 'show me the trend'.",
      "Returns enriched data for the agent to interpret — the agent provides the narrative.",
      "Counter-aware: auto-detects counter metrics and shows rate of change (not raw cumulative values) for trends.",
      "Response includes `metricType` (counter/gauge/histogram/summary), `trendQuery` (actual PromQL used for trend), `suggestedQueries` (drill-down PromQL by label), and `suggestedBreakdowns` (label names for decomposition — always available for known OpenClaw metrics, even with no data).",
      "Includes anomaly scoring (sigma-based z-score against 7-day baseline) and seasonality comparison (vs 1 day ago, vs 7 days ago) for 24h period queries. Returns `anomaly` (score, severity: normal/mild/significant/critical, baseline) and `seasonality` (vs1dAgo, vs7dAgo with change percent).",
      "Period comparison: set `compareWith: 'previous'` to compare the current period with the immediately preceding one (e.g., this week vs. last week). Returns a `comparison` object with previous period stats and change (absolute, percentage, direction). Eliminates manual multi-query workflows for period-over-period analysis.",
      "Requires a datasourceUid — use grafana_explore_datasources to find it.",
      "Supports any PromQL expression. Metadata only available for plain metric names.",
      "For raw PromQL with custom time parameters, complex multi-metric expressions, or range queries with specific steps, use grafana_query instead.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        datasourceUid: {
          type: "string",
          description: "UID of the Prometheus datasource (use grafana_explore_datasources to find it)",
        },
        expr: {
          type: "string",
          description: "PromQL expression or plain metric name (e.g., 'openclaw_lens_daily_cost_usd' or 'openclaw_lens_tokens_total')",
        },
        period: {
          type: "string",
          enum: Object.keys(PERIOD_CONFIG),
          description: "Lookback period for trend and stats (default: '24h')",
        },
        compareWith: {
          type: "string",
          enum: ["previous"],
          description: "Set to 'previous' to compare current period with the same-length window immediately before it (e.g., this week vs. last week). Adds a 'comparison' object to the response.",
        },
      },
      required: ["datasourceUid", "expr"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const datasourceUid = readStringParam(params, "datasourceUid", { required: true, label: "Datasource UID" });
      const expr = readStringParam(params, "expr", { required: true, label: "PromQL expression" });
      const period = readStringParam(params, "period") ?? "24h";
      const compareWith = readStringParam(params, "compareWith");

      const periodCfg = PERIOD_CONFIG[period];
      if (!periodCfg) {
        return jsonResult({ error: `Invalid period '${period}' — use '24h', '7d', or '30d'` });
      }

      const isPlainMetric = PLAIN_METRIC_RE.test(expr);
      const nowSec = Math.floor(Date.now() / 1000);
      const startSec = nowSec - periodCfg.seconds;

      // ── Step 1: Fetch metadata + instant in parallel (range query depends on type) ──
      let metadata: MetricMetadataItem | undefined;
      const [metaSettled, instantResult] = await Promise.allSettled([
        isPlainMetric
          ? client.getMetricMetadata(datasourceUid, { metric: expr })
          : Promise.resolve(undefined),
        client.queryPrometheus(datasourceUid, expr),
      ]);
      if (metaSettled.status === "fulfilled" && metaSettled.value) {
        const entries = metaSettled.value[expr];
        if (entries && entries.length > 0) {
          metadata = entries[0];
        }
      }

      // ── Step 2: Detect metric type and choose appropriate range expression ──
      const metricType = isPlainMetric ? detectMetricType(expr, metadata) : undefined;
      const trendQuery = metricType === "counter" ? `rate(${expr}[${RATE_WINDOW}])` : expr;

      // ── Step 3: Run range query (depends on trendQuery from Step 2) ──
      // If compareWith="previous", also query the previous period in parallel
      const prevStartSec = startSec - periodCfg.seconds;
      const prevEndSec = startSec;
      const rangePromises = [
        client.queryPrometheusRange(datasourceUid, trendQuery, String(startSec), String(nowSec), periodCfg.step),
      ];
      if (compareWith === "previous") {
        rangePromises.push(
          client.queryPrometheusRange(datasourceUid, trendQuery, String(prevStartSec), String(prevEndSec), periodCfg.step),
        );
      }
      const [rangeResult, prevRangeResult] = await Promise.allSettled(rangePromises);

      // ── Current value (always raw — cumulative total is meaningful for counters) ──
      let current: { value: string; timestamp: string } | undefined;
      if (instantResult.status === "fulfilled") {
        const first = instantResult.value.data.result[0];
        if (first) {
          current = {
            value: first.value[1],
            timestamp: new Date(first.value[0] * 1000).toISOString(),
          };
        }
      }

      // If both queries failed entirely, return the error
      if (instantResult.status === "rejected" && rangeResult.status === "rejected") {
        const reason = instantResult.reason instanceof Error ? instantResult.reason.message : String(instantResult.reason);
        return jsonResult({ error: `Query failed: ${reason}` });
      }

      // ── Trend & stats from range data ───────────────────────────────
      let trend: { changePercent: number | null; direction: "up" | "down" | "flat"; first: string; last: string } | undefined;
      let stats: { min: string; max: string; avg: string; samples: number } | undefined;
      if (rangeResult.status === "fulfilled") {
        const series = rangeResult.value.data.result[0];
        if (series && series.values.length > 0) {
          const values = series.values.map(([, v]: [number, string]) => parseFloat(v));
          const firstVal = values[0];
          const lastVal = values[values.length - 1];
          const s = computeStats(values);

          let changePercent: number | null = null;
          if (firstVal !== 0) {
            changePercent = parseFloat((((lastVal - firstVal) / firstVal) * 100).toFixed(1));
          }

          trend = {
            changePercent,
            direction: detectDirection(lastVal, firstVal),
            first: String(firstVal),
            last: String(lastVal),
          };

          stats = {
            min: String(sig4(s.min)),
            max: String(sig4(s.max)),
            avg: String(sig4(s.avg)),
            samples: series.values.length,
          };
        }
      }

      // ── Comparison with previous period ────────────────────────────
      let comparison: {
        previousPeriod: { from: string; to: string; avg: string; min: string; max: string; samples: number };
        change: { absolute: string; percentage: number | null; direction: "up" | "down" | "flat" };
      } | undefined;
      if (compareWith === "previous" && prevRangeResult?.status === "fulfilled") {
        const prevSeries = prevRangeResult.value.data.result[0];
        if (prevSeries && prevSeries.values.length > 0 && stats) {
          const prevValues = prevSeries.values.map(([, v]: [number, string]) => parseFloat(v));
          const ps = computeStats(prevValues);
          const currentAvg = parseFloat(stats.avg);

          const absolute = currentAvg - ps.avg;
          let percentage: number | null = null;
          if (ps.avg !== 0) {
            percentage = parseFloat(((absolute / ps.avg) * 100).toFixed(1));
          }

          comparison = {
            previousPeriod: {
              from: new Date(prevStartSec * 1000).toISOString(),
              to: new Date(prevEndSec * 1000).toISOString(),
              avg: String(sig4(ps.avg)),
              min: String(sig4(ps.min)),
              max: String(sig4(ps.max)),
              samples: prevSeries.values.length,
            },
            change: {
              absolute: String(sig4(absolute)),
              percentage,
              direction: detectDirection(currentAvg, ps.avg),
            },
          };
        }
      }

      // ── Anomaly scoring + seasonality (24h period only, plain metrics) ──
      let anomaly: {
        score: number;
        severity: "normal" | "mild" | "significant" | "critical";
        baseline: { avg: string; stddev: string; period: "7d" };
        interpretation: string;
      } | undefined;

      let seasonality: {
        vs1dAgo: { value: string; changePercent: number | null };
        vs7dAgo: { value: string; changePercent: number | null };
      } | undefined;

      if (period === "24h" && isPlainMetric && stats) {
        // Run anomaly + seasonality queries in parallel
        const anomalyExpr = trendQuery; // Use rate() for counters, raw for gauges
        const [baselineAvgResult, baselineStddevResult, offset1dResult, offset7dResult] = await Promise.allSettled([
          client.queryPrometheus(datasourceUid, `avg_over_time(${anomalyExpr}[7d])`),
          client.queryPrometheus(datasourceUid, `stddev_over_time(${anomalyExpr}[7d])`),
          client.queryPrometheus(datasourceUid, `${expr} offset 1d`),
          client.queryPrometheus(datasourceUid, `${expr} offset 7d`),
        ]);

        // ── Anomaly z-score ──
        if (baselineAvgResult.status === "fulfilled" && baselineStddevResult.status === "fulfilled"
            && baselineAvgResult.value?.data?.result && baselineStddevResult.value?.data?.result) {
          const avgVal = baselineAvgResult.value.data.result[0]?.value[1];
          const stddevVal = baselineStddevResult.value.data.result[0]?.value[1];
          if (avgVal && stddevVal) {
            const baselineAvg = parseFloat(avgVal);
            const baselineStddev = parseFloat(stddevVal);
            const currentAvg = parseFloat(stats.avg);
            const epsilon = 1e-10;
            const zScore = Math.abs((currentAvg - baselineAvg) / (baselineStddev + epsilon));
            const roundedZ = parseFloat(zScore.toFixed(2));

            let severity: "normal" | "mild" | "significant" | "critical";
            if (roundedZ >= 3) severity = "critical";
            else if (roundedZ >= 2) severity = "significant";
            else if (roundedZ >= 1.5) severity = "mild";
            else severity = "normal";

            const direction = currentAvg > baselineAvg ? "above" : "below";
            anomaly = {
              score: roundedZ,
              severity,
              baseline: { avg: String(sig4(baselineAvg)), stddev: String(sig4(baselineStddev)), period: "7d" },
              interpretation: `${roundedZ}σ ${direction} 7-day baseline — ${severity} anomaly`,
            };
          }
        }

        // ── Seasonality comparison ──
        const currentVal = instantResult.status === "fulfilled"
          ? parseFloat(instantResult.value.data.result[0]?.value[1] ?? "NaN")
          : NaN;

        if (!isNaN(currentVal)) {
          const vs1d = offset1dResult.status === "fulfilled" && offset1dResult.value?.data?.result
            ? parseFloat(offset1dResult.value.data.result[0]?.value[1] ?? "NaN")
            : NaN;
          const vs7d = offset7dResult.status === "fulfilled" && offset7dResult.value?.data?.result
            ? parseFloat(offset7dResult.value.data.result[0]?.value[1] ?? "NaN")
            : NaN;

          const computeChange = (old: number) => {
            if (isNaN(old) || old === 0) return null;
            return parseFloat((((currentVal - old) / old) * 100).toFixed(1));
          };

          seasonality = {
            vs1dAgo: { value: isNaN(vs1d) ? "N/A" : String(sig4(vs1d)), changePercent: computeChange(vs1d) },
            vs7dAgo: { value: isNaN(vs7d) ? "N/A" : String(sig4(vs7d)), changePercent: computeChange(vs7d) },
          };
        }
      }

      // ── Extract label names for drill-down suggestions ─────────────
      const dynamicLabels = isPlainMetric && instantResult.status === "fulfilled"
        ? extractLabelNames(instantResult.value.data.result)
        : [];

      // ── Resolve breakdown label hints (static knowledge + dynamic) ──
      const suggestedBreakdowns = isPlainMetric
        ? resolveBreakdowns(expr, dynamicLabels)
        : [];

      // Use static breakdowns as fallback when instant query returns no labels
      // (e.g., metric is stale — no current time series but range data exists)
      const labels = dynamicLabels.length > 0 ? dynamicLabels : suggestedBreakdowns;
      const suggestedQueries = buildSuggestedQueries(expr, labels, metricType);

      // ── Build response (omit sections without data) ─────────────────
      const result: Record<string, unknown> = {
        status: "success",
        expr,
        period,
        periodLabel: periodCfg.label,
      };

      if (metricType) result.metricType = metricType;
      if (trendQuery !== expr) result.trendQuery = trendQuery;
      if (current) {
        result.current = current;
        const health = getHealthContext(expr, current.value);
        if (health) result.healthContext = health;
      }
      if (trend) result.trend = trend;
      if (stats) result.stats = stats;
      if (comparison) result.comparison = comparison;
      if (anomaly) result.anomaly = anomaly;
      if (seasonality) result.seasonality = seasonality;
      if (metadata) result.metadata = metadata;
      if (suggestedQueries.length > 0) result.suggestedQueries = suggestedQueries;
      if (suggestedBreakdowns.length > 0) result.suggestedBreakdowns = suggestedBreakdowns;

      if (!current && !trend && !stats) {
        result.note = `No data found for '${expr}' over the last ${periodCfg.label}`;
      }

      return jsonResult(result);
    },
  });
}
