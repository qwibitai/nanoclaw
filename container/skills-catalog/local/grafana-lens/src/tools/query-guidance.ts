/**
 * Query error guidance — pattern-match PromQL/LogQL errors to structured hints.
 *
 * Addresses mcp-grafana #430: agents send bad PromQL blind and cannot recover
 * from cryptic errors like "parse error: unexpected end of input".
 *
 * Each guidance rule has a regex pattern and produces a structured hint with
 * cause, suggestion, and optional corrected example.
 */

// ── Types ─────────────────────────────────────────────────────────────

export interface QueryGuidance {
  cause: string;
  suggestion: string;
  example?: string;
}

// ── PromQL guidance rules ─────────────────────────────────────────────

interface GuidanceRule {
  pattern: RegExp;
  /** If present, also test the expression (not just the error message). */
  exprPattern?: RegExp;
  guidance: (match: RegExpMatchArray, expr: string) => QueryGuidance;
}

const PROMQL_RULES: GuidanceRule[] = [
  // ── Syntax errors ───────────────────────────────────────────────
  {
    pattern: /unclosed left parenthesis/i,
    guidance: () => ({
      cause: "Unclosed parenthesis in PromQL expression",
      suggestion: "Check for missing closing ')' — count opening and closing parentheses",
      example: "rate(http_requests_total[5m]) — ensure every '(' has a matching ')'",
    }),
  },
  {
    pattern: /unexpected end of input/i,
    guidance: () => ({
      cause: "Incomplete PromQL expression",
      suggestion: "The expression is truncated — ensure it's complete with all brackets and parentheses closed",
    }),
  },
  {
    pattern: /unexpected (right parenthesis|"\)")/i,
    guidance: () => ({
      cause: "Extra closing parenthesis in PromQL expression",
      suggestion: "Remove the extra ')' or add matching opening '('",
    }),
  },
  {
    pattern: /could not parse remaining input/i,
    guidance: (_m, expr) => ({
      cause: "PromQL syntax error — trailing invalid characters",
      suggestion: "Check for typos or extra characters at the end of the expression",
      example: expr ? `Verify: ${expr}` : undefined,
    }),
  },

  // ── Range/aggregation mistakes ──────────────────────────────────
  {
    pattern: /(?:expected type range vector|ranges only allowed for vector selectors)/i,
    guidance: () => ({
      cause: "Range vector expected — a function like rate() requires [duration] syntax",
      suggestion: "Add a range selector like [5m] to the metric inside rate(), increase(), or similar functions",
      example: "rate(http_requests_total[5m]) — not rate(http_requests_total)",
    }),
  },
  {
    pattern: /(?:expected type instant vector|vector selector must be wrapped)/i,
    guidance: () => ({
      cause: "Instant vector expected where a range vector was given",
      suggestion: "Remove the [duration] range selector — this context expects an instant vector",
      example: "sum(my_metric) — not sum(my_metric[5m])",
    }),
  },

  // ── Metric not found / label issues ─────────────────────────────
  {
    pattern: /(?:no match for|metric not found)/i,
    guidance: (_m, expr) => ({
      cause: "No data for this metric or label selector",
      suggestion: "Verify the metric name exists using grafana_list_metrics. Check label names/values with grafana_list_metrics in label mode. Common issue: metric is present but has different label values",
      example: expr.includes("{")
        ? "Try the metric name alone first without label filters to confirm it exists"
        : "Use grafana_list_metrics to search for similar metric names",
    }),
  },

  // ── Auth / connection errors ────────────────────────────────────
  {
    pattern: /authentication failed/i,
    guidance: () => ({
      cause: "Grafana service account token is invalid or expired",
      suggestion: "Check GRAFANA_SERVICE_ACCOUNT_TOKEN — the token may need rotation. Ensure the service account has Editor role",
    }),
  },
  {
    pattern: /rate limit/i,
    guidance: () => ({
      cause: "Query rate limited by Prometheus or Grafana",
      suggestion: "Wait a few seconds and retry. If persistent, simplify the query to reduce evaluation cost",
    }),
  },
  {
    pattern: /timeout|context deadline exceeded|context canceled/i,
    guidance: (_m, expr) => ({
      cause: "Query timed out — the expression is too expensive to evaluate",
      suggestion: "Narrow the time range, add label filters, or simplify the expression. Avoid {__name__=~'.+'} which scans all metrics",
      example: expr.includes("=~")
        ? "Replace broad regex matchers with specific label values"
        : "Try a shorter time range (e.g., now-1h instead of now-7d)",
    }),
  },

  // ── 4xx/5xx from Prometheus ─────────────────────────────────────
  {
    pattern: /bad_data/i,
    guidance: () => ({
      cause: "Prometheus rejected the query as malformed",
      suggestion: "Check PromQL syntax — common issues: missing brackets, invalid function names, wrong aggregation labels. Use grafana_explore_datasources to verify this is a Prometheus datasource",
    }),
  },
  {
    pattern: /execution/i,
    guidance: () => ({
      cause: "Prometheus execution error — the query is valid syntax but failed to run",
      suggestion: "Check if the datasource is healthy. Try a simpler query like 'up' to verify connectivity",
    }),
  },

  // ── Not found (wrong datasource) ───────────────────────────────
  {
    pattern: /Not found/i,
    guidance: () => ({
      cause: "Datasource not found or not a Prometheus datasource",
      suggestion: "Use grafana_explore_datasources to verify the datasource UID and type. If this is a Loki datasource, use grafana_query_logs instead",
    }),
  },
];

