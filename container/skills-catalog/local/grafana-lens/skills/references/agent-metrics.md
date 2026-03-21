# Agent Metrics Reference

Metrics come from two sources — both push via OTLP to the same collector/Mimir instance and are queryable in Grafana.

## Core Agent Telemetry (from diagnostics-otel)

These are published by OpenClaw's built-in `diagnostics-otel` extension. Grafana Lens dashboards query them but does not collect them.

| Prometheus Name | Type | Labels | Source Event |
|----------------|------|--------|-------------|
| `openclaw_tokens_total` | counter | `openclaw_token`, `openclaw_model`, `openclaw_provider`, `openclaw_channel` | `model.usage` |
| `openclaw_cost_usd_total` | counter | `openclaw_model`, `openclaw_provider`, `openclaw_channel` | `model.usage` |
| `openclaw_run_duration_ms_milliseconds` | histogram | `openclaw_model`, `openclaw_provider`, `openclaw_channel` | `model.usage` |
| `openclaw_context_tokens` | histogram | `openclaw_context` (limit/used), `openclaw_model`, `openclaw_provider`, `openclaw_channel` | `model.usage` |
| `openclaw_message_processed_total` | counter | `openclaw_outcome`, `openclaw_channel` | `message.processed` |
| `openclaw_message_duration_ms_milliseconds` | histogram | `openclaw_outcome`, `openclaw_channel` | `message.processed` |
| `openclaw_message_queued_total` | counter | `openclaw_channel`, `openclaw_source` | `message.queued` |
| `openclaw_webhook_received_total` | counter | `openclaw_channel`, `openclaw_webhook` | `webhook.received` |
| `openclaw_webhook_error_total` | counter | `openclaw_channel`, `openclaw_webhook` | `webhook.error` |
| `openclaw_webhook_duration_ms_milliseconds` | histogram | `openclaw_channel`, `openclaw_webhook` | `webhook.processed` |
| `openclaw_queue_depth` | histogram | `openclaw_lane`, `openclaw_channel` | `message.queued`, `queue.lane.*`, `heartbeat` |
| `openclaw_queue_wait_ms_milliseconds` | histogram | `openclaw_lane` | `queue.lane.dequeue` |
| `openclaw_queue_lane_enqueue_total` | counter | `openclaw_lane` | `queue.lane.enqueue` |
| `openclaw_queue_lane_dequeue_total` | counter | `openclaw_lane` | `queue.lane.dequeue` |
| `openclaw_session_state_total` | counter | `openclaw_state`, `openclaw_reason` | `session.state` |
| `openclaw_session_stuck_total` | counter | `openclaw_state` | `session.stuck` |
| `openclaw_session_stuck_age_ms_milliseconds` | histogram | `openclaw_state` | `session.stuck` |
| `openclaw_run_attempt_total` | counter | `openclaw_attempt` | `run.attempt` |

**Label names use underscores** (OTel dots → Prometheus underscores): `openclaw.model` → `openclaw_model`.

**OTel unit suffix**: Histograms declared with `unit: "ms"` get `_milliseconds` appended in Prometheus (OTLP-to-Prometheus translation). So the OTel instrument `openclaw_run_duration_ms` becomes `openclaw_run_duration_ms_milliseconds_bucket` in PromQL. All PromQL in this doc uses the physical Prometheus names.

**Label value reference**:
- `openclaw_token`: `input`, `output`, `cache_read`, `cache_write`, `prompt`, `total`
- `openclaw_context`: `limit`, `used`
- `openclaw_outcome`: `completed`, `skipped`, `error`

## Operational Gauges (from grafana-lens)

These are unique to Grafana Lens — current-state snapshots and user data that diagnostics-otel doesn't provide.

| Metric | Type | Labels | Source |
|--------|------|--------|--------|
| `openclaw_lens_sessions_active` | gauge (UpDownCounter) | `state` | `session.state` events |
| `openclaw_lens_queue_depth` | gauge | — | `session.state` + `diagnostic.heartbeat` |
| `openclaw_lens_context_tokens` | gauge | `type` (limit/used) | `model.usage` events |
| `openclaw_lens_daily_cost_usd` | gauge | — | `model.usage` + midnight reset |
| `openclaw_lens_sessions_active_snapshot` | gauge | — | `diagnostic.heartbeat` (ground-truth cross-check) |
| `openclaw_lens_sessions_stuck` | gauge | — | `session.stuck` events |
| `openclaw_lens_stuck_session_max_age_ms` | gauge | — | `session.stuck` events |
| `openclaw_lens_cache_read_ratio` | gauge | — | `model.usage` (cacheRead / total input) |
| `openclaw_lens_tool_loops_active` | gauge | `level` (warning/critical) | `tool.loop` events |
| `openclaw_lens_queue_lane_depth` | gauge | `lane` | `queue.lane.enqueue/dequeue` |
| `openclaw_lens_alert_webhooks_received` | gauge | `status` (firing/resolved) | Alert webhook subsystem |
| `openclaw_lens_alert_webhooks_pending` | gauge | — | Alert webhook subsystem |
| `openclaw_lens_custom_metrics_pushed_total` | counter | — | `grafana_push_metrics` usage |

