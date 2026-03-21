# SRE Investigation Patterns

Structured investigation methodology for the Grafana LGTM stack, mapped to Grafana Lens tools.
Use this as a playbook when the user asks to investigate, debug, triage, or write a postmortem.

## 1. Five-Phase Investigation Methodology

### Phase 1: Scope
Understand the symptom, timeline, and blast radius before gathering data.

| Action | Tool | Example |
|--------|------|---------|
| Check active alerts | `grafana_check_alerts` (list) | See pending alerts with `suggestedInvestigation` |
| List recent events | `grafana_annotate` (list, from="now-6h") | Deployments, config changes, investigations |
| Check alert rules | `grafana_check_alerts` (list_rules, compact=true) | Which rules are firing/pending? |
| Quick security sweep | `grafana_security_check` | Parallel threat assessment |

**Output**: Symptom description, affected services, timeline bounds, recent changes.

### Phase 2: Gather Evidence (Statistics First)
**Critical discipline: always aggregate before sampling.** Run `count_over_time` before reading individual log entries. Use `grafana_explain_metric` before raw PromQL. Search traces before fetching individual ones.

| Signal | Statistics First | Then Sample |
|--------|-----------------|-------------|
| Metrics | `grafana_explain_metric` (trend + stats + anomaly) | `grafana_query` (specific breakdowns) |
| Logs | `count_over_time`, `sum by (level)`, `topk` patterns | Individual log entries (max 50) |
| Traces | `grafana_query_traces` (search with filters) | `grafana_query_traces` (get specific trace) |

### Phase 3: Form Hypotheses
Structure each hypothesis with supporting evidence and a specific tool call to test it.

```
H1: [Hypothesis statement]
    Evidence: [What suggests this]
    Test: [tool_name] with [specific params]

H2: [Alternative hypothesis]
    Evidence: [What suggests this]
    Test: [tool_name] with [specific params]
```

### Phase 4: Test Hypotheses
Execute the mapped tool calls. Track which hypotheses are confirmed vs ruled out with specific evidence.

### Phase 5: Conclude
- Root cause + evidence chain + confidence level
- `grafana_annotate` findings on relevant dashboards
- `grafana_check_alerts` acknowledge investigated alerts
- Present using the Evidence Presentation Format (Section 10)

---

## 2. RED Method (Rate / Errors / Duration)

Service-centric health assessment. Works for both OpenClaw agent metrics and generic HTTP services.

### OpenClaw Agent RED

| Signal | PromQL | Tool |
|--------|--------|------|
| **Rate** | `sum(rate(openclaw_lens_messages_processed_total[5m]))` | `grafana_query` |
| **Errors** | `sum(rate(openclaw_lens_messages_processed_total{outcome="error"}[5m])) / sum(rate(openclaw_lens_messages_processed_total[5m]))` | `grafana_query` |
| **Duration** | `histogram_quantile(0.95, sum(rate(gen_ai_client_operation_duration_seconds_bucket[5m])) by (le))` | `grafana_query` |

### Generic HTTP Service RED

| Signal | PromQL |
|--------|--------|
| **Rate** | `sum(rate(http_requests_total[5m]))` |
| **Errors** | `sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))` |
| **Duration** | `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))` |

### RED by Dimension

Break down by `model`, `channel`, `tool`, or custom labels to isolate the source:

```promql
# Error rate by model
sum by (model) (rate(openclaw_lens_messages_processed_total{outcome="error"}[5m]))
  / sum by (model) (rate(openclaw_lens_messages_processed_total[5m]))

# Duration by tool
histogram_quantile(0.95, sum by (le, tool) (rate(openclaw_lens_tool_duration_ms_bucket[5m])))
```

---

## 3. USE Method (Utilization / Saturation / Errors)

Resource-centric health assessment for infrastructure and agent resources.

### OpenClaw Agent USE

