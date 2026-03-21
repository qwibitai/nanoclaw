---
name: grafana-lens
description: "Grafana tools for data visualization, monitoring, alerting, security, and SRE investigation. Use grafana_query, grafana_query_logs, grafana_query_traces, grafana_create_dashboard, grafana_update_dashboard, grafana_create_alert, grafana_share_dashboard, grafana_annotate, grafana_explore_datasources, grafana_list_metrics, grafana_search, grafana_get_dashboard, grafana_check_alerts, grafana_push_metrics, grafana_explain_metric, grafana_security_check, and grafana_investigate. Trigger when asked about metrics, dashboards, monitoring, alerts, costs, token usage, data visualization, PromQL, Prometheus, LogQL, Loki, log queries, error logs, log search, TraceQL, Tempo, traces, distributed tracing, span search, find slow traces, debug session traces, annotations, deployments, sharing charts, investigating alert notifications, pushing custom data (calendar, git, fitness, finance) to Grafana for visualization, pushing historical data, backfilling metrics, recording past data with timestamps, modifying dashboards, adding panels, removing panels, changing dashboard settings, updating dashboard time range, explain metric, metric trend, what is this metric, how has this changed, is this metric normal, why did my bill spike, cost visibility, security monitoring, security check, security audit, am I being attacked, is my agent compromised, suspicious activity, threat detection, prompt injection detection, set up security alerts, investigate, debug, triage, root cause, what's wrong, why is X broken, anomaly detection, RED method, USE method, alert fatigue, postmortem, incident summary."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔭",
        "requires": { "config": ["grafana.url", "grafana.apiKey"] },
      },
  }
---

# Grafana Lens

You have full native Grafana access — query data, create dashboards, set alerts, receive alert notifications, annotate events, explore datasources, push custom data, and deliver visualizations inline. Works with ANY data in Grafana, not just agent metrics.

## Musts

- **Always call `grafana_explore_datasources` first** when you need a datasource UID — never guess UIDs
- **Always call `grafana_search` before creating a dashboard** — avoid duplicates
- **Always call `grafana_get_dashboard` before `grafana_share_dashboard`** — you need exact panel IDs
- **Always call `grafana_get_dashboard` before `grafana_update_dashboard`** — you need panel IDs and current structure
- **Prefer `grafana_query` for direct answers** over creating dashboards — "what's my cost?" needs a number, not a URL
- **Prefer `grafana_query` over `grafana_create_dashboard` + `grafana_share_dashboard`** for simple data questions — a number is faster than a chart
- **Use `grafana_query_logs` for log searches** — LogQL for logs, PromQL for metrics, TraceQL for traces. Never use `grafana_query` for Loki datasources
- **Use `grafana_query_traces` for trace searches** — TraceQL for traces, PromQL for metrics, LogQL for logs. Never use `grafana_query` or `grafana_query_logs` for Tempo datasources
- **All tools work with ANY Prometheus datasource** — not just `openclaw_lens_*` metrics
- **When you see "GRAFANA ALERTS" in prompt context**, investigate immediately with `grafana_check_alerts` — use the `suggestedInvestigation` field to go directly to querying (it provides the tool, query, and datasource)
- **Run `grafana_check_alerts` with action `setup` once** before alert notifications can reach the agent — this creates the webhook contact point
- **Push data before querying or dashboarding it** — data is pushed via OTLP and available immediately
- **Prefer `grafana_explain_metric` for "what is this metric?" questions** over manual `grafana_query` — it returns current value, trend, stats, and metadata in one call
- **Use `queryNames` from push response for PromQL queries** — don't guess metric names (counters get `_total` suffix)
- **Use `openclaw_ext_` prefix for custom metrics** — `grafana_push_metrics` auto-prepends it if missing
- **Follow statistics-first discipline for log investigation** — always run count/rate LogQL before reading individual entries. Use `grafana_query_logs` with metric-over-logs queries (`count_over_time`, `rate`, `topk`) before switching to raw log entries
- **Silence alerts during investigation** — use `grafana_check_alerts` with action `silence` to prevent repeat notifications while investigating
- **Use `list_rules` for complete alert health** — `grafana_check_alerts` with action `list_rules` returns all rules with live eval state (normal/firing/pending/nodata/error), health, and lastEvaluation — no need to cross-reference with `list` action
- **Use `dashboardUid` + `panelId` to re-run panel queries** — don't manually extract PromQL/LogQL from `get_dashboard` output. Both `grafana_query` and `grafana_query_logs` accept these params to auto-resolve the panel's query expression and datasource. The tool handles template variable replacement and datasource routing automatically
- **Confirm with user before deleting dashboards or alert rules** — `grafana_update_dashboard` with operation `delete` and `grafana_check_alerts` with action `delete_rule` are permanent and cannot be undone

## Quick Decision Tree

- "What is [metric]?" / "Why did it spike?" → `grafana_explain_metric`
- "What's the current value of X?" / complex PromQL → `grafana_query`
- "Find error logs" / "Search logs for..." → `grafana_query_logs`
- "Find slow traces" / "Show trace for session X" / "Debug distributed spans" → `grafana_query_traces`
- "Debug this session" / "Why did it fail?" / "What went wrong?" → `grafana_query_traces` (search error/slow) → `grafana_query_traces` (get → follow `correlationHint`) → `grafana_query_logs` → `grafana_query` → `grafana_annotate`
- "Show me a chart" / "Visualize..." → `grafana_search` → `grafana_get_dashboard` → `grafana_share_dashboard`
- "Create a dashboard for..." → `grafana_search` (check duplicates) → `grafana_create_dashboard`
- "Add a panel to my dashboard" → `grafana_get_dashboard` → `grafana_update_dashboard`
- "Delete this dashboard" → `grafana_update_dashboard` with operation `delete` (confirm with user first)
- "Alert me when..." → `grafana_check_alerts` (setup) → `grafana_create_alert`
- "List my alert rules" / "What alerts do I have?" → `grafana_check_alerts` with action `list_rules`
- "Delete alert rule X" → `grafana_check_alerts` with action `list_rules` → `delete_rule` with `ruleUid`
- "Track my [custom data]" / "Record my [past data]" → `grafana_push_metrics` (with optional `timestamp` for historical data, auto-registers, returns `queryNames`) → `grafana_query` with `queryNames`
- "What data sources do I have?" → `grafana_explore_datasources`
- "What metrics are available?" → `grafana_list_metrics`
- "Set up monitoring" / "Monitor my agent" / "What dashboards should I have?" → `grafana_search` (check existing) → `grafana_create_dashboard` with `llm-command-center` → follow `suggestedNext` chain through remaining templates
- "GenAI observability" / "OTel gen_ai metrics" / "Standard AI monitoring" → `grafana_create_dashboard` with `genai-observability` template
- "What happened in session X?" / "Debug this session" → `grafana_create_dashboard` with `session-explorer` template → paste session ID
- "Show me LLM traces" / "Show agent logs" → `grafana_create_dashboard` with `llm-command-center` template (Loki + Tempo)
- "How much am I spending?" / "Cost analysis" → `grafana_create_dashboard` with `cost-intelligence` template
- "Which tools are slow?" / "Tool errors" → `grafana_create_dashboard` with `tool-performance` template
- "Queue health" / "Webhook issues" / "Stuck sessions" → `grafana_create_dashboard` with `sre-operations` template
- "System health check" / "Status report" / "Review all dashboards" → `grafana_explore_datasources` → `grafana_check_alerts` (list + list_rules) → `grafana_search` → `grafana_get_dashboard` (audit=true for each) → summarize
- "Audit my dashboard" / "Which panels are broken?" → `grafana_get_dashboard` (audit=true) → review `auditSummary` + per-panel `health`
- "Am I being attacked?" / "Security check" / "Security status" → `grafana_security_check`
- "Set up security monitoring" → `grafana_check_alerts` (setup) → `grafana_create_dashboard` (`security-overview`) → `grafana_create_alert` (webhook error burst, cost spike, tool loops, injection signals)
- "Investigate security alert" → `grafana_security_check` → `grafana_query_logs` (correlate) → `grafana_annotate` (mark investigation) → `grafana_check_alerts` (silence)
- "Investigate this alert" / "Why is X broken?" / "Debug this issue" / "Triage" / "Root cause" → `grafana_investigate` (multi-signal triage) → follow `suggestedHypotheses.testWith` for deep-dives
- "Is this metric normal?" / "Is there an anomaly?" → `grafana_explain_metric` (returns `anomaly` z-score + `seasonality` vs 1d/7d ago for 24h period)
- "RED analysis" / "What's the error rate?" / "Service health" → RED Method queries (see sre-investigation.md §2)
- "Alert fatigue" / "Which alerts are noisy?" / "Alert health" → `grafana_check_alerts` with action `analyze` — fatigue report
- "Postmortem" / "Incident summary" / "What happened?" → `grafana_investigate` → 5-Phase methodology → postmortem template (see sre-investigation.md §9)
- "Compare before/after deployment" → `grafana_annotate` (list, tags: ["deploy"]) → `grafana_explain_metric` (compareWith: "previous")

## Tool Inventory