Custom metrics (`openclaw_ext_*`) — see [external-data.md](external-data.md).

## Security Metrics (from grafana-lens)

These observe security-relevant signals from lifecycle hooks and diagnostic events. Detection-only — never blocks or terminates sessions.

| Metric | Type | Labels | Source Hook/Event |
|--------|------|--------|-------------------|
| `openclaw_lens_gateway_restarts` | counter | — | `gateway_start` hook |
| `openclaw_lens_session_resets` | counter | `reason` | `before_reset` hook |
| `openclaw_lens_tool_error_classes` | counter | `tool`, `error_class` (network/filesystem/timeout/other) | `after_tool_call` hook (when `event.error` set) |
| `openclaw_lens_prompt_injection_signals` | counter | `detector` (input_scan/tool_loop) | `llm_input` hook (pattern scan) + `tool.loop` diagnostic event |
| `openclaw_lens_unique_sessions_1h` | gauge | — | `session_start` hook (1h sliding window) |

**Limitation — auth failures are invisible**: OpenClaw's auth middleware (`gateway/auth.ts`) returns `{ ok: false }` but emits **zero** diagnostic events and **zero** log records. Auth failures (bad tokens, brute-force, rate-limiter lockouts) are completely silent from Grafana Lens's telemetry pipeline. Security monitoring relies on observable signals (webhook errors, cost spikes, prompt injection patterns, session anomalies) but cannot detect silent auth-layer attacks. Monitor gateway-level logs outside OpenClaw for auth visibility.

**Error classification labels** (`error_class` on `tool_error_classes`):
- `network`: ECONNREFUSED, ETIMEDOUT, ENOTFOUND, fetch failures
- `filesystem`: ENOENT, EACCES, path/directory/traversal errors
- `timeout`: Timeout/timed out errors
- `other`: Everything else

**Prompt injection detection** (`detector` on `prompt_injection_signals`):
- `input_scan`: Pattern match on LLM input (only when `captureContent` config enabled — respects privacy)
- `tool_loop`: From `tool.loop` diagnostic event (tool stuck in infinite loops — prompt injection indicator)

## Self-Sufficient Counters/Histograms (from grafana-lens)

These replicate key counters/histograms from diagnostics-otel so dashboards work without the diagnostics-otel extension. Labels use clean names (no `openclaw_` prefix).

| Metric | Type | Labels | Source Event |
|--------|------|--------|-------------|
| `openclaw_lens_tokens_total` | counter | `token` (input/output/cacheRead/cacheWrite), `provider`, `model` | `model.usage` |
| `openclaw_lens_messages_processed_total` | counter | `outcome` (completed/skipped/error), `channel` | `message.processed` |
| `openclaw_lens_webhook_received_total` | counter | `channel`, `update_type` | `webhook.received` |
| `openclaw_lens_webhook_error_total` | counter | `channel`, `update_type` | `webhook.error` |
| `openclaw_lens_webhook_duration_ms_bucket` | histogram | `channel`, `update_type` | `webhook.processed` |
| `openclaw_lens_queue_lane_enqueue_total` | counter | `lane` | `queue.lane.enqueue` |
| `openclaw_lens_queue_lane_dequeue_total` | counter | `lane` | `queue.lane.dequeue` |
| `openclaw_lens_queue_wait_ms_bucket` | histogram | `lane` | `queue.lane.dequeue` |

**Note**: These use clean label names (`model`, `provider`, `channel`, `outcome`) — not the `openclaw_`-prefixed labels from diagnostics-otel. Dashboard templates query these `openclaw_lens_*` metrics exclusively.

## gen_ai Standard Metrics (Grafana Cloud AI Observability compatible)

These follow the [OTel gen_ai semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) and are compatible with Grafana Cloud's AI Observability dashboards out of the box.

| Metric | Type | Unit | Labels | Source |
|--------|------|------|--------|--------|
| `gen_ai_client_token_usage` | histogram | `{token}` | `gen_ai_operation_name`, `gen_ai_provider_name`, `gen_ai_token_type` (input/output/cache_read_input/cache_creation_input), `gen_ai_request_model` | `llm_output` hook |
| `gen_ai_client_operation_duration` | histogram | `s` | `gen_ai_operation_name`, `gen_ai_provider_name`, `gen_ai_request_model` | `llm_input` + `llm_output` paired |

