/**
 * grafana_query_traces tool
 *
 * Run TraceQL queries against any Tempo datasource via Grafana's datasource proxy.
 * Supports two query types:
 *   - search: TraceQL expression → flat trace summaries
 *   - get: Trace ID → flattened span list with resolved attributes
 * Mirrors grafana_query_logs structure for consistency.
 */

import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import type {
  TempoSearchTrace,
  TempoAttribute,
  TempoTraceResult,
  TempoResourceSpans,
} from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { resolvePanelQuery } from "./resolve-panel.js";
import { getTraceQLGuidance } from "./query-guidance.js";

export const MAX_SEARCH_TRACES = 50;
export const MAX_TRACE_SPANS = 200;
const MAX_ATTRIBUTES_PER_SPAN = 20;

const STATUS_MAP: Record<number, string> = { 0: "unset", 1: "ok", 2: "error" };

/** Tempo protobuf-JSON returns string status codes like "STATUS_CODE_OK". */
const STATUS_STRING_MAP: Record<string, string> = {
  STATUS_CODE_UNSET: "unset",
  STATUS_CODE_OK: "ok",
  STATUS_CODE_ERROR: "error",
};

const SPAN_KIND_MAP: Record<number, string> = {
  0: "unspecified",
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

/** Tempo protobuf-JSON returns string kind like "SPAN_KIND_INTERNAL". */
const SPAN_KIND_STRING_MAP: Record<string, string> = {
  SPAN_KIND_UNSPECIFIED: "unspecified",
  SPAN_KIND_INTERNAL: "internal",
  SPAN_KIND_SERVER: "server",
  SPAN_KIND_CLIENT: "client",
  SPAN_KIND_PRODUCER: "producer",
  SPAN_KIND_CONSUMER: "consumer",
};

// ── Base64 ↔ hex helpers ─────────────────────────────────────────────

/** Decode base64 to hex string (Tempo protobuf-JSON uses base64 for trace/span IDs). */
function base64ToHex(b64: string): string {
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.toString("hex");
  } catch {
    return b64; // Already hex or invalid — pass through
  }
}

/** Detect whether a string is base64-encoded (not hex). */
function isBase64(s: string): boolean {
  // Hex trace IDs are 32 chars [0-9a-f]; base64 uses A-Z, +, /, =
  return /[A-Z+/=]/.test(s);
}

// ── OTLP attribute resolution ─────────────────────────────────────────

/** Resolve a typed OTLP attribute value to a plain JS value. */
function resolveAttributeValue(attr: TempoAttribute): string | number | boolean | string[] {
  const v = attr.value;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue?.values) return v.arrayValue.values.map((x) => x.stringValue ?? "");
  return "";
}

/** Convert a list of OTLP attributes to a plain object, capped at maxAttrs. */
function resolveAttributes(
  attrs: TempoAttribute[] | undefined,
  maxAttrs: number,
): Record<string, string | number | boolean | string[]> {
  if (!attrs?.length) return {};
  const result: Record<string, string | number | boolean | string[]> = {};
  let count = 0;
  for (const attr of attrs) {
    if (count >= maxAttrs) break;
    result[attr.key] = resolveAttributeValue(attr);
    count++;
  }
  return result;
}

// ── Duration math ─────────────────────────────────────────────────────

/**
 * Calculate duration in milliseconds from nanosecond timestamps.
 * Uses BigInt for precision — JS Number loses accuracy above 2^53.
 */
function durationMs(startNano: string, endNano: string): number {
  try {
    return Number((BigInt(endNano) - BigInt(startNano)) / 1_000_000n);
  } catch {
    // Fallback for invalid input
    return 0;
  }
}

// ── Flat span type ────────────────────────────────────────────────────

type FlatSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  serviceName: string;
  startTime: string;
  durationMs: number;
  status: string;
  kind?: string;
  attributes: Record<string, string | number | boolean | string[]>;
};

// ── OTLP flattening ──────────────────────────────────────────────────

/** Extract service.name from resource attributes. */
function extractServiceName(resource: TempoResourceSpans["resource"]): string {
  if (!resource?.attributes) return "unknown";
  for (const attr of resource.attributes) {
    if (attr.key === "service.name" && attr.value.stringValue) {
      return attr.value.stringValue;
    }
  }
  return "unknown";
}

/** Resolve status code from numeric or string format. */
function resolveStatus(code: number | string | undefined): string {
  if (code === undefined || code === null) return "unset";
  if (typeof code === "string") return STATUS_STRING_MAP[code] ?? code;
  return STATUS_MAP[code] ?? "unset";
}