| Tool | What It Does |
|------|-------------|
| `grafana_explore_datasources` | Discover configured datasources (UIDs, types, query routing) — tells you which tool + query language to use for each datasource |
| `grafana_list_metrics` | Discover available metrics or label values from a datasource. Use `compact: true` with `metadata: true` for minimal fields in multi-tool chains |
| `grafana_query` | Run PromQL instant/range queries — get numbers directly |
| `grafana_query_logs` | Run LogQL queries against Loki — search and filter logs |
| `grafana_query_traces` | Run TraceQL queries against Tempo — search traces or get full trace by ID |
| `grafana_create_dashboard` | Create dashboards from templates or custom JSON |
| `grafana_update_dashboard` | Add/remove/update panels, change dashboard metadata, or delete dashboard |
| `grafana_get_dashboard` | Get dashboard summary (panels, queries). Use `compact: true` for overview scans, `audit: true` to health-check all panels in one call |
| `grafana_search` | Search existing dashboards by title, tags, or starred status |
| `grafana_share_dashboard` | Render panel as image and deliver inline via messaging |
| `grafana_create_alert` | Create Grafana-native alert rules on any metric |
| `grafana_annotate` | Create or list annotations (events) on dashboards |
| `grafana_check_alerts` | Check, acknowledge, list/delete rules, silence/unsilence, or set up Grafana alert webhook notifications. Use `compact: true` with `list_rules` for minimal fields |
| `grafana_push_metrics` | Push custom data (calendar, git, fitness, finance) via OTLP |
| `grafana_explain_metric` | Get metric context: current value, trend, stats, metadata, drill-down queries — agent interprets |
| `grafana_security_check` | Run 6 parallel security checks and return threat-level assessment (green/yellow/red) — "Am I being attacked?" |
| `grafana_investigate` | Multi-signal investigation triage — gathers metrics, logs, traces, and context in parallel, generates hypotheses with specific tool+params for follow-up |

## Tool Details

### `grafana_explore_datasources`
**When**: First step when user mentions data, metrics, or monitoring. Gets datasource UIDs needed by `grafana_query`, `grafana_query_logs`, `grafana_query_traces`, `grafana_list_metrics`, `grafana_create_alert`, and `grafana_explain_metric`.
**Params**: None required.
**Example**: `{}`
**Returns**: List of datasources with `uid`, `name`, `type`, `isDefault`, plus routing hints: `queryTool` (which agent tool to use, e.g. `"grafana_query"`, `"grafana_query_logs"`, or `"grafana_query_traces"`), `queryLanguage` (e.g. `"PromQL"`, `"LogQL"`, `"TraceQL"`), and `supported` (boolean — whether an agent tool can query this datasource). Use `queryTool` to pick the right tool for each datasource.

### `grafana_list_metrics`
**When**: User asks "what metrics are available?" or you need to discover metrics before querying or composing dashboards. Also when grouping metrics by function — metadata mode adds `category` to each `openclaw_*` metric. Use `purpose` when user asks about a specific concern (e.g., "performance metrics", "cost metrics").
**Params**: `datasourceUid` (required), `prefix` (filter by prefix), `search` (targeted discovery — server-side regex, only matching metrics returned), `purpose` (`"performance"` | `"cost"` | `"reliability"` | `"capacity"` — pre-filter by intent, composable with prefix and search), `label` (list label values instead), `metadata` (boolean — enriched results with type/help/category), `compact` (boolean — with metadata, returns only name/type/category, ~60% smaller).
**Example names**: `{ "datasourceUid": "prom1", "prefix": "openclaw_lens_" }`
**Example search**: `{ "datasourceUid": "prom1", "search": "steps" }`
**Example purpose**: `{ "datasourceUid": "prom1", "purpose": "performance", "metadata": true }`
**Example combined**: `{ "datasourceUid": "prom1", "prefix": "openclaw_ext_", "search": "fitness" }`
**Example metadata**: `{ "datasourceUid": "prom1", "metadata": true, "prefix": "openclaw_" }`
**Example compact**: `{ "datasourceUid": "prom1", "metadata": true, "compact": true }`
**Returns names**: `{ metrics: ["metric1", "metric2", ...] }`. Truncated at 200.
**Returns metadata**: `{ metadataSource, categorySummary: { cost: 3, usage: 4, session: 5, ... }, metrics: [{ name, type, help, category?, source? }, ...] }`. Use this before composing custom dashboards — type tells you counter vs gauge vs histogram, category groups `openclaw_*` metrics by function. Search also matches help text. Categories: `cost`, `usage`, `session`, `queue`, `messaging`, `webhook`, `tools`, `agent`, `custom`. `categorySummary` gives counts per category for quick overview (omitted when no `openclaw_*` metrics). Purpose maps: `performance` → session + tools, `cost` → cost + usage, `reliability` → webhook + messaging + agent, `capacity` → queue + session. `metadataSource`: `"prometheus"` when Prometheus metadata endpoint has data, `"synthetic"` when OTLP-only (metadata synthesized from known metric registry — histogram sub-metrics deduplicated, type/help from Grafana Lens definitions). On OTLP stacks, includes `hint` explaining why metadata is synthetic. `source: "synthetic"` on individual entries from the registry; `source: "custom"` on entries from the custom metrics store.
**Returns compact**: `{ metadataSource, categorySummary: {...}, metrics: [{ name, type, category? }, ...] }`. Same as metadata but drops `help`, `source`, `labelNames` — use in multi-tool chains where you need metric names and types but not full descriptions.
**Example label**: `{ "datasourceUid": "prom1", "label": "job" }`
**Returns label**: `{ label, count, totalCount, values: ["value1", "value2", ...] }`. Truncated at 200.

### `grafana_query`
**When**: User asks a data question that needs a direct answer, not a dashboard. Also for re-running an existing dashboard panel's query with different time ranges.
**Params**: `datasourceUid`, `expr` (PromQL), `queryType` (`instant`/`range`), `start` (range only, required), `end` (range only, default `"now"`), `step` (range only, optional — auto-calculated from time range if omitted, targeting ~300 datapoints), `dashboardUid` (optional — resolve query from panel), `panelId` (optional — use with `dashboardUid`).
**Example instant**: `{ "datasourceUid": "prom1", "expr": "sum(increase(openclaw_lens_cost_by_model_total[1d])) or vector(0)" }`
**Example range (auto-step)**: `{ "datasourceUid": "prom1", "expr": "rate(openclaw_tokens_total[5m])", "queryType": "range", "start": "now-30d" }`
**Example range (explicit step)**: `{ "datasourceUid": "prom1", "expr": "rate(openclaw_tokens_total[5m])", "queryType": "range", "start": "now-1h", "end": "now", "step": "60" }`
**Example panel re-run**: `{ "dashboardUid": "openclaw-command-center", "panelId": 10, "queryType": "range", "start": "now-7d" }`
**Tip**: `start`/`end` accept Unix seconds or relative expressions like `"now-1h"`, `"now-7d"`. For range queries, just set `start` — `end` defaults to `"now"` and `step` is auto-calculated. Override `step` only when you need specific resolution.
**Tip (panel re-run)**: Set `dashboardUid` + `panelId` to re-run a panel's query without manually extracting PromQL. The tool auto-resolves `expr` and `datasourceUid` from the panel definition. Template variables are replaced with wildcards. You can still override `expr` or `datasourceUid` explicitly if needed. Get panel IDs from `grafana_get_dashboard`.
**Returns instant**: `{ metrics: [{ metric: {...}, value: "1.23", timestamp: "...", healthContext?: { status, thresholds, description, direction } }], datasourceUid, resultCount, warnings?, hint? }` — `healthContext` is included for well-known `openclaw_lens_*` gauge metrics, providing SRE-grade health assessment: `status` ("healthy"/"warning"/"critical"), `thresholds` (warning/critical values), `description` (what the metric means), `direction` ("higher_is_worse"/"lower_is_worse"). Omitted for unknown metrics. Capped at 50 results; when exceeded includes `truncated: true`, `totalResults`, and `truncationHint` advising to narrow the query.
**Returns range**: `{ series: [{ metric: {...}, values: [{ time, value }...] }], datasourceUid, resultCount, warnings?, hint? }` — truncated to 20 points per series and 50 series max. When series are truncated includes `truncated: true`, `totalSeries`, and `truncationHint`. When step is auto-calculated, includes `step: { value: "288s", display: "5m", auto: true }`.
**Returns (panel re-run)**: Includes `resolvedFrom: "panel"`, `panelTitle`, `panelType`, `templateVarsReplaced` alongside normal query results. If the panel uses a Loki datasource, returns an error directing you to use `grafana_query_logs` instead.
**Returns (warnings)**: When Prometheus flags a non-fatal issue (e.g., `rate()` on a gauge), `warnings: [{ cause, suggestion, example? }]` is included. Example: `rate()` on a gauge → cause says "rate() applied to 'metric' which appears to be a gauge", suggestion says "use delta() or deriv() instead", example shows the corrected query.
**Returns (hint)**: When the query returns zero results, `hint: { cause, suggestion }` explains why (metric may not exist, label filters may not match) and suggests using `grafana_list_metrics` to verify.
**Returns (error with guidance)**: On query failure, includes `guidance: { cause, suggestion, example? }` alongside the raw error. Pattern-matched for common PromQL mistakes: unclosed parenthesis, missing range selector, timeout, auth failure, rate on gauge, etc. Omitted when the error is unrecognized.
**Tip (chaining)**: Both instant and range responses include `datasourceUid` — pass it directly to `grafana_create_alert` or other tools without re-calling `grafana_explore_datasources`. This enables zero-friction query→alert chains.

