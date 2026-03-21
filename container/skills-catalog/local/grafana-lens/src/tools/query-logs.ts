/**
 * grafana_query_logs tool
 *
 * Run LogQL queries against any Loki datasource via Grafana's datasource proxy.
 * Handles both log queries (streams) and metric queries (matrix/vector).
 * Mirrors grafana_query structure for consistency.
 */

import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import type { LokiQueryResult, LokiStreamEntry } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { resolvePanelQuery } from "./resolve-panel.js";
import { getLogQLGuidance } from "./query-guidance.js";

const MAX_LOG_ENTRIES = 100;
const DEFAULT_LOG_LINE_LENGTH = 500;
const MAX_LOG_LINE_LENGTH = 2000;
const MAX_RANGE_VALUES = 20;

/** Max number of top-level series returned from a matrix (metric-over-logs) query. */
export const MAX_MATRIX_SERIES = 50;

/** Max number of top-level results returned from a vector (instant metric-over-logs) query. */
export const MAX_VECTOR_RESULTS = 50;

type FlatLogEntry = {
  labels: Record<string, string>;
  timestamp: string;
  line: string;
  fields?: Record<string, string | number | boolean>;
};

/**
 * Infrastructure noise labels that obscure meaningful OTel attributes.
 * Removed when extractFields is true to surface signal over noise.
 */
const NOISE_LABELS = new Set([
  "telemetry_sdk_language",
  "telemetry_sdk_name",
  "telemetry_sdk_version",
  "service_name",
  "service_namespace",
  "service_version",
  "scope_name",
  "flags",
  "observed_timestamp",
  "event_domain",
  "severity_number",   // redundant with severity_text
  "detected_level",    // redundant with severity_text
]);

/**
 * Extract structured fields from a log entry's labels and body.
 * - Promotes known OTel/lifecycle attributes from labels to a clean `fields` object
 * - Strips openclaw_ prefix for readability (openclaw_session_id → session_id)
 * - Attempts JSON parsing of log line body and merges parsed keys
 * - Removes infrastructure noise labels from the entry's labels
 */
function extractStructuredFields(entry: FlatLogEntry): FlatLogEntry {
  const fields: Record<string, string | number | boolean> = {};
  const cleanLabels: Record<string, string> = {};

  for (const [key, value] of Object.entries(entry.labels)) {
    if (NOISE_LABELS.has(key)) continue;

    // Promote openclaw_ prefixed keys with cleaner names into fields
    if (key.startsWith("openclaw_")) {
      const cleanKey = key.slice("openclaw_".length);
      // Strict numeric check — avoids Infinity, hex (0x1F), whitespace-padded strings
      fields[cleanKey] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    } else {
      // Non-noise, non-prefixed labels: keep in both labels and fields
      cleanLabels[key] = value;
      fields[key] = value;
    }
  }

  // Attempt JSON parsing of log line body
  const trimmed = entry.line.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== null && value !== undefined && !NOISE_LABELS.has(key)) {
          const v = typeof value === "object" ? JSON.stringify(value) : value;
          fields[key] = v as string | number | boolean;
        }
      }
    } catch {
      // Not valid JSON — pass through unchanged
    }
  }

  return {
    labels: cleanLabels,
    timestamp: entry.timestamp,
    line: entry.line,
    fields,
  };
}

/** Convert a Loki nanosecond timestamp string to ISO 8601. */
function nanoToISO(ns: string): string {
  const ms = Math.floor(Number(ns) / 1_000_000);
  return new Date(ms).toISOString();
}

/** Flatten Loki stream results into a sorted array of log entries. */
function flattenStreams(streams: LokiStreamEntry[], limit: number, lineLimit: number): { entries: FlatLogEntry[]; totalEntries: number } {
  const all: FlatLogEntry[] = [];

  for (const stream of streams) {
    for (const [ts, line] of stream.values) {
      const truncatedLine =
        line.length > lineLimit
          ? line.slice(0, lineLimit) + "... (truncated)"
          : line;
      all.push({
        labels: stream.stream,
        timestamp: nanoToISO(ts),
        line: truncatedLine,
      });
    }
  }

  const totalEntries = all.length;

  // Sort by timestamp descending (newest first) — Loki default
  all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { entries: all.slice(0, limit), totalEntries };
}