**Note**: OTel dotted names become underscores in Prometheus. `gen_ai.client.token.usage` → `gen_ai_client_token_usage`. Duration uses explicit bucket boundaries: `[0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]` seconds.

## Lifecycle Metrics (from grafana-lens hook telemetry)

Session, compaction, subagent, and delivery metrics from OpenClaw plugin lifecycle hooks.

| Metric | Type | Labels | Source Hook |
|--------|------|--------|-------------|
| `openclaw_lens_sessions_started_total` | counter | `type` (new/resumed) | `session_start` | **Note**: webchat sessions always resume (`type=resumed`); `type=new` only appears for brand-new sessions (no prior conversation). |
| `openclaw_lens_session_duration_ms` | histogram | — | `session_end` |
| `openclaw_lens_compactions_total` | counter | — | `after_compaction` |
| `openclaw_lens_compaction_messages_removed` | histogram | — | `after_compaction` |
| `openclaw_lens_subagents_spawned_total` | counter | `mode` (run/session) | `subagent_spawned` |
| `openclaw_lens_sessions_completed_total` | counter | `outcome` (success/error) | `session_end` / `agent_end` |
| `openclaw_lens_subagent_outcomes_total` | counter | `outcome`, `mode` | `subagent_ended` |
| `openclaw_lens_subagent_duration_ms` | histogram | `mode` | `subagent_ended` (paired with `subagent_spawned`) |
| `openclaw_lens_message_delivery_total` | counter | `channel`, `success` | `message_sent` | **Note**: only fires for webhook-based channels (Telegram, Slack, etc.). Webchat uses a different delivery path that bypasses the `message_sent` hook. |
| `openclaw_lens_tool_calls_total` | counter | `tool`, `status` | `after_tool_call` |
| `openclaw_lens_tool_duration_ms` | histogram | `tool` | `after_tool_call` |
| `openclaw_lens_cost_by_model` | counter | `model`, `provider` | `model.usage` diagnostic event |
| `openclaw_lens_session_message_types` | counter | `type` (user/assistant/tool_call/tool_result/error) | lifecycle hooks |
| `openclaw_lens_cost_by_token_type` | counter | `token_type` (input/output/cache_read/cache_write), `model`, `provider` | `model.usage` diagnostic event |
| `openclaw_lens_cache_savings_usd` | gauge | — | `model.usage` (accumulated cache read savings) |
| `openclaw_lens_session_latency_avg_ms` | gauge | — | `llm_input`/`llm_output` paired (rolling average) |
| `openclaw_lens_cache_token_ratio` | gauge | — | `model.usage` (cache tokens / all tokens) |

## gen_ai Span Attributes (OTel Semantic Convention Compliance)

Lifecycle telemetry emits hierarchical spans following the [OTel gen_ai semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). These are visible in Tempo and Grafana Cloud AI Observability.

### invoke_agent spans (root — one per session)