| Signal | PromQL | What It Means |
|--------|--------|---------------|
| **Utilization** — context window | `openclaw_lens_context_tokens{type="used"} / openclaw_lens_context_tokens{type="limit"} * 100` | % of context window consumed |
| **Utilization** — cache efficiency | `openclaw_lens_cache_read_ratio` | Cache hit ratio (higher is better) |
| **Saturation** — queue depth | `openclaw_lens_queue_depth` | Messages waiting to be processed |
| **Saturation** — queue lane depth | `openclaw_lens_queue_lane_depth` | Per-lane queue depth |
| **Saturation** — queue wait time | `histogram_quantile(0.95, sum(rate(openclaw_lens_queue_wait_ms_bucket[5m])) by (le))` | p95 wait time in queue |
| **Errors** — stuck sessions | `openclaw_lens_sessions_stuck` | Sessions unable to make progress |
| **Errors** — tool loops | `sum(openclaw_lens_tool_loops_active)` | Tools in infinite loops |
| **Errors** — tool error classes | `sum by (error_class) (rate(openclaw_lens_tool_error_classes_total[5m]))` | Error rate by category |

### Generic Node USE (node-exporter)

| Signal | PromQL |
|--------|--------|
| **Utilization** — CPU | `100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)` |
| **Utilization** — Memory | `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100` |
| **Saturation** — Disk I/O | `rate(node_disk_io_time_seconds_total[5m])` |
| **Saturation** — Network | `rate(node_network_receive_bytes_total[5m]) + rate(node_network_transmit_bytes_total[5m])` |
| **Errors** — Disk | `rate(node_disk_io_time_weighted_seconds_total[5m])` |

---

## 4. Anomaly Detection via PromQL

### Z-Score (σ-Based Anomaly Scoring)

Compare a metric's current value against its historical baseline:

```promql
# Z-score: how many standard deviations from the 7-day mean?
(avg_over_time(METRIC[1h]) - avg_over_time(METRIC[7d]))
  / (stddev_over_time(METRIC[7d]) + 1e-10)
```

**Severity mapping**:

| Z-Score (σ) | Severity | Interpretation |
|-------------|----------|----------------|
| < 1.5 | Normal | Within expected variance |
| 1.5 – 2.0 | Mild | Slightly unusual, may be noise |
| 2.0 – 3.0 | Significant | Likely a real change — investigate |
| > 3.0 | Critical | Extremely unlikely to be noise |

The `grafana_explain_metric` tool computes this automatically for 24h period queries and returns it in the `anomaly` field.

### Seasonality Comparison

Compare with the same time yesterday and last week:

```promql
# Value at same time yesterday
METRIC offset 1d

# Value at same time last week
METRIC offset 7d

# Percent change vs yesterday
(METRIC - METRIC offset 1d) / (METRIC offset 1d + 1e-10) * 100

# Percent change vs last week
(METRIC - METRIC offset 7d) / (METRIC offset 7d + 1e-10) * 100
```

The `grafana_explain_metric` tool computes this automatically for 24h period queries and returns it in the `seasonality` field.

### Predictive and Rate-of-Change

```promql
# Where is this metric heading? (linear prediction 1h ahead)
predict_linear(METRIC[6h], 3600)

# How fast is it changing right now?
deriv(METRIC[15m])

# Is it flapping? (number of value changes in the last hour)
changes(METRIC[1h])
```

---

## 5. SLI/SLO Burn Rate

Multi-window burn rate alerting for availability and latency SLIs.

### Availability SLI (Error Rate)

```promql
# Error budget consumption rate (14.4x = 100% budget in 1h)
(
  sum(rate(openclaw_lens_messages_processed_total{outcome="error"}[1h]))
  / sum(rate(openclaw_lens_messages_processed_total[1h]))
) / (1 - 0.999)  # SLO = 99.9%
```

### Multi-Window Burn Rate

| Window | Fast Burn (14.4x) | Slow Burn (1x) |
|--------|-------------------|----------------|
| 1h / 5m | Exhausts budget in ~1h | — |
| 6h / 30m | Exhausts budget in ~3d | — |
| 1d / 2h | — | Exhausts budget in ~30d |