export function createQueryLogsToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_query_logs",
    label: "Grafana Query Logs",
    description: [
      "Run a LogQL query against a Loki datasource in Grafana.",
      "WORKFLOW: Use for log searches — find errors, investigate incidents, correlate with metrics.",
      "Use queryType 'range' (default) for time-window log searches, 'instant' for point-in-time.",
      "Requires a datasourceUid — use grafana_explore_datasources to find Loki datasources (type: 'loki').",
      "PANEL RE-RUN: Set dashboardUid + panelId to re-run an existing panel's LogQL query with a different time range — no need to extract the query manually. Overrides expr and datasourceUid.",
      "Returns structured log entries (timestamp, labels, line). For metric queries over logs, returns same shape as grafana_query.",
      "Log lines are truncated to 500 chars by default. Set lineLimit up to 2000 when investigating stack traces or verbose error messages.",
      "Set extractFields: true for OTel/structured logs — promotes meaningful attributes (component, event_name, session_id, trace_id, model, duration) to a clean 'fields' object and strips infrastructure noise from labels.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        datasourceUid: {
          type: "string",
          description: "UID of the Loki datasource (use grafana_explore_datasources to find it). Optional when using dashboardUid + panelId.",
        },
        expr: {
          type: "string",
          description: "LogQL expression (e.g., '{job=\"api\"} |= \"error\"', 'rate({job=\"api\"}[5m])'). Optional when using dashboardUid + panelId.",
        },
        dashboardUid: {
          type: "string",
          description: "Dashboard UID to resolve a panel's LogQL query from (use with panelId).",
        },
        panelId: {
          type: "number",
          description: "Panel ID within the dashboard to re-run (use with dashboardUid).",
        },
        queryType: {
          type: "string",
          enum: ["instant", "range"],
          description: "Query type: 'range' for time-window search (default), 'instant' for point-in-time",
        },
        start: {
          type: "string",
          description: "Start time (default: 'now-1h'). Accepts: 'now-1h', 'now-30m', 'now-7d', Unix seconds (e.g., '1700000000'), or RFC3339 (e.g., '2026-01-15T00:00:00Z')",
        },
        end: {
          type: "string",
          description: "End time (default: 'now'). Accepts: 'now', Unix seconds, or RFC3339",
        },
        step: {
          type: "string",
          description: "Step interval for metric queries over ranges (e.g., '60', '5m')",
        },
        limit: {
          type: "number",
          description: "Max log entries to return (default 100)",
        },
        direction: {
          type: "string",
          enum: ["backward", "forward"],
          description: "Sort order: 'backward' (newest first, default) or 'forward' (oldest first)",
        },
        lineLimit: {
          type: "number",
          description: "Max characters per log line (default 500, max 2000). Increase to 2000 for full stack traces or verbose error output.",
        },
        extractFields: {
          type: "boolean",
          description: "Extract structured fields from OTel log attributes and JSON bodies (default false). When true, each entry gains a 'fields' object with clean keys (session_id, trace_id, model, event_name, component, etc.) and labels are stripped of infrastructure noise. Use for session debugging and OTel log investigation.",
        },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const dashboardUid = readStringParam(params, "dashboardUid");
      const panelId = readNumberParam(params, "panelId");
      let datasourceUid = readStringParam(params, "datasourceUid");
      let expr = readStringParam(params, "expr");
      const queryType = readStringParam(params, "queryType") ?? "range";
      const start = readStringParam(params, "start") ?? "now-1h";
      const end = readStringParam(params, "end") ?? "now";
      const step = readStringParam(params, "step");
      const limit = readNumberParam(params, "limit") ?? MAX_LOG_ENTRIES;
      const direction = readStringParam(params, "direction") ?? "backward";
      const rawLineLimit = readNumberParam(params, "lineLimit") ?? DEFAULT_LOG_LINE_LENGTH;
      const lineLimit = Math.min(Math.max(1, rawLineLimit), MAX_LOG_LINE_LENGTH);
      const extractFields = params.extractFields === true;

      // Panel resolution metadata (included in response when panel is used)
      let panelMeta: { resolvedFrom: "panel"; panelTitle: string; panelType: string; templateVarsReplaced: boolean } | undefined;

      try {
        // ── Panel resolution ──────────────────────────────────────────
        if (dashboardUid && panelId != null) {
          const resolved = await resolvePanelQuery(client, dashboardUid, panelId);
          if ("error" in resolved) {
            return jsonResult({ error: resolved.error });
          }
          if (resolved.queryTool !== "grafana_query_logs") {
            return jsonResult({
              error: `Panel ${panelId} ('${resolved.panelTitle}') uses ${resolved.datasourceType} datasource. Use ${resolved.queryTool} with the same dashboardUid + panelId instead.`,
            });
          }
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
          return jsonResult({ error: "Missing 'expr'. Provide a LogQL expression directly or use dashboardUid + panelId to resolve from a panel." });
        }

        let result: LokiQueryResult;

        if (queryType === "instant") {
          result = await client.queryLoki(datasourceUid, expr, { limit, direction });
        } else {
          result = await client.queryLokiRange(datasourceUid, expr, start, end, {
            step: step ?? undefined,
            limit,
            direction,
          });
        }

        return formatLokiResult(result, { expr, datasourceUid, queryType, limit, lineLimit, extractFields, panelMeta });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const guidance = getLogQLGuidance(reason, expr ?? "");
        return jsonResult({
          error: `Log query failed: ${reason}`,
          ...(guidance ? { guidance } : {}),
        });
      }
    },
  });
}