### `grafana_query_logs`
**When**: User asks about logs, errors, or needs to investigate issues by searching log data. Also for session debugging, OTel log investigation, and re-running existing log panel queries.
**Params**: `datasourceUid`, `expr` (LogQL), `queryType` (`instant`/`range`, default `range`), `start`/`end` (default `now-1h`/`now`), `step` (metric queries only), `limit` (default 100), `direction` (`backward`/`forward`), `lineLimit` (max chars per log line, default 500, max 2000), `extractFields` (boolean, default false — extract structured OTel attributes into a clean `fields` object), `dashboardUid` (optional — resolve query from panel), `panelId` (optional — use with `dashboardUid`).
**Example log search**: `{ "datasourceUid": "loki1", "expr": "{job=\"api\"} |= \"error\"" }`
**Example with filters**: `{ "datasourceUid": "loki1", "expr": "{job=\"api\"} |~ \"timeout|refused\"", "limit": 50, "direction": "forward" }`
**Example full stack traces**: `{ "datasourceUid": "loki1", "expr": "{job=\"api\"} |= \"Exception\"", "lineLimit": 2000 }`
**Example session debugging**: `{ "datasourceUid": "loki1", "expr": "{service_name=\"openclaw\"} | json | component=\"lifecycle\"", "extractFields": true }`
**Example metric query**: `{ "datasourceUid": "loki1", "expr": "rate({job=\"api\"}[5m])", "queryType": "range", "start": "now-6h", "end": "now", "step": "60" }`
**Example panel re-run**: `{ "dashboardUid": "openclaw-command-center", "panelId": 18, "start": "now-24h", "extractFields": true }`
**Returns streams**: `{ entries: [{ labels: {...}, timestamp: "...", line: "..." }], datasourceUid, totalEntries, truncated }` — capped at 100 entries, lines at 500 chars (set `lineLimit: 2000` for full stack traces).
**Returns streams (extractFields)**: `{ entries: [{ labels: {...cleaned...}, timestamp: "...", line: "...", fields: { component, event_name, session_id, trace_id, model, duration_s, ... } }], datasourceUid }` — infrastructure noise labels removed, `openclaw_` prefix stripped from field keys, numeric values auto-converted. Also parses JSON log bodies if present.
**Returns streams (traceCorrelation)**: When `extractFields: true` and entries contain `trace_id`, includes `traceCorrelation: { traceIds: [...], tool: "grafana_query_traces", tip }` — up to 5 unique trace IDs ready for `grafana_query_traces` with `queryType: "get"`.
**Returns metric**: Same shape as `grafana_query` range/instant results (matrix capped at 50 series, vector capped at 50 results — includes `datasourceUid`, `truncated`, `totalSeries`/`totalResults`, and `truncationHint` when exceeded).
**Returns (panel re-run)**: Includes `resolvedFrom: "panel"`, `panelTitle`, `panelType`, `templateVarsReplaced` alongside normal results. If the panel uses a Prometheus datasource, returns an error directing you to use `grafana_query` instead.
**Returns (error with guidance)**: On query failure, includes `guidance: { cause, suggestion, example? }` alongside the raw error. Pattern-matched for common LogQL mistakes: bare text without stream selector, empty `{}`, unclosed braces, missing label matchers, auth failure, timeout. Omitted when the error is unrecognized.
**Tip**: LogQL: `{label="value"}` selects streams, `|=` substring filter, `|~` regex, `!=` exclude. Metric wrappers: `rate()`, `count_over_time()`, `bytes_rate()`. Use `extractFields: true` when investigating OTel/lifecycle logs — it surfaces `trace_id`, `session_id`, `event_name`, `model`, and other attributes as first-class fields instead of buried in raw labels.
**Tip (panel re-run)**: Same as `grafana_query` — set `dashboardUid` + `panelId` to auto-resolve LogQL and datasource. The tool routes Prometheus panels to `grafana_query` with a helpful error.

### `grafana_query_traces`
**When**: User asks about traces, distributed tracing, slow spans, session trace hierarchies, or needs to debug request flows across services.
**Params**: `datasourceUid`, `query` (TraceQL expression or trace ID), `queryType` (`search`/`get`, default `search`), `start`/`end` (default `now-1h`/`now`), `limit` (default 20, max 50), `minDuration`/`maxDuration` (e.g., `"1s"`, `"10s"`), `dashboardUid` (optional — resolve query from panel), `panelId` (optional — use with `dashboardUid`).
**Example search**: `{ "datasourceUid": "tempo1", "query": "{ resource.service.name = \"openclaw\" }" }`
**Example search slow**: `{ "datasourceUid": "tempo1", "query": "{ resource.service.name = \"openclaw\" }", "minDuration": "5s" }`
**Example search with time**: `{ "datasourceUid": "tempo1", "query": "{ span.gen_ai.system = \"anthropic\" }", "start": "now-24h", "limit": 50 }`
**Example get**: `{ "datasourceUid": "tempo1", "query": "abc123def456789...", "queryType": "get" }`
**Example panel re-run**: `{ "dashboardUid": "openclaw-session-explorer", "panelId": 12, "start": "now-24h" }`
**Returns search**: `{ traces: [{ traceId, rootServiceName, rootTraceName, startTime, durationMs, spanCount? }], datasourceUid, totalTraces, truncated?, correlationHint? }` — capped at 50 traces. When exceeded includes `truncated: true` and `truncationHint`. When traces are found, includes `correlationHint: { logQuery, tool, tip }` with a ready-to-use LogQL expression for `grafana_query_logs`.
**Returns get**: `{ traceId, spans: [{ traceId, spanId, parentSpanId?, operationName, serviceName, startTime, durationMs, status, kind?, attributes: {...} }], datasourceUid, totalSpans, truncated? }` — flattened OTLP spans with resolved attributes (string/number/boolean). Capped at 200 spans. Sorted by start time (earliest first).
**Returns (panel re-run)**: Includes `resolvedFrom: "panel"`, `panelTitle`, `panelType`, `templateVarsReplaced` alongside normal results. If the panel uses a Prometheus or Loki datasource, returns an error directing you to use the correct tool.
**Returns (error with guidance)**: On query failure, includes `guidance: { cause, suggestion, example? }` alongside the raw error. Pattern-matched for common TraceQL mistakes: syntax errors, invalid attributes, auth failure, timeout, not-found, invalid trace ID. Omitted when the error is unrecognized.
**Returns (no results)**: When search returns zero traces, includes `hint: { cause, suggestion }` suggesting to broaden the query or check the datasource.
**Tip**: TraceQL: `{ }` matches all traces, `resource.service.name` for service filter, `span.http.status_code` for HTTP spans, `name` for operation name, `duration` for span duration, `status` for error/ok filtering. Use `minDuration`/`maxDuration` to find performance outliers. **Trace-to-Log**: search and get results include `correlationHint.logQuery` — pass it directly to `grafana_query_logs` to find correlated logs. **Log-to-Trace**: `grafana_query_logs` results (with `extractFields: true`) include `traceCorrelation.traceIds` — pass any ID to `grafana_query_traces` with `queryType: "get"`.
**Tip (panel re-run)**: Same as `grafana_query` — set `dashboardUid` + `panelId` to auto-resolve TraceQL and datasource. The tool routes Prometheus/Loki panels to the correct tool with a helpful error.

### `grafana_create_dashboard`
**When**: User wants a persistent dashboard for ongoing monitoring.
**Params**: `template` or `dashboard` (custom JSON) — one required. Optional: `title` (overrides template default), `folderUid` (target folder), `overwrite` (default `true`).
**Returns**: `{ uid, url, status, message, suggestedNext?: [{ template, reason }], validation?: DashboardValidation }`. For template-based dashboards, `suggestedNext` lists complementary templates to deploy next. For custom JSON dashboards, `validation` dry-runs each panel's PromQL and reports per-panel health — check `validation.panelsError` for broken queries.

**Choose the right template (3-tier SRE drill-down hierarchy):**

**Tier 1 → System:** Start here for overall health.
**Tier 2 → Session:** Click a session from Tier 1 to investigate.
**Tier 3 → Deep Dive:** Cost, tool, or SRE details.

| Template | Tier | Domain | Variables | Use When |
|----------|------|--------|-----------|----------|
| `llm-command-center` | **Tier 1** | System overview | `$prometheus`, `$loki`, `$tempo`, `$provider`, `$model`, `$channel` | Golden signals, session table with click-to-drill-down, cost, cache, live feeds |
| `session-explorer` | **Tier 2** | Session debug | `$prometheus`, `$loki`, `$tempo`, `$session` (textbox) | Per-session trace hierarchy, LLM calls, tool calls, conversation flow |
| `cost-intelligence` | Tier 3a | Cost analysis | `$prometheus`, `$loki`, `$provider`, `$model` | Spending trends, model attribution, cache savings, per-session cost table |
| `tool-performance` | Tier 3b | Tool analytics | `$prometheus`, `$loki`, `$tempo`, `$tool` | Tool leaderboard, latency ranking, error rates, tool traces |
| `sre-operations` | Tier 3c | SRE operations | `$prometheus`, `$loki` | Queue health, webhooks, stuck sessions, tool loops |
| `genai-observability` | — | **OTel gen_ai standard** | `$prometheus`, `$loki`, `$tempo`, `$model`, `$provider` | Industry-standard AI monitoring: token analytics, LLM performance, traces, logs, cache efficiency. Works with any gen_ai data. |
| `node-exporter` | — | System/DevOps | `$datasource`, `$instance` | Server CPU, memory, disk, network |
| `http-service` | — | Web/DevOps | `$datasource`, `$job` | HTTP request rate, errors, latency (RED signals) |
| `metric-explorer` | — | **Any domain** | `$datasource`, `$metric` | Deep-dive into any single metric from a dropdown |
| `multi-kpi` | — | **Any domain** | `$datasource`, `$metric1`..`$metric4` | 4-metric KPI overview (business, fitness, finance, IoT) |
| `weekly-review` | — | **Any domain** | `$datasource`, `$metric1`, `$metric2` | Weekly overview of 2 external metrics with trends + all openclaw_ext_* table |