```promql
# Fast burn: 2% of monthly error budget consumed in 1 hour
(
  sum(rate(openclaw_lens_messages_processed_total{outcome="error"}[1h]))
  / sum(rate(openclaw_lens_messages_processed_total[1h]))
) > (14.4 * (1 - 0.999))
and
(
  sum(rate(openclaw_lens_messages_processed_total{outcome="error"}[5m]))
  / sum(rate(openclaw_lens_messages_processed_total[5m]))
) > (14.4 * (1 - 0.999))
```

### Latency SLI

```promql
# What percentage of LLM calls exceed 10s? (latency SLI)
1 - (
  sum(rate(gen_ai_client_operation_duration_seconds_bucket{le="10"}[5m]))
  / sum(rate(gen_ai_client_operation_duration_seconds_count[5m]))
)
```

---

## 6. LogQL Investigation Patterns

**Statistics-first discipline**: Always run aggregation queries before reading individual log entries.

### Step 1: Volume and Error Rate

```logql
# Total log volume over time
sum(count_over_time({service_name="openclaw"}[5m]))

# Error rate over time
sum(rate({service_name="openclaw"} | logfmt | level="ERROR" [5m]))
```

### Step 2: Severity Breakdown

```logql
# Log count by severity level
sum by (level) (count_over_time({service_name="openclaw"} | json [1h]))
```

### Step 3: Top Error Patterns

```logql
# Top error sources by service
topk(10, sum by (service_name) (rate({level="error"} | logfmt [5m])))

# Top error event types
topk(10, sum by (event_name) (count_over_time({service_name="openclaw"} | json | level="ERROR" [1h])))
```

### Step 4: Sample Investigation

Only AFTER identifying patterns from steps 1-3. Max 50 entries.

```logql
# Sample error entries from the incident window
{service_name="openclaw"} | json | level="ERROR" | line_format "{{.event_name}}: {{.body}}"
```

Use `grafana_query_logs` with `start`/`end` params to narrow to the incident window.

### Step 5: Temporal Correlation

Narrow to the exact incident window using `start` and `end` parameters from Phase 1 (Scope).

### Step 6: Log-to-Trace Correlation

```logql
# Find error logs that have trace correlation
{service_name="openclaw"} | json | trace_id != "" | level="ERROR"
```

Extract `trace_id` values → use `grafana_query_traces` with `queryType: "get"` to inspect the full trace.

### Step 7: Component Filtering

OpenClaw logs have a `component` attribute for filtering:

| Component | What It Contains |
|-----------|-----------------|
| `lifecycle` | Session/LLM/tool/subagent lifecycle events |
| `diagnostic` | Diagnostic event processing (metric collector) |
| `app` | Application logs (tslog output forwarded via registerLogTransport) |

```logql
# Only lifecycle events (most useful for SRE investigation)
{service_name="openclaw"} | json | component="lifecycle"

# Only application logs (plugin code output)
{service_name="openclaw"} | json | component="app"
```

---

## 7. TraceQL Investigation Patterns

### Finding Problematic Traces

```traceql
# Slow spans (>10s)
{ resource.service.name = "openclaw" && duration > 10s }

# Error spans
{ resource.service.name = "openclaw" && status = error }

# Slow LLM calls specifically
{ resource.service.name = "openclaw" && name =~ "chat.*" && duration > 10s }

# Failed tool executions
{ resource.service.name = "openclaw" && span.gen_ai.operation.name = "execute_tool" && status = error }
```

### Structural Operators (Error Chains)

```traceql
# Find traces where a frontend span has a downstream error
{ resource.service.name = "frontend" } >> { status = error }

# Find traces where an LLM call led to a tool error
{ name =~ "chat.*" } >> { span.gen_ai.operation.name = "execute_tool" && status = error }
```

### Duration Aggregates

```traceql
# Traces with average span duration > 20ms
{ } | avg(span:duration) > 20ms

# Traces with at least one span > 1s
{ } | max(span:duration) > 1s
```