const LOGQL_RULES: GuidanceRule[] = [
  // ── Stream selector issues ──────────────────────────────────────
  {
    pattern: /unexpected IDENTIFIER/i,
    guidance: () => ({
      cause: "LogQL requires a stream selector — bare text is not valid",
      suggestion: "Wrap your query in a stream selector: {job=\"your-service\"} |= \"your text\"",
      example: '{job="api"} |= "error" — not just "error"',
    }),
  },
  {
    pattern: /queries require at least one regexp or equality/i,
    guidance: () => ({
      cause: "Empty stream selector {} — Loki requires at least one label matcher",
      suggestion: "Add a label filter: {job=\"your-service\"} or {service_name=\"your-service\"}. Use grafana_explore_datasources to find available Loki labels",
      example: '{job="api"} |= "error" — not {} |= "error"',
    }),
  },
  {
    pattern: /unexpected \$end/i,
    guidance: () => ({
      cause: "Incomplete LogQL expression — unexpected end of input",
      suggestion: "Check for unclosed braces, missing quotes, or incomplete pipeline stages",
      example: '{job="api"} |= "error" — ensure all { } and \" \" are properly closed',
    }),
  },

  // ── Pipeline/parser errors ──────────────────────────────────────
  {
    pattern: /unexpected.*expecting (STRING|CLOSE_BRACE|PIPE)/i,
    guidance: (_m) => ({
      cause: "LogQL syntax error in stream selector or pipeline",
      suggestion: "Check your label matchers and pipeline stages. Labels use = for exact match, =~ for regex. Pipeline stages: |= (contains), != (not contains), | json, | logfmt",
    }),
  },

  // ── Metric query on logs issues ─────────────────────────────────
  {
    pattern: /(?:expected type range vector|ranges only allowed)/i,
    guidance: () => ({
      cause: "LogQL metric query requires a range — [duration] syntax",
      suggestion: "Add a range selector for log metric queries",
      example: 'rate({job="api"} |= "error" [5m]) — the [5m] must wrap the full log selector',
    }),
  },

  // ── Auth/connection (shared patterns) ───────────────────────────
  {
    pattern: /authentication failed/i,
    guidance: () => ({
      cause: "Grafana service account token is invalid or expired",
      suggestion: "Check GRAFANA_SERVICE_ACCOUNT_TOKEN — ensure the service account has Editor role",
    }),
  },
  {
    pattern: /timeout|context deadline exceeded/i,
    guidance: () => ({
      cause: "Log query timed out — too much data scanned",
      suggestion: "Narrow the time range (e.g., now-15m instead of now-24h), add label filters, or use line filters (|= or !=) to reduce scan scope",
    }),
  },
  {
    pattern: /Not found/i,
    guidance: () => ({
      cause: "Datasource not found or not a Loki datasource",
      suggestion: "Use grafana_explore_datasources to verify the datasource UID and type. If this is a Prometheus datasource, use grafana_query instead",
    }),
  },
];

const TRACEQL_RULES: GuidanceRule[] = [
  // ── Syntax errors ───────────────────────────────────────────────
  {
    pattern: /unexpected.*expecting/i,
    guidance: () => ({
      cause: "TraceQL syntax error",
      suggestion: "Check braces and attribute syntax. TraceQL uses { } for span selectors and resource.attr / span.attr for attributes",
      example: '{ resource.service.name = "openclaw" } — note: string values require double quotes',
    }),
  },
  {
    pattern: /invalid attribute/i,
    guidance: () => ({
      cause: "Invalid or unknown attribute in TraceQL expression",
      suggestion: "Use 'resource.' prefix for resource attributes, 'span.' for span attributes. Common: resource.service.name, span.http.status_code, name, duration, status",
    }),
  },
  {
    pattern: /empty query/i,
    guidance: () => ({
      cause: "Empty TraceQL query",
      suggestion: "Provide a TraceQL expression. Simple: { } to match all traces. Filtered: { resource.service.name = \"openclaw\" }",
      example: '{ resource.service.name = "openclaw" && duration > 1s }',
    }),
  },

  // ── Auth/connection ─────────────────────────────────────────────
  {
    pattern: /authentication failed/i,
    guidance: () => ({
      cause: "Grafana service account token is invalid or expired",
      suggestion: "Check GRAFANA_SERVICE_ACCOUNT_TOKEN — ensure the service account has Editor role",
    }),
  },
  {
    pattern: /timeout|context deadline exceeded/i,
    guidance: () => ({
      cause: "Trace search timed out — too many traces matched",
      suggestion: "Narrow the time range, add attribute filters, or set minDuration/maxDuration to reduce scope",
    }),
  },
  {
    pattern: /Not found/i,
    guidance: () => ({
      cause: "Datasource not found or not a Tempo datasource",
      suggestion: "Use grafana_explore_datasources to verify the datasource UID and type. Use grafana_query for Prometheus, grafana_query_logs for Loki",
    }),
  },

  // ── Trace ID issues ─────────────────────────────────────────────
  {
    pattern: /trace.*not found|failed to get trace/i,
    guidance: () => ({
      cause: "Trace ID not found in Tempo",
      suggestion: "The trace may have expired (check Tempo retention) or the ID may be incorrect. Use queryType 'search' to find recent traces first",
    }),
  },
  {
    pattern: /invalid trace id/i,
    guidance: () => ({
      cause: "Invalid trace ID format — must be a 32-character hex string",
      suggestion: "Trace IDs are 32 hex chars (e.g., 'abc123def456...'). Get valid IDs from a search query or from trace_id fields in log entries",
    }),
  },
];