All AI templates have Loki log-to-trace correlation via Tempo + stable UIDs for cross-dashboard navigation.

**Example AI health**: `{ "template": "llm-command-center", "title": "My AI Dashboard" }`
**Example session debug**: `{ "template": "session-explorer", "title": "Session Debug" }`
**Example cost analysis**: `{ "template": "cost-intelligence", "title": "My AI Costs" }`
**Example tool analytics**: `{ "template": "tool-performance", "title": "Tool Health" }`
**Example SRE ops**: `{ "template": "sre-operations", "title": "SRE Health" }`
**Example GenAI observability**: `{ "template": "genai-observability", "title": "GenAI Observability" }`
**Example system**: `{ "template": "node-exporter", "title": "Server Health" }`
**Example generic**: `{ "template": "metric-explorer", "title": "Explore My Data" }`
**Example multi-KPI**: `{ "template": "multi-kpi", "title": "Business KPIs" }`
**Example weekly review**: `{ "template": "weekly-review", "title": "My Weekly Review" }`
**Example custom with validation**: `{ "dashboard": { "title": "Model Comparison", "panels": [{ "id": 1, "title": "Cost by Model", "type": "timeseries", "targets": [{ "refId": "A", "expr": "sum by (model) (rate(openclaw_lens_cost_by_token_type[1h]))", "datasource": { "uid": "prometheus" } }] }] } }`

**Custom dashboard validation** (returned only for `dashboard` param, not templates):
`validation: { panelsTotal: 3, panelsValid: 1, panelsNoData: 1, panelsError: 1, panelsSkipped: 0, details: [{ panelId: 1, title: "Cost by Model", status: "ok", queries: [{ refId: "A", expr: "...", valid: true, sampleValue: 0.42 }] }, { panelId: 2, title: "Latency", status: "nodata" }, { panelId: 3, title: "Bad Query", status: "error", error: "parse error at char 5" }] }`
Panel statuses: `ok` (query returned data), `nodata` (valid query, no results — metric may not exist yet), `error` (PromQL syntax error or datasource issue), `skipped` (no datasource UID found). Dashboard is always created regardless — validation is informational.

### `grafana_update_dashboard`
**When**: User wants to add a panel, remove a panel, change a query, update dashboard settings, or delete a dashboard.
**Params**: `uid` (required), `operation` (required: `add_panel`, `remove_panel`, `update_panel`, `update_metadata`, `delete`).
**add_panel params**: `panel` (object with `title`, `type`, `targets`). Auto-layouts below existing panels.
**remove_panel / update_panel params**: `panelId` (preferred) or `panelTitle` (case-insensitive substring fallback). `updates` (object) for update_panel.
**update_metadata params**: `title`, `description`, `tags`, `time` (e.g., `{ "from": "now-7d", "to": "now" }`), `refresh` (e.g., `"1m"`).
**delete params**: None besides `uid` — permanently removes the dashboard. Always confirm with user first.
**Example add**: `{ "uid": "abc123", "operation": "add_panel", "panel": { "title": "Error Rate", "type": "timeseries", "targets": [{ "refId": "A", "expr": "rate(errors_total[5m])", "datasource": { "uid": "prom1" } }] } }`
**Example add (no datasource)**: `{ "uid": "abc123", "operation": "add_panel", "panel": { "title": "Latency", "type": "timeseries", "targets": [{ "refId": "A", "expr": "histogram_quantile(0.99, rate(http_duration_bucket[5m]))" }] } }` — validation skipped if no datasource UID found, panel still saved.
**Example remove**: `{ "uid": "abc123", "operation": "remove_panel", "panelId": 3 }`
**Example update panel**: `{ "uid": "abc123", "operation": "update_panel", "panelId": 1, "updates": { "title": "New Title", "targets": [{ "refId": "A", "expr": "new_query" }] } }`
**Example update metadata**: `{ "uid": "abc123", "operation": "update_metadata", "title": "My Dashboard v2", "time": { "from": "now-7d", "to": "now" }, "refresh": "5m" }`
**Example delete**: `{ "uid": "abc123", "operation": "delete" }`
**Returns update**: `{ status: "updated", uid, url, version, operation, panelCount, affectedPanel?: { id, title }, changedFields?: [...], queryValidation?: { validated, results, datasourceUid?, skippedReason? } }`.
**Returns queryValidation**: For `add_panel` and `update_panel` (when targets change), PromQL queries are dry-run against Grafana. Each result: `{ refId, expr, valid: boolean, error?: string, sampleValue?: number }`. Panel is always saved — validation is informational. If `valid: false`, check the `error` field for PromQL syntax issues. If `skippedReason` is set, no datasource UID was found — include `datasource: { uid: "..." }` on targets to enable validation.
**Returns delete**: `{ status: "deleted", uid, title, message }`.
**Tip**: `targets` in update_panel replaces entirely — include all targets, not just changed ones. Include `datasource.uid` on targets for query validation feedback.

### `grafana_get_dashboard`
**When**: Need to inspect a dashboard's panels — find panel IDs for sharing, verify structure, scan multiple dashboards for an overview, or audit which panels are returning data.
**Params**: `uid` (required). Optional: `compact` (boolean, default `false`) — return panel titles and types only, no queries or metadata (~70% smaller). `audit` (boolean, default `false`) — dry-run each panel's query and add `health` status.
**Example (full)**: `{ "uid": "abc123" }`
**Example (compact overview)**: `{ "uid": "abc123", "compact": true }`
**Example (audit)**: `{ "uid": "abc123", "audit": true }`
**Returns (full)**: `{ uid, title, description?, url, tags, time?, refresh?, panelCount, panels: [{ id, title, type, queries: [{ refId, expr }] }], folderUid, created?, updated? }`.
**Returns (compact)**: `{ uid, title, url, tags, panelCount, panels: [{ id, title, type }] }`.
**Returns (audit)**: Same as full, plus each panel gets `health: { status: "ok"|"nodata"|"error"|"skipped", error?, sampleValue? }` and the response includes `auditSummary: { ok, nodata, error, skipped }`. Resolves template variable datasources (`$prometheus`, `$loki`) and replaces expression template vars with wildcards.
**Tip**: Use `audit: true` when the user asks "which panels are broken?" or "audit my dashboard" — it replaces N separate `grafana_query` calls with one tool call. Use `compact: true` for lightweight overview scans. Omit both when you need query details (before update or share).

### `grafana_search`
**When**: User mentions a dashboard by name, before creating one (check duplicates), or for reporting/audit workflows.
**Params**: `query` (required). Optional: `tags` (array — filter by tags), `starred` (boolean — only starred), `sort` (`"alpha-asc"`/`"alpha-desc"`), `limit` (number, default 100), `enrich` (boolean — add `updatedAt` + `panelCount` per result, default false).
**Example**: `{ "query": "cost" }`
**Example with tags**: `{ "query": "", "tags": ["production"] }`
**Example starred**: `{ "query": "", "starred": true, "limit": 10 }`
**Example enriched**: `{ "query": "", "enrich": true }`
**Returns**: `{ count, enriched, dashboards: [{ uid, title, url, tags, folderTitle?, folderUid?, updatedAt?, panelCount? }] }`. `folderTitle`/`folderUid` always included when dashboard is in a folder. `updatedAt` (ISO 8601) and `panelCount` only present when `enrich: true` — enables staleness detection and reporting without per-dashboard `get_dashboard` calls.
**Tip**: Use `enrich: true` for reporting workflows ("which dashboards are stale?", "give me a summary of all dashboards"). Skip enrichment for simple lookups. After finding a dashboard, use `grafana_get_dashboard` to inspect panels, `grafana_share_dashboard` to render a chart, or `grafana_update_dashboard` to modify it.

### `grafana_share_dashboard`
**When**: User says "show me" or "send me" a chart/dashboard.
**Params**: `dashboardUid`, `panelId` (required). Optional: `from` (default `"now-6h"`), `to` (default `"now"`), `width` (default `1000`), `height` (default `500`), `theme` (`"light"`/`"dark"`, default `"dark"`).
**Example**: `{ "dashboardUid": "abc123", "panelId": 2, "from": "now-6h", "to": "now" }`
**Returns**: Image rendered inline (tier 1), or snapshot URL (tier 2), or deep link (tier 3). Always delivers something. Includes `deliveryTier` (`"image"` | `"snapshot"` | `"link"`), `rendererAvailable` (boolean — false when Image Renderer plugin is missing), `renderFailureReason` (why image rendering failed), and `remediation` (how to fix it). Tier 3 also includes `snapshotFailureReason`.
**Tip**: Use `grafana_get_dashboard` first to find panel IDs. If `rendererAvailable` is false, tell the user to install the grafana-image-renderer plugin.