### Trace-to-Log Correlation

After fetching a trace with `grafana_query_traces` (queryType: "get"), the response includes `correlationHint.logQuery` — a ready-to-use LogQL query for correlated logs. Pass it to `grafana_query_logs`.

---

## 8. Investigation Workflow Recipes

### a) Latency Investigation

```
Symptom: "LLM calls are slow" / "agent is sluggish"

1. grafana_explain_metric
   expr: "gen_ai_client_operation_duration_seconds"
   period: "24h"
   → Get trend, anomaly score, seasonality

2. grafana_query
   expr: "histogram_quantile(0.95, sum by (le, gen_ai_request_model) (rate(gen_ai_client_operation_duration_seconds_bucket[5m])))"
   → Break down latency by model

3. grafana_query_logs
   expr: '{service_name="openclaw"} | json | component="lifecycle" |= "llm.output" | openclaw_duration_s > 10'
   → Find specific slow LLM calls (stats first — count_over_time, then samples)

4. grafana_query_traces
   query: '{ resource.service.name = "openclaw" && name =~ "chat.*" && duration > 10s }'
   → Inspect slow trace span hierarchy

5. grafana_annotate
   text: "Investigation: slow LLM calls — [root cause]", tags: ["investigation"]
```

### b) Error Spike Investigation

```
Symptom: Alert firing / "errors are up"

1. grafana_check_alerts (list)
   → Get alert details + suggestedInvestigation

2. grafana_query
   expr: "sum by (outcome) (rate(openclaw_lens_messages_processed_total[5m]))"
   → Confirm error rate and see if it's rising

3. grafana_query_logs  [STATISTICS FIRST]
   expr: 'sum by (level) (count_over_time({service_name="openclaw"} | json [1h]))'
   → Severity breakdown — how many errors vs warnings?

   expr: 'topk(10, sum by (event_name) (count_over_time({service_name="openclaw"} | json | level="ERROR" [1h])))'
   → Top error patterns

   expr: '{service_name="openclaw"} | json | level="ERROR"'  (limit: 10)
   → Sample error entries AFTER understanding patterns

4. grafana_query_traces
   query: '{ resource.service.name = "openclaw" && status = error }'
   → Error trace spans for detailed analysis

5. grafana_annotate
   text: "Error spike investigation: [findings]", tags: ["investigation"]
```

### c) Change Detection (Before/After Deployment)

```
Symptom: "Did the deployment break anything?"

1. grafana_annotate (list, tags: ["deploy"], from: "now-24h")
   → Find deployment timestamps

2. grafana_query
   expr: "rate(openclaw_lens_messages_processed_total{outcome='error'}[5m])"
   + use annotation timestamps for before/after windows

3. grafana_explain_metric
   expr: "openclaw_lens_daily_cost_usd"
   compareWith: "previous"
   → Period-over-period comparison

4. grafana_query_logs
   expr: '{service_name="openclaw"} | json | component="lifecycle" | event_name=~"gateway.*"'
   → Infrastructure events around the deployment
```

### d) Anomaly Assessment

```
Symptom: "Is this metric normal?" / "Detect anomalies"

1. grafana_explain_metric
   expr: "METRIC_NAME", period: "24h"
   → Automatic anomaly scoring (z-score) + seasonality (vs 1d/7d ago)

2. grafana_query (if anomaly.severity >= "significant")
   expr: "(avg_over_time(METRIC[1h]) - avg_over_time(METRIC[7d])) / (stddev_over_time(METRIC[7d]) + 1e-10)"
   → Detailed z-score over time

3. grafana_query
   expr: "METRIC offset 1d" and "METRIC offset 7d"
   → Compare with yesterday and last week

4. grafana_query
   expr: "predict_linear(METRIC[6h], 3600)"
   → Where is this heading in the next hour?
```

### e) Cost Investigation