type PanelMeta = { resolvedFrom: "panel"; panelTitle: string; panelType: string; templateVarsReplaced: boolean };

interface FormatLokiOpts {
  expr: string;
  datasourceUid: string;
  queryType: string;
  limit: number;
  lineLimit: number;
  extractFields?: boolean;
  panelMeta?: PanelMeta;
}

function formatLokiResult(result: LokiQueryResult, opts: FormatLokiOpts) {
  const { expr, datasourceUid, queryType, limit, lineLimit, extractFields = false, panelMeta } = opts;
  const { resultType } = result.data;

  if (resultType === "streams") {
    const streams = result.data.result as LokiStreamEntry[];
    const { entries, totalEntries } = flattenStreams(streams, limit, lineLimit);
    const finalEntries = extractFields ? entries.map(extractStructuredFields) : entries;

    // Collect unique trace_ids from extracted fields for correlation hint
    const traceIds = extractFields
      ? [...new Set(
          finalEntries
            .map((e) => (e as { fields?: Record<string, unknown> }).fields?.trace_id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        )].slice(0, 5)
      : [];

    return jsonResult({
      status: "success",
      queryType,
      resultType: "streams",
      expr,
      datasourceUid,
      totalStreams: streams.length,
      totalEntries,
      entries: finalEntries,
      ...(totalEntries > entries.length ? { truncated: true } : {}),
      ...(traceIds.length > 0 ? {
        traceCorrelation: {
          traceIds,
          tool: "grafana_query_traces",
          tip: `Found ${traceIds.length} trace ID(s) in log entries. Use grafana_query_traces with queryType "get" and any traceId to see the full distributed trace.`,
        },
      } : {}),
      ...panelMeta,
    });
  }

  if (resultType === "matrix") {
    const matrixResult = result.data.result as Array<{ metric: Record<string, string>; values?: Array<[number, string]> }>;
    const totalSeries = matrixResult.length;
    const seriesTruncated = totalSeries > MAX_MATRIX_SERIES;
    const slicedMatrix = seriesTruncated ? matrixResult.slice(0, MAX_MATRIX_SERIES) : matrixResult;

    const series = slicedMatrix.map((s) => {
      const values = s.values ?? [];
      const valueTruncated = values.length > MAX_RANGE_VALUES;
      return {
        metric: s.metric,
        values: values.slice(0, MAX_RANGE_VALUES).map(([ts, val]) => ({
          time: new Date(ts * 1000).toISOString(),
          value: val,
        })),
        ...(valueTruncated ? { truncated: true, totalValues: values.length } : {}),
      };
    });

    return jsonResult({
      status: "success",
      queryType,
      resultType: "matrix",
      expr,
      datasourceUid,
      resultCount: series.length,
      ...(seriesTruncated ? { totalSeries, truncated: true, truncationHint: `Showing ${MAX_MATRIX_SERIES} of ${totalSeries} series. Narrow your LogQL query to see specific series.` } : {}),
      series,
      ...panelMeta,
    });
  }

  // vector (instant metric query)
  const vectorResult = result.data.result as Array<{ metric: Record<string, string>; value?: [number, string] }>;
  const totalResults = vectorResult.length;
  const resultsTruncated = totalResults > MAX_VECTOR_RESULTS;
  const slicedVector = resultsTruncated ? vectorResult.slice(0, MAX_VECTOR_RESULTS) : vectorResult;

  const metrics = slicedVector.map((r) => ({
    metric: r.metric,
    value: r.value?.[1] ?? null,
    timestamp: r.value ? new Date(r.value[0] * 1000).toISOString() : null,
  }));

  return jsonResult({
    status: "success",
    queryType,
    resultType: "vector",
    expr,
    datasourceUid,
    resultCount: metrics.length,
    ...(resultsTruncated ? { totalResults, truncated: true, truncationHint: `Showing ${MAX_VECTOR_RESULTS} of ${totalResults} results. Narrow your LogQL query to see specific results.` } : {}),
    metrics,
    ...panelMeta,
  });
}