/** Resolve span kind from numeric or string format. */
function resolveKind(kind: number | string | undefined): string | undefined {
  if (kind === undefined || kind === null) return undefined;
  if (typeof kind === "string") return SPAN_KIND_STRING_MAP[kind] ?? kind;
  return SPAN_KIND_MAP[kind] ?? String(kind);
}

/** Normalize a trace/span ID — decode base64 to hex if needed. */
function normalizeId(id: string | undefined): string {
  if (!id) return "";
  return isBase64(id) ? base64ToHex(id) : id;
}

/**
 * Flatten deeply nested OTLP resourceSpans/batches into a sorted FlatSpan array.
 * Handles both formats:
 *   - OTLP JSON: { resourceSpans: [...] } — hex IDs, numeric kind/status
 *   - Protobuf-JSON (Tempo v2): { batches: [...] } — base64 IDs, string kind/status
 */
function flattenTrace(traceResult: TempoTraceResult, limit: number): { spans: FlatSpan[]; totalSpans: number } {
  const all: FlatSpan[] = [];

  // Tempo v2 returns `batches`, OTLP format uses `resourceSpans`
  const resourceSpansList = traceResult.resourceSpans ?? traceResult.batches ?? [];

  for (const rs of resourceSpansList) {
    const serviceName = extractServiceName(rs.resource);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        all.push({
          traceId: normalizeId(span.traceId),
          spanId: normalizeId(span.spanId),
          parentSpanId: normalizeId(span.parentSpanId) || undefined,
          operationName: span.name ?? span.operationName ?? "unknown",
          serviceName,
          startTime: new Date(Number(BigInt(span.startTimeUnixNano) / 1_000_000n)).toISOString(),
          durationMs: durationMs(span.startTimeUnixNano, span.endTimeUnixNano),
          status: resolveStatus(span.status?.code),
          kind: resolveKind(span.kind),
          attributes: resolveAttributes(span.attributes, MAX_ATTRIBUTES_PER_SPAN),
        });
      }
    }
  }

  const totalSpans = all.length;

  // Sort by start time (earliest first) — natural trace order
  all.sort((a, b) => a.startTime.localeCompare(b.startTime));

  return { spans: all.slice(0, limit), totalSpans };
}

// ── Search result formatting ──────────────────────────────────────────

function formatSearchTraces(traces: TempoSearchTrace[], limit: number) {
  const sliced = traces.slice(0, limit);

  return sliced.map((t) => ({
    traceId: t.traceID,
    rootServiceName: t.rootServiceName,
    rootTraceName: t.rootTraceName,
    startTime: new Date(Number(BigInt(t.startTimeUnixNano) / 1_000_000n)).toISOString(),
    durationMs: t.durationMs,
    spanCount: t.spanSets?.[0]?.matched ?? undefined,
  }));
}

// ── Tool factory ──────────────────────────────────────────────────────