| Attribute | Status | Value |
|-----------|--------|-------|
| `gen_ai.operation.name` | Required | `"invoke_agent"` |
| `gen_ai.provider.name` | Required | `"openclaw"` |
| `gen_ai.agent.name` | Recommended | `"openclaw"` |
| `gen_ai.agent.id` | Recommended | `"grafana-lens"` |
| `gen_ai.agent.version` | Recommended | Plugin version (e.g., `"0.1.0"`) |
| `gen_ai.output.type` | Recommended | `"text"` |
| `gen_ai.conversation.id` | Recommended | Session ID |
| `openclaw.session.resumed_from` | Custom | Previous session ID (omitted if not resumed) |
| `openclaw.session.message_count` | Custom | Total messages in session (set at session end) |
| `openclaw.session.duration_ms` | Custom | Session duration in ms (set at session end) |
| `openclaw.session.cost_usd` | Custom | Accumulated cost for this session (set at session end) |
| `openclaw.session.total_input_tokens` | Custom | Accumulated input tokens (set at session end) |
| `openclaw.session.total_output_tokens` | Custom | Accumulated output tokens (set at session end) |
| `openclaw.session.total_cache_read_tokens` | Custom | Accumulated cache read tokens (set at session end) |
| `openclaw.session.total_cache_write_tokens` | Custom | Accumulated cache write tokens (set at session end) |
| `openclaw.session.messages.user` | Custom | User messages in session |
| `openclaw.session.messages.assistant` | Custom | Assistant messages in session |
| `openclaw.session.messages.tool_calls` | Custom | Tool calls in session |
| `openclaw.session.messages.tool_results` | Custom | Tool results in session |
| `openclaw.session.messages.errors` | Custom | Errors in session |
| `openclaw.session.latency.avg_ms` | Custom | Average LLM call latency in session |
| `openclaw.session.latency.p95_ms` | Custom | P95 LLM call latency in session |
| `openclaw.session.latency.min_ms` | Custom | Min LLM call latency in session |
| `openclaw.session.latency.max_ms` | Custom | Max LLM call latency in session |
| `openclaw.session.tools.unique_count` | Custom | Number of unique tools used |
| `openclaw.session.tools.total_calls` | Custom | Total tool calls in session |
| `openclaw.session.tools.top` | Custom | Comma-separated top tools by usage |
| `openclaw.session.cost.input` | Custom | Estimated input token cost (USD) |
| `openclaw.session.cost.output` | Custom | Estimated output token cost (USD) |
| `openclaw.session.cost.cache_read` | Custom | Estimated cache read cost (USD) |
| `openclaw.session.cost.cache_write` | Custom | Estimated cache write cost (USD) |
| `openclaw.session.cache_hit_ratio` | Custom | Cache hit ratio (0-1) |
| `openclaw.session.cache_savings_usd` | Custom | Estimated cache savings (USD) |
| `gen_ai.agent.id` | Recommended | Agent ID from session context |
| `gen_ai.conversation.id` | Recommended | Session ID |
| `gen_ai.conversation.parent_id` | Custom | Parent session ID (set on child subagent sessions via deferred linking) |
| `gen_ai.provider.name` | Recommended | Primary provider used in session |
| `gen_ai.request.model` | Recommended | Primary model used in session |
| `openclaw.parent_session_id` | Custom | Parent session ID (subagent only, set via deferred linking) |
| `openclaw.parent_session_key` | Custom | Parent session key (subagent only) |
| `openclaw.parent_trace_id` | Custom | Trace ID of parent agent (for cross-trace correlation) |
| `openclaw.is_subagent` | Custom | `true` if this session is a spawned subagent |
| `openclaw.subagent.agent_id` | Custom | Agent ID of the subagent (set on child root span) |
| `openclaw.subagent.label` | Custom | Subagent label (set on child root span) |
| `openclaw.subagent.mode` | Custom | Subagent mode: `"run"` or `"session"` (set on child root span) |

**Span links on child root span**: Link to parent spawn span with `openclaw.link.type=parent_agent` (cross-trace).

### openclaw.subagent.spawn spans (long-lived — brackets subagent lifetime)

| Attribute | Status | Value |
|-----------|--------|-------|
| `openclaw.subagent.agent_id` | Custom | Agent ID of the spawned subagent |
| `openclaw.subagent.mode` | Custom | `"run"` or `"session"` |
| `openclaw.subagent.label` | Custom | Human-readable label |
| `openclaw.subagent.child_session_key` | Custom | Session key of the child agent |
| `openclaw.subagent.thread_requested` | Custom | Whether a thread was requested |
| `openclaw.subagent.child_trace_id` | Custom | Trace ID of child agent (set by deferred linking) |
| `openclaw.subagent.child_session_id` | Custom | Session ID of child agent (set by deferred linking) |
| `openclaw.subagent.target_kind` | Custom | Kind of subagent (set at end) |
| `openclaw.subagent.reason` | Custom | End reason (set at end) |
| `openclaw.subagent.outcome` | Custom | End outcome (set at end) |

**Span links on spawn span**: Bidirectional link to child root span with `openclaw.link.type=child_agent` (cross-trace).

**Span lifecycle**: Created on `subagent_spawned`, ended on `subagent_ended`. If child linking happens (via `onLlmInput`), span is enriched with `child_trace_id` and `child_session_id`.

### chat spans (one per LLM call)

| Attribute | Status | Value |
|-----------|--------|-------|
| `gen_ai.operation.name` | Required | `"chat"` |
| `gen_ai.provider.name` | Required | Provider name (e.g., `"anthropic"`) |
| `gen_ai.request.model` | Recommended | Requested model name |
| `gen_ai.response.model` | Recommended | Actual model served (may differ from request) |
| `gen_ai.response.finish_reasons` | Recommended | Array: `["stop"]`, `["max_tokens"]`, `["tool_calls"]`, `["error"]` |
| `gen_ai.usage.input_tokens` | Recommended | Input token count |
| `gen_ai.usage.output_tokens` | Recommended | Output token count |
| `gen_ai.usage.cache_creation.input_tokens` | Custom | Cache write tokens |
| `gen_ai.usage.cache_read.input_tokens` | Custom | Cache read tokens |