// ── Public API ────────────────────────────────────────────────────────

/** Match an error against a rule list, returning the first matching guidance. */
function matchGuidanceRule(rules: GuidanceRule[], error: string, expr: string): QueryGuidance | undefined {
  for (const rule of rules) {
    const match = error.match(rule.pattern);
    if (match) {
      if (rule.exprPattern && !rule.exprPattern.test(expr)) continue;
      return rule.guidance(match, expr);
    }
  }
  return undefined;
}

/**
 * Match a PromQL error to structured guidance for agent recovery.
 * Returns undefined if no pattern matches.
 */
export function getPromQLGuidance(error: string, expr: string): QueryGuidance | undefined {
  return matchGuidanceRule(PROMQL_RULES, error, expr);
}

/**
 * Match a LogQL error to structured guidance for agent recovery.
 * Returns undefined if no pattern matches.
 */
export function getLogQLGuidance(error: string, expr: string): QueryGuidance | undefined {
  return matchGuidanceRule(LOGQL_RULES, error, expr);
}

/**
 * Match a TraceQL error to structured guidance for agent recovery.
 * Returns undefined if no pattern matches.
 */
export function getTraceQLGuidance(error: string, expr: string): QueryGuidance | undefined {
  return matchGuidanceRule(TRACEQL_RULES, error, expr);
}

// ── Prometheus warnings (infos field) ─────────────────────────────────

/**
 * Parse Prometheus "infos" field into structured warnings.
 *
 * Prometheus returns an `infos` array on successful queries when there are
 * non-fatal issues (e.g., applying rate() to a gauge metric). The tool should
 * surface these so the agent can self-correct.
 */
export function parsePrometheusWarnings(infos: string[] | undefined): QueryGuidance[] | undefined {
  if (!infos?.length) return undefined;

  const warnings: QueryGuidance[] = [];

  for (const info of infos) {
    // "metric might not be a counter, name does not end in _total/_sum/_count/_bucket"
    if (info.includes("might not be a counter")) {
      const metricMatch = info.match(/"([^"]+)"/);
      const metricName = metricMatch?.[1] ?? "unknown";
      warnings.push({
        cause: `rate() applied to '${metricName}' which appears to be a gauge, not a counter`,
        suggestion: "Gauges measure current values (e.g., temperature, queue depth). Use rate() only on counters (names ending in _total, _sum, _count, _bucket). For gauge change over time, use delta() or deriv() instead",
        example: `delta(${metricName}[5m]) — measures change over 5 minutes for a gauge`,
      });
    } else {
      // Generic warning passthrough
      warnings.push({
        cause: info,
        suggestion: "Review the query — Prometheus flagged a potential issue",
      });
    }
  }

  return warnings.length > 0 ? warnings : undefined;
}

// ── Empty result hint ─────────────────────────────────────────────────

/**
 * Generate a hint when a query returns no data (empty result set).
 * This is not an error — Prometheus returns success with empty results —
 * but the agent may not know why there's no data.
 */
export function getEmptyResultHint(expr: string): QueryGuidance {
  if (expr.includes("{") && expr.includes("=")) {
    return {
      cause: "Query returned no data — the metric exists but no series match the label filters",
      suggestion: "Verify label names and values. Use grafana_list_metrics with labels: true to see available label values. Try the metric name alone without label filters to confirm data exists",
    };
  }
  return {
    cause: "Query returned no data — the metric may not exist or have no recent data points",
    suggestion: "Verify the metric name using grafana_list_metrics. Check that the datasource is receiving data (try 'up' to test connectivity). If querying custom metrics, ensure they've been pushed recently",
  };
}
