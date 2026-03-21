/**
 * grafana_query tool
 *
 * Run PromQL instant or range queries against any Prometheus datasource.
 * The agent uses this to answer data questions directly without creating
 * a dashboard — "what's my cost today?" gets a number, not a URL.
 */

import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import { GrafanaClient, parseDateMathToSeconds } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { getHealthRule, evaluateHealthContext, type HealthContext } from "./health-context.js";
import { resolvePanelQuery } from "./resolve-panel.js";
import { getPromQLGuidance, parsePrometheusWarnings, getEmptyResultHint } from "./query-guidance.js";

interface InstantMetricEntry {
  metric: Record<string, string>;
  value: string;
  timestamp: string;
  healthContext?: HealthContext;
}

const MAX_RANGE_VALUES = 20;

/** Max number of top-level series returned from a range query. */
export const MAX_RANGE_SERIES = 50;

/** Max number of top-level results returned from an instant query. */
export const MAX_INSTANT_RESULTS = 50;

/** Target number of datapoints for auto-step calculation. */
const TARGET_DATAPOINTS = 300;

/** Minimum auto-step in seconds (avoid sub-15s resolution). */
const MIN_STEP_SECONDS = 15;

/**
 * Auto-calculate a step interval from a time range.
 * Targets ~300 datapoints — enough for trend visibility without response bloat.
 * Returns step in seconds as a string (Prometheus-compatible).
 */
export function calculateAutoStep(startStr: string, endStr: string): { stepSeconds: number; stepDisplay: string } {
  const startEpoch = Number(parseDateMathToSeconds(startStr));
  const endEpoch = Number(parseDateMathToSeconds(endStr));
  const rangeSec = Math.max(endEpoch - startEpoch, 1);

  const stepSeconds = Math.max(Math.ceil(rangeSec / TARGET_DATAPOINTS), MIN_STEP_SECONDS);

  // Format for human readability in response metadata
  let stepDisplay: string;
  if (stepSeconds >= 86400) stepDisplay = `${Math.round(stepSeconds / 86400)}d`;
  else if (stepSeconds >= 3600) stepDisplay = `${Math.round(stepSeconds / 3600)}h`;
  else if (stepSeconds >= 60) stepDisplay = `${Math.round(stepSeconds / 60)}m`;
  else stepDisplay = `${stepSeconds}s`;

  return { stepSeconds, stepDisplay };
}