### execute_tool spans (one per tool call)

| Attribute | Status | Value |
|-----------|--------|-------|
| `gen_ai.operation.name` | Required | `"execute_tool"` |
| `gen_ai.provider.name` | Required | `"openclaw"` |
| `gen_ai.tool.name` | Recommended | Tool name (e.g., `"grafana_query"`) |
| `gen_ai.tool.call.id` | Recommended | Tool call ID |
| `gen_ai.tool.type` | Recommended | `"function"` |
| `error.type` | Required on error | `"tool_error"` |

### Error span attributes

| Span Type | `error.type` Value |
|-----------|--------------------|
| `openclaw.agent.end` (with error) | `"agent_error"` |
| `openclaw.message.sent` (with error) | `"delivery_error"` |
| `openclaw.subagent.end` (with error) | `"subagent_error"` |
| `execute_tool` (with error) | `"tool_error"` |

## Common PromQL Expressions

| Question | PromQL |
|----------|--------|
| Daily cost so far | `sum(increase(openclaw_lens_cost_by_model_total[1d])) or vector(0)` |
| Daily cost (gauge) | `openclaw_lens_daily_cost_usd` |
| Total cost all time | `sum(openclaw_lens_cost_by_model_total)` |
| Token rate (5m) | `sum(rate(openclaw_lens_tokens_total[5m]))` |
| Cost by model | `sum by (model) (openclaw_lens_cost_by_model_total)` |
| P95 LLM latency | `histogram_quantile(0.95, sum(rate(gen_ai_client_operation_duration_seconds_bucket[5m])) by (le))` |
| Error rate | `rate(openclaw_lens_messages_processed_total{outcome="error"}[5m])` |
| Active sessions | `sum(openclaw_lens_sessions_active)` |
| Queue depth | `openclaw_lens_queue_depth` |
| Context utilization % | `openclaw_lens_context_tokens{type="used"} / openclaw_lens_context_tokens{type="limit"} * 100` |
| Webhook error rate | `rate(openclaw_lens_webhook_error_total[5m])` |
| Cache hit rate | `openclaw_lens_cache_read_ratio` |
| Stuck sessions | `openclaw_lens_sessions_stuck` |
| Longest stuck session | `openclaw_lens_stuck_session_max_age_ms` |
| Tool loops active | `sum(openclaw_lens_tool_loops_active)` |
| Queue lane depth | `openclaw_lens_queue_lane_depth` |
| Pending alerts | `openclaw_lens_alert_webhooks_pending` |
| Custom metrics pushed | `rate(openclaw_lens_custom_metrics_pushed_total[5m])` |
| Context window size (p95) | `histogram_quantile(0.95, sum(rate(openclaw_context_tokens_bucket[5m])) by (le))` |
| P95 webhook latency | `histogram_quantile(0.95, sum(rate(openclaw_lens_webhook_duration_ms_bucket[5m])) by (le))` |
| Message inflow rate | `sum(rate(openclaw_lens_messages_processed_total[5m])) by (channel)` |
| Queue wait p95 | `histogram_quantile(0.95, sum(rate(openclaw_lens_queue_wait_ms_bucket[5m])) by (le))` |
| Queue throughput | `sum(rate(openclaw_lens_queue_lane_dequeue_total[5m])) by (lane)` |
| Queue enqueue vs dequeue | `sum(rate(openclaw_lens_queue_lane_enqueue_total[5m]))` vs `sum(rate(openclaw_lens_queue_lane_dequeue_total[5m]))` |
| Stuck session rate | `rate(openclaw_session_stuck_total[5m])` |
| P95 stuck age | `histogram_quantile(0.95, sum(rate(openclaw_session_stuck_age_ms_milliseconds_bucket[5m])) by (le))` |
| Retry rate | `sum(rate(openclaw_run_attempt_total{openclaw_attempt!="1"}[5m]))` |
| Queue depth distribution | `histogram_quantile(0.95, sum(rate(openclaw_queue_depth_bucket[5m])) by (le))` |
| gen_ai token usage (input) | `sum(rate(gen_ai_client_token_usage_bucket{gen_ai_token_type="input"}[5m]))` |
| gen_ai token usage (output) | `sum(rate(gen_ai_client_token_usage_bucket{gen_ai_token_type="output"}[5m]))` |
| gen_ai P95 LLM latency | `histogram_quantile(0.95, sum(rate(gen_ai_client_operation_duration_seconds_bucket[5m])) by (le))` |
| gen_ai token usage by model | `sum by (gen_ai_request_model) (rate(gen_ai_client_token_usage_bucket[5m]))` |
| gen_ai cache read tokens | `sum(rate(gen_ai_client_token_usage_sum{gen_ai_token_type="cache_read_input"}[5m]))` |
| gen_ai cache write tokens | `sum(rate(gen_ai_client_token_usage_sum{gen_ai_token_type="cache_creation_input"}[5m]))` |
| Cost by token type | `sum by (token_type) (increase(openclaw_lens_cost_by_token_type[$__range]))` |
| Cost by model & provider | `sum by (model, provider) (increase(openclaw_lens_cost_by_model_total[$__range]))` |
| Message types rate | `sum by (type) (rate(openclaw_lens_session_message_types[$__rate_interval]))` |
| Cache savings USD | `openclaw_lens_cache_savings_usd` |
| Cache token ratio | `openclaw_lens_cache_token_ratio` |
| Avg LLM latency | `openclaw_lens_session_latency_avg_ms` |
| Sessions started rate | `rate(openclaw_lens_sessions_started_total[5m])` |
| P50 session duration | `histogram_quantile(0.5, sum(rate(openclaw_lens_session_duration_ms_bucket[5m])) by (le))` |
| Compaction rate | `rate(openclaw_lens_compactions_total[5m])` |
| Subagent spawn rate | `rate(openclaw_lens_subagents_spawned_total[5m])` |
| Session completion rate | `rate(openclaw_lens_sessions_completed_total[5m])` |
| Session success rate | `sum(rate(openclaw_lens_sessions_completed_total{outcome="success"}[5m])) / sum(rate(openclaw_lens_sessions_completed_total[5m]))` |
| P95 subagent duration | `histogram_quantile(0.95, sum(rate(openclaw_lens_subagent_duration_ms_bucket[5m])) by (le))` |
| Subagent duration by mode | `histogram_quantile(0.95, sum by (le, mode) (rate(openclaw_lens_subagent_duration_ms_bucket[5m])))` |
| Message delivery success rate | `sum(rate(openclaw_lens_message_delivery_total{success="true"}[5m])) / sum(rate(openclaw_lens_message_delivery_total[5m]))` |
| Prompt injection signals (1h) | `sum(increase(openclaw_lens_prompt_injection_signals_total[1h]))` |
| Gateway restarts (24h) | `sum(increase(openclaw_lens_gateway_restarts_total[24h]))` |
| Webhook error ratio | `rate(openclaw_lens_webhook_error_total[5m]) / (rate(openclaw_lens_webhook_received_total[5m]) + 0.001)` |
| Tool error rate by class | `sum by (tool, error_class) (rate(openclaw_lens_tool_error_classes_total[5m]))` |
| Session resets by reason | `sum by (reason) (increase(openclaw_lens_session_resets_total[1h]))` |
| Unique sessions (1h rolling) | `openclaw_lens_unique_sessions_1h` |
| Session completion rate anomaly | `rate(openclaw_lens_sessions_completed_total[5m]) > 3 * avg_over_time(rate(openclaw_lens_sessions_completed_total[5m])[1h:5m])` |