```
Symptom: "Why is my bill high?" / "Cost spike"

1. grafana_explain_metric
   expr: "openclaw_lens_daily_cost_usd", period: "24h"
   → Trend + anomaly score + seasonality

2. grafana_query
   expr: "sum by (model) (increase(openclaw_lens_cost_by_model_total[1d]))"
   → Cost attribution by model

3. grafana_query
   expr: "sum by (token_type) (increase(openclaw_lens_cost_by_token_type[1d]))"
   → Cost attribution by token type (input vs output vs cache)

4. grafana_query
   expr: "openclaw_lens_cache_token_ratio"
   → Cache efficiency — low ratio means more expensive uncached calls

5. grafana_query_logs
   expr: '{service_name="openclaw"} | json | event_name="usage.session_summary" | openclaw_cost_total > 1'
   → Expensive sessions (>$1)
```

### f) Postmortem Generation

```
Symptom: "What happened?" / "Write a postmortem" / "Incident summary"

1. grafana_check_alerts (list)
   → Find resolved alerts with timeline

2. grafana_annotate (list, from="incident_start", to="incident_end")
   → Build event timeline

3. grafana_explain_metric
   → Key metrics with trend/stats for the incident period

4. grafana_query_logs  [STATISTICS FIRST]
   → Error patterns, severity breakdown

5. grafana_query_traces
   → Error traces for root cause evidence

6. Synthesize into Postmortem Template (Section 9)
```

---

## 9. Postmortem Template

When asked to write a postmortem, incident summary, or "what happened?", use this blameless format:

```markdown
# Incident: [Brief Title]

**Duration**: [start_time] – [end_time] ([total_duration])
**Severity**: [P1/P2/P3/P4]
**Services affected**: [list]

## Timeline

| Time | Event | Source |
|------|-------|--------|
| HH:MM | [event description] | [tool used: grafana_check_alerts / grafana_annotate / grafana_query_logs] |

## Root Cause

[1-2 sentences describing root cause with specific evidence]

## Evidence Collected

### Metrics
- [metric_name]: [value/trend] (from grafana_explain_metric / grafana_query)

### Logs
- [pattern]: [count] occurrences (from grafana_query_logs count_over_time)
- [sample]: [relevant log line] (from grafana_query_logs)

### Traces
- [trace_id]: [summary of span hierarchy] (from grafana_query_traces)

## Hypotheses Tested

| # | Hypothesis | Status | Evidence |
|---|-----------|--------|----------|
| H1 | [hypothesis] | Confirmed / Ruled out | [evidence] |
| H2 | [hypothesis] | Confirmed / Ruled out | [evidence] |

## What Couldn't Be Determined

- [observability gap] — [reason] (e.g., "Auth failure rate unknown — openclaw auth middleware emits no telemetry")

## Action Items

### Immediate (done)
- [ ] [action taken during incident]

### Short-term (1-2 weeks)
- [ ] [follow-up action]

### Long-term (systemic)
- [ ] [systemic improvement]
```

---

## 10. Evidence Presentation Format

When presenting investigation findings, structure the output as:

### Sources Consulted
List each tool call with query and result summary:
- `grafana_explain_metric(openclaw_lens_daily_cost_usd)` → $7.50, up 45% vs yesterday, anomaly score 2.3σ (significant)
- `grafana_query(sum by (model) (...))` → claude-opus: $5.80, claude-sonnet: $1.70
- `grafana_query_logs(count_over_time ...)` → 47 errors in last hour, 80% from tool timeouts

### Hypotheses Tested
- **H1: Model cost increase** → Ruled out (same model distribution as last week)
- **H2: Cache degradation** → Confirmed (cache ratio dropped from 0.7 to 0.3 after deployment)

### What Was Ruled Out
- Model mix unchanged (grafana_query by model)
- No tool loop activity (grafana_security_check: green)

### Confidence Level
High / Medium / Low — with justification.

### Limitations
- Auth failure data unavailable (openclaw auth middleware emits no telemetry)
- Loki datasource not configured — log correlation unavailable
- Only 24h of metric history available — longer-term seasonality assessment not possible