export function createQueryToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_query",
    label: "Grafana Query",
    description: [
      "Run a PromQL query against a Prometheus datasource in Grafana.",
      "WORKFLOW: Use for instant answers ('what is the current value of X?').",
      "Use queryType 'instant' for current values, 'range' for time series.",
      "For range queries: 'start' is required, 'end' defaults to 'now', 'step' is auto-calculated from the time range (~300 datapoints) if omitted.",
      "Requires a datasourceUid — use grafana_explore_datasources to find it.",
      "PANEL RE-RUN: Set dashboardUid + panelId to re-run an existing panel's query with a different time range — no need to extract PromQL manually from get_dashboard output. Overrides expr and datasourceUid.",
      "Returns metric values directly. For visualization, use grafana_create_dashboard instead.",
      "For understanding what a metric means, its trend, or investigating spikes, prefer grafana_explain_metric — it returns current value, trend, and stats in one call.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        datasourceUid: {
          type: "string",
          description: "UID of the Prometheus datasource (use grafana_explore_datasources to find it). Optional when using dashboardUid + panelId — resolved from the panel's datasource config.",
        },
        expr: {
          type: "string",
          description: "PromQL expression (e.g., 'up', 'rate(http_requests_total[5m])'). Optional when using dashboardUid + panelId — extracted from the panel's query.",
        },
        dashboardUid: {
          type: "string",
          description: "Dashboard UID to resolve a panel's query from (use with panelId). Get UIDs from grafana_search or grafana_create_dashboard results.",
        },
        panelId: {
          type: "number",
          description: "Panel ID within the dashboard to re-run (use with dashboardUid). Get panel IDs from grafana_get_dashboard results.",
        },
        queryType: {
          type: "string",
          enum: ["instant", "range"],
          description: "Query type: 'instant' for current value (default), 'range' for time series",
        },
        time: {
          type: "string",
          description: "Evaluation time for instant queries (default: now). Accepts: 'now', 'now-1h', Unix seconds (e.g., '1700000000'), or RFC3339 (e.g., '2026-01-15T00:00:00Z')",
        },
        start: {
          type: "string",
          description: "Start time for range queries. Accepts: 'now-1h', 'now-30m', 'now-7d', Unix seconds, or RFC3339",
        },
        end: {
          type: "string",
          description: "End time for range queries (default: 'now'). Accepts: 'now', 'now-1h', Unix seconds, or RFC3339",
        },
        step: {
          type: "string",
          description: "Step interval for range queries (e.g., '60', '5m', '1h'). Optional — auto-calculated from time range (~300 datapoints) if omitted",
        },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const dashboardUid = readStringParam(params, "dashboardUid");
      const panelId = readNumberParam(params, "panelId");
      let datasourceUid = readStringParam(params, "datasourceUid");
      let expr = readStringParam(params, "expr");
      const queryType = readStringParam(params, "queryType") ?? "instant";
      const time = readStringParam(params, "time");
      const start = readStringParam(params, "start");
      const end = readStringParam(params, "end");
      const step = readStringParam(params, "step");

      // Panel resolution metadata (included in response when panel is used)
      let panelMeta: { resolvedFrom: "panel"; panelTitle: string; panelType: string; templateVarsReplaced: boolean } | undefined;

      try {
        // ── Panel resolution ──────────────────────────────────────────
        if (dashboardUid && panelId != null) {
          const resolved = await resolvePanelQuery(client, dashboardUid, panelId);
          if ("error" in resolved) {
            return jsonResult({ error: resolved.error });
          }
          if (resolved.queryTool !== "grafana_query") {
            return jsonResult({
              error: `Panel ${panelId} ('${resolved.panelTitle}') uses ${resolved.datasourceType} datasource. Use ${resolved.queryTool} with the same dashboardUid + panelId instead.`,
            });
          }
          // Panel values are defaults — explicit params override
          expr = expr ?? resolved.expr;
          datasourceUid = datasourceUid ?? resolved.datasourceUid;
          panelMeta = {
            resolvedFrom: "panel",
            panelTitle: resolved.panelTitle,
            panelType: resolved.panelType,
            templateVarsReplaced: resolved.templateVarsReplaced,
          };
        }

        // Validate required params (after panel resolution)
        if (!datasourceUid) {
          return jsonResult({ error: "Missing 'datasourceUid'. Provide it directly or use dashboardUid + panelId to resolve from a panel." });
        }
        if (!expr) {
          return jsonResult({ error: "Missing 'expr'. Provide a PromQL expression directly or use dashboardUid + panelId to resolve from a panel." });
        }
        if (queryType === "range") {
          if (!start) {
            return jsonResult({ error: "Range queries require a 'start' parameter (e.g., 'now-1h', 'now-30d')" });
          }

          const resolvedEnd = end ?? "now";
          let resolvedStep = step;
          let autoStep: { stepSeconds: number; stepDisplay: string } | undefined;

          if (!resolvedStep) {
            autoStep = calculateAutoStep(start, resolvedEnd);
            resolvedStep = String(autoStep.stepSeconds);
          }

          const result = await client.queryPrometheusRange(datasourceUid, expr, start, resolvedEnd, resolvedStep);

          const warnings = parsePrometheusWarnings(result.infos);
          const totalSeries = result.data.result.length;
          const seriesTruncated = totalSeries > MAX_RANGE_SERIES;
          const slicedResult = seriesTruncated ? result.data.result.slice(0, MAX_RANGE_SERIES) : result.data.result;

          const series = slicedResult.map((s) => {
            const valueTruncated = s.values.length > MAX_RANGE_VALUES;
            return {
              metric: s.metric,
              values: s.values.slice(0, MAX_RANGE_VALUES).map(([ts, val]) => ({
                time: new Date(ts * 1000).toISOString(),
                value: val,
              })),
              ...(valueTruncated ? { truncated: true, totalValues: s.values.length } : {}),
            };
          });

          return jsonResult({
            status: "success",
            queryType: "range",
            expr,
            datasourceUid,
            resultCount: series.length,
            ...(seriesTruncated ? { totalSeries, truncated: true, truncationHint: `Showing ${MAX_RANGE_SERIES} of ${totalSeries} series. Narrow your query to see specific series.` } : {}),
            ...(totalSeries === 0 ? { hint: getEmptyResultHint(expr) } : {}),
            ...(warnings ? { warnings } : {}),
            series,
            ...(autoStep ? { step: { value: `${autoStep.stepSeconds}s`, display: autoStep.stepDisplay, auto: true } } : {}),
            ...panelMeta,
          });
        }

        // Instant query (default)
        const result = await client.queryPrometheus(datasourceUid, expr, time);

        const warnings = parsePrometheusWarnings(result.infos);
        const totalResults = result.data.result.length;
        const resultsTruncated = totalResults > MAX_INSTANT_RESULTS;
        const slicedResults = resultsTruncated ? result.data.result.slice(0, MAX_INSTANT_RESULTS) : result.data.result;

        // Resolve health rule once for the expression, then evaluate per-result
        const healthRule = getHealthRule(expr);
        const metrics: InstantMetricEntry[] = slicedResults.map((r) => {
          const entry: InstantMetricEntry = {
            metric: r.metric,
            value: r.value[1],
            timestamp: new Date(r.value[0] * 1000).toISOString(),
          };
          if (healthRule) {
            const health = evaluateHealthContext(healthRule, r.value[1]);
            if (health) entry.healthContext = health;
          }
          return entry;
        });

        return jsonResult({
          status: "success",
          queryType: "instant",
          expr,
          datasourceUid,
          resultCount: metrics.length,
          ...(resultsTruncated ? { totalResults, truncated: true, truncationHint: `Showing ${MAX_INSTANT_RESULTS} of ${totalResults} results. Narrow your query to see specific metrics.` } : {}),
          ...(totalResults === 0 ? { hint: getEmptyResultHint(expr) } : {}),
          ...(warnings ? { warnings } : {}),
          metrics,
          ...panelMeta,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const guidance = getPromQLGuidance(reason, expr ?? "");
        return jsonResult({
          error: `Query failed: ${reason}`,
          ...(guidance ? { guidance } : {}),
        });
      }
    },
  });
}