## Common LogQL Expressions

Use with `grafana_query_logs` against a Loki datasource. All OpenClaw agent logs use `service_name="openclaw"` (standard OTLP resource attribute mapping).

| Question | LogQL |
|----------|-------|
| All errors | `{service_name="openclaw"} \| logfmt \| level="ERROR"` |
| Errors and warnings | `{service_name="openclaw"} \| logfmt \| level=~"ERROR\|WARN"` |
| All tool calls | `{service_name="openclaw"} \|= "openclaw.tool.call" \| logfmt` |
| Specific tool calls | `{service_name="openclaw"} \|= "openclaw.tool.call" \| logfmt \| gen_ai_tool_name="grafana_query"` |
| Slow LLM calls (>10s) | `{service_name="openclaw"} \|= "openclaw.llm.output" \| logfmt \| openclaw_duration_s > 10` |
| Delivery failures | `{service_name="openclaw"} \|= "openclaw.message.sent" \| logfmt \| openclaw_success="false"` |
| Session events | `{service_name="openclaw"} \| logfmt \| event_name=~"session\\..*"` |
| Compaction events | `{service_name="openclaw"} \| logfmt \| event_name=~"compaction\\..*"` |
| Subagent events | `{service_name="openclaw"} \| logfmt \| event_name=~"subagent\\..*"` |
| Subagent linking events | `{service_name="openclaw"} \| logfmt \| event_name="subagent.linked"` |
| Child sessions of a parent | `{service_name="openclaw"} \| json \| event_name="usage.session_summary" \| openclaw_parent_session_id="<parent_id>"` |
| All subagent sessions | `{service_name="openclaw"} \| json \| event_name="usage.session_summary" \| openclaw_is_subagent="true"` |
| Parent sessions with children | `{service_name="openclaw"} \| json \| event_name="usage.session_summary" \| openclaw_has_children="true"` |
| Logs with trace correlation | `{service_name="openclaw"} \| logfmt \| trace_id != ""` |
| Session usage summaries | `{service_name="openclaw"} \|= "usage.session_summary"` |
| High-cost sessions (>$1) | `{service_name="openclaw"} \| json \| event_name="usage.session_summary" \| openclaw_cost_total > 1` |
| Sessions with errors | `{service_name="openclaw"} \| json \| event_name="usage.session_summary" \| openclaw_messages_errors > 0` |
| Low cache efficiency | `{service_name="openclaw"} \| json \| event_name="usage.session_summary" \| openclaw_cache_hit_ratio < 0.5` |
| Slow sessions (avg >10s) | `{service_name="openclaw"} \| json \| event_name="usage.session_summary" \| openclaw_latency_avg_ms > 10000` |
| Security events (injections, gateway) | `{service_name="openclaw"} \| json \| component="lifecycle" \| event_name=~"prompt_injection.detected\|gateway.start\|gateway.stop"` |
| Tool loop events | `{service_name="openclaw"} \| json \| component="diagnostic" \| event_name="tool.loop"` |
| Gateway lifecycle events | `{service_name="openclaw"} \| json \| component="lifecycle" \| event_name=~"gateway.*"` |