### `grafana_create_alert`
**When**: User wants notifications when a metric crosses a threshold.
**Params**: `title`, `datasourceUid`, `expr` (PromQL), `threshold` (all required). Optional: `evaluation` (`"instant"`/`"rate"`/`"increase"`, default `"instant"`), `evaluationWindow` (default `"5m"`, used with `rate`/`increase`), `condition` (`gt`/`lt`/`gte`/`lte`, default `gt`), `for` (duration, default `5m`), `folderUid`, `labels` (e.g., `{ "severity": "warning" }`), `annotations` (e.g., `{ "summary": "Cost too high" }`), `noDataState` (`NoData`/`Alerting`/`OK`, default `NoData`).
**IMPORTANT**: For counter metrics (`*_total`), always use `evaluation: "rate"` (per-second rate) or `evaluation: "increase"` (total change over window). Raw counter values always increase and will immediately breach any threshold. Use `"instant"` (default) only for gauges.
**Example gauge alert**: `{ "title": "High Cost Alert", "datasourceUid": "prom1", "expr": "openclaw_lens_daily_cost_usd", "threshold": 5, "condition": "gt" }`
**Example rate alert**: `{ "title": "High Error Rate", "datasourceUid": "prom1", "expr": "openclaw_lens_webhook_error_total", "threshold": 0.1, "evaluation": "rate" }`
**Example increase alert**: `{ "title": "Token Burst", "datasourceUid": "prom1", "expr": "openclaw_lens_tokens_total", "threshold": 10000, "evaluation": "increase", "evaluationWindow": "1h" }`
**Returns**: `{ uid, title, status: "created", datasourceUid, url, evaluation?: { mode, window, evaluatedExpr }, metricValidation: { valid, error?, sampleValue? }, message }`. The `datasourceUid` echoes back which datasource the rule targets (verify correctness). `metricValidation` dry-runs the expression before creation — `valid: true` + `sampleValue` confirms data exists; `valid: false` + `error` warns of typos/missing metrics. Alert is always created regardless (metric may not have data yet). When `evaluation` is `"rate"` or `"increase"`, validation runs the wrapped expression.
**Note**: Auto-creates a "Grafana Lens Alerts" folder if no `folderUid` is specified.

### `grafana_annotate`
**When**: User deploys, changes config, or wants to mark an event for correlation.
**Params**: `action` (`"create"` default, or `"list"`).
**Create params**: `text` (required), `tags`, `dashboardUid`, `panelId`, `time` (epoch ms or relative like `"now-2h"`, default now), `timeEnd` (epoch ms or relative).
**List params**: `from`, `to` (epoch ms or relative like `"now-7d"`, `"now-24h"`, `"now"`), `tags`, `limit` (default `20`).
**Time formats**: All time params accept epoch ms (e.g., `1700000000000`) OR Grafana-style relative strings (`"now"`, `"now-1h"`, `"now-7d"`, `"now-30m"`). Prefer relative strings — they're simpler and avoid arithmetic errors.
**Example create**: `{ "text": "Deployed v2.1.0", "tags": ["deploy", "production"] }`
**Example create past**: `{ "text": "Incident started", "time": "now-2h", "timeEnd": "now-30m", "tags": ["incident"] }`
**Example list recent**: `{ "action": "list", "from": "now-7d", "to": "now", "tags": ["deploy"] }`
**Example list**: `{ "action": "list", "tags": ["deploy"], "limit": 10 }`
**Returns create**: `{ status: "created", id, message, time, comparisonHint: { beforeWindow: { from, to }, afterWindow: { from, to }, suggestion } }`. The `comparisonHint` provides ready-to-use ISO 8601 time ranges (30-min windows) for before/after comparison via `grafana_query` — no manual time math needed. For region annotations (with `timeEnd`), `afterWindow` starts at `timeEnd`.
**Returns list**: `{ annotations: [{ id, text, tags, time, timeEnd?, dashboardUID?, panelId? }] }`.