export function createQueryTracesToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_query_traces",
    label: "Grafana Query Traces",
    description: [
      "Run a TraceQL query against a Tempo datasource in Grafana.",
      "WORKFLOW: Use for distributed tracing — find slow spans, debug request flows, investigate session traces.",
      "Two query types: 'search' (default) finds traces matching a TraceQL expression, 'get' retrieves a full trace by ID.",
      "Requires a datasourceUid — use grafana_explore_datasources to find Tempo datasources (type: 'tempo').",
      "PANEL RE-RUN: Set dashboardUid + panelId to re-run an existing panel's TraceQL query — no need to extract the query manually. Overrides query and datasourceUid.",
      "Search returns trace summaries (traceId, rootService, rootTrace, duration). Get returns flattened spans with resolved attributes.",
      "Use minDuration/maxDuration to find slow or fast spans. Use start/end to narrow the time window.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        datasourceUid: {
          type: "string",
          description: "UID of the Tempo datasource (use grafana_explore_datasources to find it). Optional when using dashboardUid + panelId.",
        },
        query: {
          type: "string",
          description: "TraceQL expression for search (e.g., '{ resource.service.name = \"openclaw\" }'), or trace ID for get. Optional when using dashboardUid + panelId.",
        },
        queryType: {
          type: "string",
          enum: ["search", "get"],
          description: "Query type: 'search' (default) for TraceQL trace search, 'get' for full trace by ID",
        },
        start: {
          type: "string",
          description: "Start time for search (default: 'now-1h'). Accepts: 'now-1h', 'now-30m', Unix seconds, or RFC3339",
        },
        end: {
          type: "string",
          description: "End time for search (default: 'now'). Accepts: 'now', Unix seconds, or RFC3339",
        },
        limit: {
          type: "number",
          description: "Max traces to return for search (default 20, max 50)",
        },
        minDuration: {
          type: "string",
          description: "Minimum trace duration filter (e.g., '100ms', '1s', '5s')",
        },
        maxDuration: {
          type: "string",
          description: "Maximum trace duration filter (e.g., '10s', '30s')",
        },
        dashboardUid: {
          type: "string",
          description: "Dashboard UID to resolve a panel's TraceQL query from (use with panelId).",
        },
        panelId: {
          type: "number",
          description: "Panel ID within the dashboard to re-run (use with dashboardUid).",
        },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const dashboardUid = readStringParam(params, "dashboardUid");
      const panelId = readNumberParam(params, "panelId");
      let datasourceUid = readStringParam(params, "datasourceUid");
      let query = readStringParam(params, "query");
      const queryType = readStringParam(params, "queryType") ?? "search";
      const start = readStringParam(params, "start") ?? "now-1h";
      const end = readStringParam(params, "end") ?? "now";
      const rawLimit = readNumberParam(params, "limit") ?? 20;
      const limit = Math.min(Math.max(1, rawLimit), MAX_SEARCH_TRACES);
      const minDuration = readStringParam(params, "minDuration");
      const maxDuration = readStringParam(params, "maxDuration");

      let panelMeta: { resolvedFrom: "panel"; panelTitle: string; panelType: string; templateVarsReplaced: boolean } | undefined;

      try {
        // ── Panel resolution ──────────────────────────────────────────
        if (dashboardUid && panelId != null) {
          const resolved = await resolvePanelQuery(client, dashboardUid, panelId);
          if ("error" in resolved) {
            return jsonResult({ error: resolved.error });
          }
          if (resolved.queryTool !== "grafana_query_traces") {
            return jsonResult({
              error: `Panel ${panelId} ('${resolved.panelTitle}') uses ${resolved.datasourceType} datasource. Use ${resolved.queryTool} with the same dashboardUid + panelId instead.`,
            });
          }
          query = query ?? resolved.expr;
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
        if (!query) {
          return jsonResult({ error: "Missing 'query'. Provide a TraceQL expression (for search) or trace ID (for get), or use dashboardUid + panelId to resolve from a panel." });
        }

        // ── Get trace by ID ─────────────────────────────────────────
        if (queryType === "get") {
          const traceResult = await client.getTrace(datasourceUid, query);
          const { spans, totalSpans } = flattenTrace(traceResult, MAX_TRACE_SPANS);

          return jsonResult({
            status: "success",
            queryType: "get",
            traceId: query,
            datasourceUid,
            totalSpans,
            spans,
            ...(totalSpans > spans.length ? { truncated: true, truncationHint: `Showing ${MAX_TRACE_SPANS} of ${totalSpans} spans. Use TraceQL search with span filters to find specific spans.` } : {}),
            ...(query ? {
              correlationHint: {
                logQuery: `{service_name="openclaw"} | json | trace_id = "${query}"`,
                tool: "grafana_query_logs",
                tip: "Find logs correlated with this trace. Always use | json | trace_id = ... (not |= line filter).",
              },
            } : {}),
            ...panelMeta,
          });
        }

        // ── Search traces ───────────────────────────────────────────
        const searchResult = await client.searchTraces(datasourceUid, query, {
          start,
          end,
          limit,
          minDuration: minDuration ?? undefined,
          maxDuration: maxDuration ?? undefined,
        });

        const traces = searchResult.traces ?? [];
        const totalTraces = traces.length;
        const formattedTraces = formatSearchTraces(traces, MAX_SEARCH_TRACES);

        return jsonResult({
          status: "success",
          queryType: "search",
          query,
          datasourceUid,
          totalTraces,
          traces: formattedTraces,
          ...(totalTraces > MAX_SEARCH_TRACES ? { truncated: true, truncationHint: `Showing ${MAX_SEARCH_TRACES} of ${totalTraces} traces. Narrow your TraceQL query or time range to see specific traces.` } : {}),
          ...(totalTraces > 0 ? {
            correlationHint: {
              logQuery: `{service_name="openclaw"} | json | trace_id = "${formattedTraces[0].traceId}"`,
              tool: "grafana_query_logs",
              tip: "Use this LogQL pattern with any traceId from the results to find correlated logs. Always use | json | trace_id = ... (not |= line filter).",
            },
          } : {}),
          ...(totalTraces === 0 ? { hint: { cause: "No traces found matching the query", suggestion: "Verify the Tempo datasource has data. Try a broader query like '{ }' or widen the time range. Use grafana_explore_datasources to confirm the datasource type is 'tempo'." } } : {}),
          ...panelMeta,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const guidance = getTraceQLGuidance(reason, query ?? "");
        return jsonResult({
          error: `Trace query failed: ${reason}`,
          ...(guidance ? { guidance } : {}),
        });
      }
    },
  });
}