**Tip**: Log lines include `trace_id` and `span_id` attributes for click-through from Loki → Tempo in Grafana. Use the Tempo datasource in a "Derived fields" config on Loki to enable automatic trace links.

## Common TraceQL Expressions

Use in Grafana's Tempo Explore view or in Tempo trace panel search filters. All OpenClaw traces use `resource.service.name="openclaw"`.

| Question | TraceQL |
|----------|---------|
| Session traces (root spans) | `{resource.service.name="openclaw" && name=~"invoke_agent.*"}` |
| LLM calls | `{resource.service.name="openclaw" && name=~"chat.*"}` |
| All tool executions | `{resource.service.name="openclaw" && span.gen_ai.operation.name="execute_tool"}` |
| Specific tool calls | `{resource.service.name="openclaw" && span.gen_ai.tool.name="grafana_query"}` |
| Slow LLM calls (>10s) | `{resource.service.name="openclaw" && name=~"chat.*" && duration > 10s}` |
| Errored spans | `{resource.service.name="openclaw" && status=error}` |
| By model | `{resource.service.name="openclaw" && span.gen_ai.request.model=~"claude.*"}` |
| High token usage | `{resource.service.name="openclaw" && span.gen_ai.usage.input_tokens > 50000}` |
| Subagent root spans | `{resource.service.name="openclaw" && span.openclaw.is_subagent=true && name=~"invoke_agent.*"}` |
| Child traces of a parent | `{resource.service.name="openclaw" && span.openclaw.parent_trace_id="<parent_trace_id>" && name=~"invoke_agent.*"}` |
| Long-lived subagent spawn spans | `{resource.service.name="openclaw" && name=~"openclaw.subagent.spawn.*"}` |
| Subagent spawn spans with links | `{resource.service.name="openclaw" && name=~"openclaw.subagent.spawn.*" && span.openclaw.subagent.child_session_id!=""}` |

**Span hierarchy**: `invoke_agent openclaw` (root) → `chat {model}` (LLM call) → `execute_tool {toolName}` (tool execution). Additional spans: `openclaw.compaction`, `openclaw.subagent.spawn` (long-lived, brackets subagent lifetime), `openclaw.agent.end`, `openclaw.message.received`, `openclaw.message.sent`.

**Cross-trace correlation (subagents)**: Subagent spawn spans have bidirectional span links to child root spans. Use `span.links.traceId` in TraceQL to navigate. Child root spans have `openclaw.parent_trace_id` for querying related traces. Session explorer dashboard provides clickable drill-down.

## Alert-Worthy Metrics