### `grafana_check_alerts`
**When**: Prompt context shows "GRAFANA ALERTS", need to manage alert rules (list/delete), set up the alert webhook, silence alerts during investigation, or acknowledge an investigated alert.
**Params**: `action` (`"list"` default, `"acknowledge"`, `"list_rules"`, `"delete_rule"`, `"silence"`, `"unsilence"`, `"setup"`).
**List params**: None — returns all pending (unacknowledged) alerts. Instances capped at 5 per alert.
**Acknowledge params**: `alertId` (required) — marks an alert as investigated.
**List rules params**: `compact` (boolean, default false — returns only uid/title/state/condition). Full mode returns all configured alert rules from Grafana with UID, title, condition (PromQL), folder, labels, annotations, AND live evaluation state (normal/firing/pending/nodata/error), health, and lastEvaluation. One call gives the complete alert health picture.
**Delete rule params**: `ruleUid` (required) — permanently deletes an alert rule. Get UIDs from `list_rules`.
**Silence params**: `matchers` (required — array of `{ name, value, isRegex? }` from alert's `commonLabels`), `duration` (default `"2h"`), `comment` (optional).
**Unsilence params**: `silenceId` (required) — removes a silence so alerts resume notifying.
**Setup params**: `webhookUrl` (optional, auto-detected) — creates webhook contact point and notification policy route in Grafana.
**Example list**: `{}`
**Example acknowledge**: `{ "action": "acknowledge", "alertId": "alert-1" }`
**Example list rules**: `{ "action": "list_rules" }`
**Example list rules compact**: `{ "action": "list_rules", "compact": true }`
**Example delete rule**: `{ "action": "delete_rule", "ruleUid": "abc123-def456" }`
**Example silence**: `{ "action": "silence", "matchers": [{ "name": "alertname", "value": "HighCost" }], "duration": "2h", "comment": "Investigating cost spike" }`
**Example unsilence**: `{ "action": "unsilence", "silenceId": "silence-uuid-123" }`
**Example setup**: `{ "action": "setup" }`
**Returns list**: `{ status: "success", alertCount, alerts: [{ id, status, title, message, receivedAt, commonLabels, totalInstances, truncated?, suggestedInvestigation?: { datasourceUid, condition, tool, queryLanguage, hint }, instances: [{ status, labels, annotations, startsAt, values }] }] }`. `suggestedInvestigation` is auto-enriched by matching the alert to its rule — provides the PromQL/LogQL expression, datasource, and tool to use for immediate investigation (eliminates the need for separate `list_rules` + `explore_datasources` calls).
**Returns acknowledge**: `{ status: "acknowledged", alertId }`.
**Returns list_rules**: `{ status: "success", ruleCount, rules: [{ uid, title, folder, ruleGroup, state, health, lastEvaluation, for, labels, annotations, condition, updated }] }`. `state` is the live evaluation state: `"normal"` (not firing), `"firing"`, `"pending"` (within for duration), `"nodata"`, or `"error"`. Falls back to `"unknown"` if the eval state API is unavailable. `health` is `"ok"`, `"nodata"`, `"error"`, or `"unknown"`. `condition` is the extracted PromQL expression from the rule's data queries.
**Returns list_rules (compact)**: `{ status: "success", ruleCount, rules: [{ uid, title, state, condition }] }`. Minimal fields for multi-tool chains — use when you need a quick overview of all rules without details.
**Returns delete_rule**: `{ status: "deleted", ruleUid, message }`.
**Returns silence**: `{ status: "silenced", silenceId, duration, matchers, message }`.
**Returns unsilence**: `{ status: "unsilenced", silenceId, message }`.
**Returns setup**: `{ status: "created", contactPointUid, webhookUrl }` or `{ status: "already_exists", contactPointUid }`.
**Note**: Setup is idempotent — safe to call multiple times. Only alerts with `managed_by=openclaw` label route to the webhook (auto-added by `grafana_create_alert`). Use `list_rules` → `delete_rule` for full alert lifecycle management (create via `grafana_create_alert`, list/delete via `grafana_check_alerts`).

### `grafana_push_metrics`
**When**: User wants to track custom data (calendar events, git commits, fitness stats, financial data) in Grafana.
**Params**: `action` (`"push"` default, `"register"`, `"list"`, `"delete"`).
**Push params**: `metrics` (required array) — each: `{ name, value, labels?, type?, help?, timestamp? }`. Names auto-get `openclaw_ext_` prefix. `timestamp` is optional ISO 8601 for historical data (gauge only).
**Register params**: `name` (required), `type` (`"gauge"`/`"counter"`, default `"gauge"`), `help`, `labelNames` (array), `ttlDays`.
**List params**: None — returns all custom metric definitions.
**Delete params**: `name` (required) — removes a custom metric.
**Example push**: `{ "metrics": [{ "name": "steps_today", "value": 8000 }, { "name": "meetings", "value": 3, "labels": { "type": "standup" } }] }`
**Example backfill**: `{ "metrics": [{ "name": "steps", "value": 8000, "timestamp": "2025-01-15" }, { "name": "steps", "value": 10500, "timestamp": "2025-01-16" }] }`
**Example mixed**: `{ "metrics": [{ "name": "steps", "value": 9000, "timestamp": "2025-01-17" }, { "name": "heart_rate", "value": 72 }] }`
**Example register**: `{ "action": "register", "name": "weight_kg", "type": "gauge", "help": "Body weight", "labelNames": ["person"], "ttlDays": 90 }`
**Example list**: `{ "action": "list" }`
**Example delete**: `{ "action": "delete", "name": "old_metric" }`
**Returns push**: `{ status: "ok", accepted: 2, queryNames: { "openclaw_ext_steps": "openclaw_ext_steps", "openclaw_ext_events": "openclaw_ext_events_total" }, suggestedWorkflow: [{ tool, action, example }], message: "..." }`. `suggestedWorkflow` contains concrete next-step examples using the actual pushed metric names — verify (grafana_query), visualize (grafana_create_dashboard with metric-explorer template), and alert (grafana_create_alert, single-metric only). Partial success supported. Timestamped and real-time points in the same batch are both accepted.
**Returns register**: `{ status: "registered", metric: { name, type, help, labelNames, ttlMs }, queryName: "openclaw_ext_events_total", suggestedWorkflow: [{ tool, action, example }] }`. `suggestedWorkflow` shows how to push data and query the registered metric (with `rate()` wrapping for counters).
**Returns list**: `{ count, metrics: [{ name, type, queryName, help, labelNames, createdAt, updatedAt }] }`.
**Returns delete**: `{ status: "deleted", name }`.
**Note**: Push auto-registers unknown metrics. Response includes `queryNames` with exact PromQL names and `suggestedWorkflow` with concrete next steps. Follow `suggestedWorkflow` to complete the push→visualize pipeline. Timestamped pushes are gauge-only — counters with timestamps are rejected. See [external-data.md](references/external-data.md) for naming conventions and backfill patterns.

### `grafana_explain_metric`
**When**: User asks "what does this metric mean?", "why did it spike?", "is this normal?", or "show me the trend".
**Params**: `datasourceUid` (required), `expr` (PromQL or plain metric name, required), `period` (`24h`/`7d`/`30d`, default `24h`), `compareWith` (`"previous"` — compare current period with the same-length window immediately before it).
**Example**: `{ "datasourceUid": "prom1", "expr": "openclaw_lens_daily_cost_usd" }`
**Example counter**: `{ "datasourceUid": "prom1", "expr": "openclaw_lens_tokens_total" }`
**Example 7d**: `{ "datasourceUid": "prom1", "expr": "openclaw_lens_daily_cost_usd", "period": "7d" }`
**Example comparison**: `{ "datasourceUid": "prom1", "expr": "openclaw_lens_daily_cost_usd", "period": "7d", "compareWith": "previous" }`
**Example PromQL**: `{ "datasourceUid": "prom1", "expr": "rate(http_requests_total[5m])", "period": "24h" }`
**Returns**: `{ metricType?, trendQuery?, current: { value, timestamp }, healthContext?: { status, thresholds, description, direction }, trend: { changePercent, direction, first, last }, stats: { min, max, avg, samples }, comparison?: { previousPeriod: { from, to, avg, min, max, samples }, change: { absolute, percentage, direction } }, metadata: { type, help, unit }, suggestedQueries?: [{ query, description }], suggestedBreakdowns?: string[] }`. Sections omitted when data unavailable. `changePercent` is `null` when first value is zero. `healthContext` is included for well-known `openclaw_lens_*` gauge metrics — same as `grafana_query`.
**Counter-aware**: Auto-detects counter metrics (via metadata `type` or `_total` suffix) and wraps the trend query in `rate(expr[5m])`. The `current` value stays raw (cumulative total), but `trend` and `stats` show rate of change. `metricType` field tells you the detected type (counter/gauge/histogram). `trendQuery` shows the actual PromQL used for trend (only present when different from `expr`).
**Drill-down**: For multi-dimensional metrics (metrics with labels like `model`, `token_type`, `provider`), the response includes `suggestedQueries` — ready-to-use PromQL queries for `grafana_query` that break down the metric by each label. Counter metrics get `rate()` wrapping automatically. Use these to investigate cost attribution, identify top contributors, or decompose aggregates.
**Breakdowns**: `suggestedBreakdowns` provides label names for decomposition — always available for known OpenClaw metrics (cost, session, queue, webhook families) even when the metric has no data yet. For unknown metrics, falls back to labels discovered from the instant query. Use these labels with `grafana_query` to build `sum by (label) (...)` queries for root-cause analysis.
**Period comparison**: Use `compareWith: "previous"` for period-over-period analysis (e.g., this week vs. last week). Returns a `comparison` object with the previous period's stats and the change (absolute, percentage, direction). Works with counters too (compares rates). Eliminates the need for manual multi-query workflows.
**Tip**: For simple trend context, call with just `period`. For "did things improve?" questions, add `compareWith: "previous"`. Metadata only available for plain metric names (not complex PromQL). No need to manually wrap counters in `rate()` — the tool does it automatically.

### `grafana_security_check`
**When**: User asks "am I being attacked?", "security status", "security audit", "security check", or wants a comprehensive threat assessment.
**Params**: `lookback` (time window, default `"1h"`. Use `"24h"` for daily review, `"7d"` for weekly).
**Example**: `{}`
**Example weekly review**: `{ "lookback": "7d" }`
**Returns**: `{ overallThreatLevel: "green"|"yellow"|"red", summary, checks: [{ name, status, value, detail }], securityEventLogs, limitations: [...], suggestedActions: [...], dashboardTemplate: "security-overview" }`.
**Checks** (6 parallel, via Promise.allSettled — partial failures return partial results):
1. `webhook_error_ratio` — webhook error rate vs received rate. Warning 20%, critical 50%.
2. `cost_anomaly` — daily cost. Warning $10, critical $50.
3. `tool_loops` — active tool loops. Warning 1, critical 3.
4. `injection_signals` — prompt injection patterns detected. Warning 1, critical 5.
5. `session_enumeration` — unique sessions in 1h. Warning 50, critical 200.
6. `stuck_sessions` — stuck sessions. Warning 1, critical 3.
**Limitations**: Auth failures are NOT observable — openclaw's auth middleware emits no diagnostic events. The tool monitors observable signals (webhook errors, cost spikes, prompt injection patterns, session anomalies) but cannot detect silent auth-layer attacks (bad tokens, brute-force, rate-limiter lockouts). Always includes limitations in response.
**Auto-discovery**: No datasource UID needed — auto-discovers first Prometheus datasource. Loki is optional (skips log check if absent).
**Follow-up**: Use `dashboardTemplate` to create a persistent security dashboard. Use `suggestedActions` for investigation steps.

### `grafana_investigate`
**When**: First step for "investigate this", "what's wrong?", "triage", "root cause analysis", "debug this issue", or any multi-signal investigation.
**Params**: `focus` (required — alert UID, metric name, or symptom text), `timeWindow` (optional, default `"1h"`, options: `"1h"`, `"6h"`, `"24h"`), `service` (optional, default `"openclaw"`).
**Example**: `{ "focus": "high error rate" }`
**Example with alert**: `{ "focus": "alert-abc", "timeWindow": "6h" }`
**Example with metric**: `{ "focus": "openclaw_lens_daily_cost_usd", "timeWindow": "24h" }`
**Returns**: `{ timeWindow, focus, metricSignals: { focus: { current, trend, anomalyScore, anomalySeverity }, red: { rate, errorRate, p95Latency } }, logSignals: { totalVolume, errorCount, bySeverity, topPatterns, sampleErrors }, traceSignals: { errorTraces, slowTraces }, contextSignals: { recentAnnotations, alertsActive }, suggestedHypotheses: [{ hypothesis, evidence, confidence, testWith: { tool, params } }], limitations }`.
**Auto-discovery**: No datasource UID needed — auto-discovers Prometheus, Loki, and Tempo datasources. Loki and Tempo are optional (graceful degradation with limitations noted).
**Follow-up**: Use `suggestedHypotheses[].testWith` for deep-dives with specific tools. Use `grafana_annotate` to mark findings. Use `grafana_check_alerts` to acknowledge investigated alerts.

### Security Monitoring

**Honest limitations**: OpenClaw's auth middleware does not emit diagnostic events for failed authentication attempts (bad tokens, brute-force, rate-limiter lockouts). Gateway-level auth failures are invisible to Grafana Lens. The security-check tool monitors observable signals (webhook errors, cost spikes, prompt injection patterns, session anomalies) but cannot detect silent auth-layer attacks.

**Security PromQL queries**:
- Webhook error spike: `rate(openclaw_lens_webhook_error_total[5m]) > 0.5`
- Webhook error ratio: `rate(openclaw_lens_webhook_error_total[5m]) / (rate(openclaw_lens_webhook_received_total[5m]) + 0.001) > 0.3`
- Active tool loops: `sum(openclaw_lens_tool_loops_active) > 0`
- Prompt injection signals: `sum(increase(openclaw_lens_prompt_injection_signals_total[1h])) > 0`
- Cost spike: `openclaw_lens_daily_cost_usd > 10`
- Unique session anomaly: `openclaw_lens_unique_sessions_1h > 50`
- Gateway restarts: `sum(increase(openclaw_lens_gateway_restarts_total[24h])) > 3`
- Tool error classification: `sum by (error_class) (rate(openclaw_lens_tool_error_classes_total[5m]))`

**Security LogQL queries**:
- Security events: `{service_name="openclaw"} | json | event_name=~"prompt_injection.detected|gateway.start|gateway.stop"`
- Tool loops: `{service_name="openclaw"} | json | component="diagnostic" | event_name="tool.loop"`
- Session resets: `{service_name="openclaw"} | json | event_name="session.reset"`

## Composed Workflow Examples

**"How's my agent doing?"**
1. `grafana_query` with `sum(increase(openclaw_lens_cost_by_model_total[1d])) or vector(0)` and `openclaw_lens_tokens_total` for quick numbers
2. Or `grafana_create_dashboard` with `llm-command-center` template + `grafana_share_dashboard` for a visual

**"Set up monitoring for my agent" / "What dashboards should I create?"**
1. `grafana_search` query: "LLM Command Center" — check for existing agent dashboards
2. `grafana_create_dashboard` template: "llm-command-center" — single-pane health: cost, sessions, errors, latency, cache, live feeds
3. Follow `suggestedNext` from the response — it chains you through the remaining templates (session-explorer → cost-intelligence → tool-performance → sre-operations → genai-observability)
4. Share dashboard URLs with user
5. Optional: `grafana_share_dashboard` to show a key panel inline

The 6 AI observability templates provide comprehensive OpenClaw monitoring with Loki log-to-trace correlation:
- **llm-command-center**: Single-pane health view (daily cost, sessions, error rate, P95 latency, cache hit rate, token flow, live error/session feeds, per-model latency, message type breakdown)
- **session-explorer**: Per-session deep-dive (trace hierarchy, LLM calls, tool calls, conversation flow, cost/token breakdown, TraceQL session spans, latency stats). THE killer feature.
- **cost-intelligence**: Financial analysis (daily/weekly/monthly trends, model/provider/token attribution pie charts, cache savings, per-session cost table, projected monthly cost, token efficiency)
- **tool-performance**: Tool reliability (leaderboard bar gauges, p95 latency ranking, error rates, tool traces, tool calls by model, error traces, duration heatmap)
- **sre-operations**: Infrastructure health (queue depth, webhooks, stuck sessions, tool loops, gen_ai error rate, context window pressure)
- **genai-observability**: Industry-standard AI monitoring using OTel gen_ai semantic conventions — token analytics, LLM latency heatmap, trace explorer, log intelligence, cache efficiency. Works with any gen_ai data, not just OpenClaw.

**"Find error logs in the last hour"**
1. `grafana_explore_datasources` — find Loki datasource UID
2. `grafana_query_logs` with `{job="api"} |= "error"`

**"Why did my service crash?"**
1. `grafana_explore_datasources` — find Loki UID
2. `grafana_query_logs` with `{job="myservice"} |~ "fatal|panic|crash"`
3. `grafana_query` — check related metrics around the same time window

**"Investigate alert: correlate metrics with logs"**
1. `grafana_check_alerts` — get alert details with `suggestedInvestigation` (includes ready-to-use query, datasource, and tool)
2. `grafana_query` / `grafana_query_logs` — use `suggestedInvestigation.tool` with `suggestedInvestigation.condition` and `suggestedInvestigation.datasourceUid`
3. `grafana_query_logs` — search logs around alert time for root cause (if PromQL alert)
4. `grafana_annotate` — mark findings on dashboard
5. `grafana_check_alerts` with `action: "acknowledge"`

**"What data do I have in Grafana?"**
1. `grafana_explore_datasources` — find Prometheus datasources
2. `grafana_list_metrics` with `datasourceUid` and `metadata: true` — list available metrics grouped by category
3. Summarize what's available using `categorySummary` for quick overview (e.g., "5 cost metrics, 8 session metrics, 3 queue metrics")

**"My agent feels slow — what performance metrics can I look at?"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_list_metrics` with `purpose: "performance"`, `metadata: true` — returns only session + tool metrics (latency, duration, tool calls)
3. `grafana_explain_metric` on key metrics (e.g., `openclaw_lens_session_latency_avg_ms`, `openclaw_lens_tool_duration_ms`) — get current values and trends

**"Alert me if costs exceed $10/day"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_create_alert` with `expr: "openclaw_lens_daily_cost_usd"`, `threshold: 10`, `condition: "gt"`

**"Query error rate and alert if it's above 1%"** (query→alert chaining)
1. `grafana_query` with `expr: "rate(http_errors_total[5m])"` — response includes `datasourceUid`
2. `grafana_create_alert` with `datasourceUid` from the query response, same `expr`, `threshold: 0.01`, `condition: "gt"` — no extra datasource discovery needed

**"Show me my cost trends"**
1. `grafana_search` with `query: "cost"` — check for existing dashboard
2. If not found: `grafana_create_dashboard` with `cost-intelligence` template
3. `grafana_get_dashboard` — find the right panel ID
4. `grafana_share_dashboard` — deliver the chart inline

**"Re-run the latency panel from my Command Center for the last 7 days"**
1. `grafana_search` with `query: "Command Center"` — get the dashboard UID
2. `grafana_get_dashboard` with `uid` — find the latency panel ID
3. `grafana_query` with `dashboardUid`, `panelId`, `queryType: "range"`, `start: "now-7d"` — auto-resolves PromQL and datasource from the panel

**"Mark that I deployed version 2"**
1. `grafana_annotate` with `text: "Deployed v2"`, `tags: ["deploy"]`

**"I deployed v2.3.0 — compare error rates before and after"**
1. `grafana_annotate` with `text: "Deployed v2.3.0"`, `tags: ["deploy"]` — response includes `comparisonHint` with before/after time windows
2. `grafana_query` with `comparisonHint.beforeWindow` time range — get pre-deploy error rate
3. `grafana_query` with `comparisonHint.afterWindow` time range — get post-deploy error rate
4. Compare and report the difference to the user

**"What happened around 3pm?"**
1. `grafana_annotate` with `action: "list"`, `from`/`to` relative times (e.g., `"now-6h"`) or epoch ms, or specific `tags`

**"Monitor my server's health"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_search` with `query: "node"` — check for existing
3. `grafana_create_dashboard` with `template: "node-exporter"` — user picks instance from dropdown

**"Show me my e-commerce metrics"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_list_metrics` with `prefix: "orders_"` — discover available metrics
3. `grafana_create_dashboard` with `template: "multi-kpi"` — user picks 4 business metrics from dropdowns

**"I want to explore my fitness data"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_create_dashboard` with `template: "metric-explorer"` — user browses all `fitness_*` metrics from dropdown

**"Set up HTTP API monitoring with alerts"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_create_dashboard` with `template: "http-service"`
3. `grafana_create_alert` with `expr: "http_requests_total{code=~\"5..\"}"`, `threshold: 0.1`, `evaluation: "rate"` — the tool wraps in `rate()` automatically

**"Build a custom Redis dashboard"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_list_metrics` with `metadata: true`, `prefix: "redis_"` — learn metric types
3. Compose custom `dashboard` JSON using panel snippets from the composition guide
4. `grafana_create_dashboard` with the custom JSON — check `validation.panelsError` for broken queries, fix any errors with `grafana_update_dashboard`

**"Set up full alert monitoring loop"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_check_alerts` with `action: "setup"` — create webhook contact point
3. `grafana_create_alert` with PromQL condition — rule auto-routes to webhook via `managed_by=openclaw` label
4. When alert fires, agent sees it in prompt context and can investigate

**"List all my alert rules and delete one"**
1. `grafana_check_alerts` with `action: "list_rules"` — get all configured rules with UIDs, titles, conditions, AND live eval state (normal/firing/nodata/error)
2. Identify the target rule by title, condition, or state
3. `grafana_check_alerts` with `action: "delete_rule"`, `ruleUid` — permanently remove the rule

**"Investigate a firing alert"** (triggered by "GRAFANA ALERTS" in prompt context)
1. `grafana_investigate` with `focus` = alert UID or symptom, `timeWindow: "1h"` — parallel multi-signal triage (metrics, logs, traces, context)
2. `grafana_check_alerts` with `action: "silence"`, `matchers` from alert's `commonLabels` — prevent repeat notifications
3. Follow `suggestedHypotheses[].testWith` from investigate response — deep-dive with specific tools
4. `grafana_query_logs` — search logs around alert time for root cause (statistics first: `count_over_time`, then samples)
5. `grafana_query_traces` — inspect error/slow traces for span-level detail
6. `grafana_annotate` — mark findings on dashboard
7. `grafana_check_alerts` with `action: "acknowledge"` — mark as investigated
8. `grafana_check_alerts` with `action: "unsilence"`, `silenceId` — restore notifications
9. Report findings using Evidence Presentation Format (see sre-investigation.md §10)

**"Is this metric anomalous?" / "Statistical assessment"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_explain_metric` with `period: "24h"` — response includes `anomaly` (z-score, severity) and `seasonality` (vs 1d/7d ago)
3. If `anomaly.severity` >= "significant": `grafana_query` with z-score PromQL for time series view
4. `grafana_query` with `predict_linear(METRIC[6h], 3600)` — where is it heading?
5. Interpret: report σ-level, compare with yesterday/last week, forecast trajectory

**"Alert fatigue analysis — which alerts are noisy?"**
1. `grafana_check_alerts` with `action: "analyze"` — fatigue report with always-firing, flapping, and healthy classifications
2. For always-firing rules: suggest raising thresholds or adding `for:` duration
3. For flapping rules: suggest adding hysteresis or widening threshold bands
4. `grafana_check_alerts` with `action: "silence"` for rules being tuned

**"Generate a postmortem for the last incident"**
1. `grafana_investigate` with `focus` = incident symptom, `timeWindow: "6h"` — gather all evidence
2. `grafana_check_alerts` (list) — find resolved alerts with timeline
3. `grafana_annotate` (list, tags: ["investigation"]) — build event timeline
4. `grafana_explain_metric` for key metrics — trend/stats for incident period
5. `grafana_query_logs` — error patterns (statistics first)
6. `grafana_query_traces` — error traces for root cause evidence
7. Synthesize into blameless postmortem (see sre-investigation.md §9)

**"Add an error rate panel to my API dashboard"**
1. `grafana_search` with `query: "API"` — find the dashboard
2. `grafana_get_dashboard` — get current panels and structure
3. `grafana_update_dashboard` with `operation: "add_panel"`, `panel: { title: "Error Rate", type: "timeseries", targets: [...] }`

**"Remove the old latency panel and add a new one"**
1. `grafana_get_dashboard` — find panel IDs
2. `grafana_update_dashboard` with `operation: "remove_panel"`, `panelId: <old_id>`
3. `grafana_update_dashboard` with `operation: "add_panel"`, `panel: { ... }`

**"Change my dashboard time range to 7 days"**
1. `grafana_update_dashboard` with `operation: "update_metadata"`, `time: { "from": "now-7d", "to": "now" }`

**"Send my team the weekly dashboard"**
1. `grafana_search` with the dashboard name
2. `grafana_get_dashboard` — get panel IDs
3. `grafana_share_dashboard` for each key panel with `from: "now-7d"`

**"Show me my weekly work review"**
1. `grafana_push_metrics` — push work data (commits, hours, meetings)
2. `grafana_create_dashboard` with `template: "weekly-review"` — weekly trends + all custom metrics table
3. `grafana_share_dashboard` — deliver key panels inline

**"Track my daily fitness data"**
1. `grafana_push_metrics` — push fitness metrics (steps, weight, calories). Response has `queryNames` with exact PromQL names.
2. `grafana_create_dashboard` with `template: "weekly-review"` — weekly trends
3. `grafana_create_alert` using `queryNames` from step 1 for exact PromQL — e.g., `threshold: 5000`, `condition: "lt"`

**"Backfill my step count for the past week"**
1. `grafana_push_metrics` — push 7 data points with `timestamp` on each:
   `{ "metrics": [{ "name": "steps", "value": 8000, "timestamp": "2025-01-13" }, { "name": "steps", "value": 10500, "timestamp": "2025-01-14" }, ...] }`
2. `grafana_create_dashboard` with `template: "metric-explorer"` — visualize the trend
3. `grafana_share_dashboard` with `from: "now-7d"` — deliver the chart

**"What custom data have I pushed?"**
1. `grafana_push_metrics` with `action: "list"` — see all custom metric definitions with `queryName` per metric
2. `grafana_query` using `queryName` values — see current values
3. Or `grafana_list_metrics` with `search: "ext"` — server-side discovery from Prometheus

**"System health check — give me a full status report"**
1. `grafana_explore_datasources` — discover available datasources
2. `grafana_check_alerts` — check pending alerts + `action: "list_rules"` for configured rules
3. `grafana_search` with `query: ""` and `enrich: true` — find all dashboards with `updatedAt` and `panelCount` for staleness triage
4. `grafana_get_dashboard` with `audit: true` for stale or suspicious dashboards — check which panels have data vs broken
5. Summarize: datasources available, alerts firing, dashboard health (`auditSummary`), stale dashboards, broken panels

**"Audit my dashboard — which panels are broken?"**
1. `grafana_get_dashboard` with `audit: true` — dry-runs every panel's query
2. Review `auditSummary` for counts (`ok`, `nodata`, `error`, `skipped`)
3. For `error` panels, explain the issue; for `nodata` panels, suggest fixes (missing metrics, wrong datasource)

**"What is this metric doing?"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_explain_metric` with metric name — get current value, trend, stats, metadata
3. Interpret results for the user — the tool provides data, you provide narrative

**"Compare costs this week vs. last week" / "Did the new model help?"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_explain_metric` with `period: "7d"`, `compareWith: "previous"` — one call gives this week's stats + last week's stats + percentage change
3. Interpret the `comparison.change` object — "costs are down 25% week-over-week, the model switch is working"

**"Compare metric over different time scales"**
1. `grafana_explain_metric` with `period: "24h"` — recent trend
2. `grafana_explain_metric` with `period: "7d"` — weekly context
3. Compare and explain — "up 15% today but down 5% over the week"

**"Where are my costs going?" / "Why did my costs spike?"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_explain_metric` with `openclaw_lens_cost_by_token_type` — get trend + `suggestedBreakdowns` (always: `["model", "token_type", "provider"]`) + `suggestedQueries`
3. Use `suggestedBreakdowns` to know which dimensions matter, or pick from `suggestedQueries` for ready-to-use PromQL
4. `grafana_query` with `sum by (model) (rate(openclaw_lens_cost_by_token_type[5m]))` — get concrete breakdown numbers
5. Explain to user: "Opus accounts for 80% of costs, mainly from output tokens"

**"Set up AI observability" / "Show me LLM traces and logs"**
1. `grafana_explore_datasources` — verify Prometheus, Loki, and Tempo datasources are available
2. `grafana_search` with `query: "LLM Command Center"` — check for existing
3. `grafana_create_dashboard` with `template: "llm-command-center"` — health overview with live error/session feeds
4. `grafana_create_dashboard` with `template: "session-explorer"` — per-session trace drill-down
5. `grafana_share_dashboard` — deliver an LLM latency or token usage panel inline

**"Why is my LLM slow?" (multi-signal investigation)**
1. `grafana_explain_metric` with `gen_ai_client_operation_duration_seconds` — check latency trend
2. `grafana_query_logs` with `{service_name="openclaw"} | json | component="lifecycle" |= "llm.output"`, `extractFields: true` — find slow LLM calls with `fields.duration_s` and `fields.model` surfaced directly
3. `grafana_query_traces` with `queryType: "get"` and `fields.trace_id` from step 2 — inspect spans; response includes `correlationHint.logQuery` for correlated logs
4. `grafana_query` with model-specific duration breakdown — identify which model is slow

**"Debug a slow or failing session"**
1. `grafana_query_traces` with `{ resource.service.name = "openclaw" && status = error }` or `minDuration: "10s"` — find problematic traces
2. `grafana_query_traces` with `queryType: "get"` and the trace ID — inspect span hierarchy (response includes `correlationHint`)
3. `grafana_query_logs` with the `correlationHint.logQuery` from step 2, `extractFields: true` — correlated logs
4. `grafana_query` with relevant PromQL — check metrics around the same time window
5. `grafana_annotate` with `text: "Debug: [findings]"`, `tags: ["debug"]` — mark investigation on dashboards

**"Which dashboards are stale?" / "Give me a dashboard summary report"**
1. `grafana_search` with `query: ""` and `enrich: true` — gets `updatedAt`, `panelCount`, `folderTitle` for every dashboard
2. Sort by `updatedAt` to identify stale dashboards (e.g., not updated in 30+ days)
3. Summarize: total dashboards, by folder, stale vs active, panel counts

**"Am I being attacked?" / "Security status" / "Security audit"**
1. `grafana_security_check` — runs 6 parallel security checks, returns threat level (green/yellow/red)
2. If non-green: follow `suggestedActions` from the response
3. If `dashboardTemplate` is present: `grafana_create_dashboard` with `template: "security-overview"` — persistent monitoring
4. `grafana_create_alert` using suggested thresholds for ongoing monitoring

**"Set up security monitoring"**
1. `grafana_check_alerts` with `action: "setup"` — create webhook contact point (if not already done)
2. `grafana_create_dashboard` with `template: "security-overview"` — 15-panel security dashboard
3. `grafana_create_alert` with `expr: "rate(openclaw_lens_webhook_error_total[5m]) / (rate(openclaw_lens_webhook_received_total[5m]) + 0.001)"`, `threshold: 0.3`, `condition: "gt"` — webhook error burst
4. `grafana_create_alert` with `expr: "openclaw_lens_daily_cost_usd"`, `threshold: 10`, `condition: "gt"` — cost spike
5. `grafana_create_alert` with `expr: "sum(increase(openclaw_lens_prompt_injection_signals_total[1h]))"`, `threshold: 3`, `condition: "gt"` — prompt injection signals

**"Investigate security alert"**
1. `grafana_security_check` — get current threat assessment
2. `grafana_query_logs` with `{service_name="openclaw"} | json | component="lifecycle" | event_name=~"prompt_injection.detected|gateway.start|gateway.stop"` — security event logs
3. `grafana_query` with specific PromQL for the affected check (e.g., `rate(openclaw_lens_tool_error_classes_total[5m])`)
4. `grafana_annotate` with `text: "Security investigation"`, `tags: ["security"]` — mark investigation on dashboards
5. `grafana_check_alerts` with `action: "acknowledge"` — mark alerts as investigated

**"Clean up old test dashboards"**
1. `grafana_search` with `query: "test"` or relevant tags and `enrich: true` — includes `updatedAt` for staleness check
2. Confirm with user which dashboards to delete
3. `grafana_update_dashboard` with `operation: "delete"` for each confirmed dashboard

**"Find my production dashboards"**
1. `grafana_search` with `tags: ["production"]` or `starred: true`

**"Why is the queue backing up?"**
1. `grafana_explore_datasources` — get Prometheus UID
2. `grafana_query` with `openclaw_lens_queue_depth` — current queue depth
3. `grafana_query` with `sum(rate(openclaw_message_queued_total[5m])) by (openclaw_source)` — message inflow by source
4. `grafana_query` with `histogram_quantile(0.95, rate(openclaw_queue_wait_ms_milliseconds_bucket[5m]))` — p95 queue wait time
5. `grafana_query` with `sum(rate(openclaw_queue_lane_enqueue_total[5m]))` vs `sum(rate(openclaw_queue_lane_dequeue_total[5m]))` — enqueue vs dequeue rate
6. `grafana_query` with `openclaw_lens_sessions_stuck` — check for stuck sessions blocking the queue
7. Diagnose: if inflow > drain → scale issue; if stuck sessions → investigate with `grafana_explain_metric`

## Dashboard Composition

For composing custom dashboards from discovered metrics — template selection, metric-to-panel mapping, JSON snippets, worked examples across domains — see [references/dashboard-composition.md](references/dashboard-composition.md).

## Agent Metrics

For metric names, types, labels, and common PromQL — covering both `openclaw_*` (from diagnostics-otel) and `openclaw_lens_*` (from grafana-lens) — see [references/agent-metrics.md](references/agent-metrics.md).

## External Data

For external data naming conventions and integration patterns, see [references/external-data.md](references/external-data.md).

## SRE Investigation Patterns

For 5-phase investigation methodology, anomaly detection PromQL, RED/USE method queries,
LogQL investigation discipline, TraceQL debugging, SLI/SLO burn rates, cross-signal correlation,
and composed investigation workflows — see [references/sre-investigation.md](references/sre-investigation.md).