| Condition | PromQL | Suggested Threshold |
|-----------|--------|-------------------|
| Stuck sessions | `openclaw_lens_sessions_stuck > 0` | Any stuck session |
| Long stuck session | `openclaw_lens_stuck_session_max_age_ms > 60000` | Stuck > 60s |
| Tool loops detected | `sum(openclaw_lens_tool_loops_active) > 0` | Any active loop |
| High daily cost | `openclaw_lens_daily_cost_usd > 5` | $5/day |
| Queue backed up | `openclaw_lens_queue_depth > 20` | 20+ queued |
| Webhook latency spike | `histogram_quantile(0.95, sum(rate(openclaw_lens_webhook_duration_ms_bucket[5m])) by (le)) > 5000` | p95 > 5s |
| Queue wait too long | `histogram_quantile(0.95, sum(rate(openclaw_lens_queue_wait_ms_bucket[5m])) by (le)) > 30000` | p95 > 30s |
| High stuck session rate | `rate(openclaw_lens_sessions_stuck[5m]) > 0.1` | > 0.1/s (sustained) |
| Excessive webhook errors | `rate(openclaw_lens_webhook_error_total[5m]) > 0.1` | > 0.1 errors/s |
| Message error rate | `rate(openclaw_lens_messages_processed_total{outcome="error"}[5m]) > 0.1` | > 0.1 errors/s |
| Queue drain stall | `sum(rate(openclaw_lens_queue_lane_enqueue_total[5m])) > 2 * sum(rate(openclaw_lens_queue_lane_dequeue_total[5m]))` | Enqueue 2x dequeue |
| Context window near limit | `openclaw_lens_context_tokens{type="used"} / openclaw_lens_context_tokens{type="limit"} > 0.9` | > 90% used |
| Slow LLM calls (gen_ai) | `histogram_quantile(0.95, sum(rate(gen_ai_client_operation_duration_seconds_bucket[5m])) by (le)) > 30` | p95 > 30s |
| High compaction rate | `rate(openclaw_lens_compactions_total[5m]) > 0.1` | > 0.1/s (context thrashing) |
| Message delivery failures | `rate(openclaw_lens_message_delivery_total{success="false"}[5m]) > 0.1` | > 0.1 failures/s |
| Low cache efficiency | `openclaw_lens_cache_token_ratio < 0.3` | Cache ratio < 30% |
| High avg LLM latency | `openclaw_lens_session_latency_avg_ms > 15000` | > 15s average |
| High session error rate | `sum(rate(openclaw_lens_sessions_completed_total{outcome="error"}[5m])) / sum(rate(openclaw_lens_sessions_completed_total[5m])) > 0.2` | > 20% errors |
| Slow subagents | `histogram_quantile(0.95, sum(rate(openclaw_lens_subagent_duration_ms_bucket[5m])) by (le)) > 120000` | p95 > 2min |
| Prompt injection signals | `sum(increase(openclaw_lens_prompt_injection_signals_total[1h])) > 3` | 3+ signals/hour |
| Gateway restarts | `sum(increase(openclaw_lens_gateway_restarts_total[1h])) > 2` | 2+ restarts/hour |
| Webhook error ratio high | `rate(openclaw_lens_webhook_error_total[5m]) / (rate(openclaw_lens_webhook_received_total[5m]) + 0.001) > 0.2` | > 20% errors |
| Session enumeration | `openclaw_lens_unique_sessions_1h > 50` | 50+ unique sessions/hour |
| Tool error burst | `sum(rate(openclaw_lens_tool_error_classes_total[5m])) > 0.5` | > 0.5 errors/s |
| Cost spike | `openclaw_lens_daily_cost_usd > 10` | $10/day |

## Session Summary Log — Subagent Hierarchy Attributes

The `usage.session_summary` log (event_name=`usage.session_summary`) includes these additional attributes for subagent correlation:

| Attribute (Loki key) | Present When | Value |
|----------------------|-------------|-------|
| `openclaw_is_subagent` | Session is a spawned subagent | `true` |
| `openclaw_parent_session_id` | Session is a spawned subagent | Parent session ID (clickable in Session Explorer) |
| `openclaw_child_session_ids` | Session spawned subagents | Comma-separated child session IDs |
| `openclaw_child_count` | Session spawned subagents | Number of child sessions |
| `openclaw_has_children` | Session spawned subagents | `true` |

## Log Event Types — Subagent Lifecycle

| Event Name | Description | Key Attributes |
|------------|-------------|----------------|
| `subagent.spawn` | Subagent spawned by parent | `openclaw_agent_id`, `openclaw_mode`, `openclaw_child_session_key` |
| `subagent.linked` | Deferred linking completed — child matched to parent | `openclaw_session_id` (child), `openclaw_parent_session_id`, `openclaw_parent_trace_id`, `openclaw_subagent_agent_id` |
| `subagent.end` | Subagent finished | `openclaw_target_session_key`, `openclaw_reason`, `openclaw_outcome` |

## SRE Investigation Patterns

For advanced investigation patterns — anomaly detection (z-score, predict_linear),
RED/USE method compositions, SLI/SLO burn rates, and multi-signal investigation workflows
— see [sre-investigation.md](sre-investigation.md).
