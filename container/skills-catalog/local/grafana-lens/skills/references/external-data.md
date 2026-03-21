# External Data — Naming Conventions & Integration Patterns

Custom metrics pushed via `grafana_push_metrics` use the `openclaw_ext_` prefix and follow Prometheus naming conventions.

## Naming by Domain

| Domain | Prefix | Example Metrics |
|--------|--------|----------------|
| Calendar | `openclaw_ext_calendar_` | `calendar_meetings`, `calendar_focus_hours`, `calendar_meeting_duration_minutes` |
| Git | `openclaw_ext_git_` | `git_commits_today`, `git_lines_changed`, `git_prs_merged` |
| Fitness | `openclaw_ext_fitness_` | `fitness_steps`, `fitness_weight_kg`, `fitness_calories`, `fitness_sleep_hours` |
| Finance | `openclaw_ext_finance_` | `finance_balance_usd`, `finance_expenses_today`, `finance_savings_rate` |
| Content | `openclaw_ext_content_` | `content_posts_published`, `content_views`, `content_subscribers` |
| Tasks | `openclaw_ext_tasks_` | `tasks_completed`, `tasks_open`, `tasks_overdue` |

## Label Design Guidelines

- **Keep cardinality low** — max 50 unique label-value combinations per metric
- **Avoid per-user-id labels** — use roles or categories instead (`team: "engineering"` not `user_id: "abc123"`)
- **Use consistent label names** across metrics in the same domain (e.g., always `type` not sometimes `kind`)
- **Label names**: lowercase with underscores, no hyphens or colons

## PromQL Patterns for External Data

| Query | PromQL |
|-------|--------|
| All custom metrics | `{__name__=~"openclaw_ext_.*"}` |
| All calendar metrics | `{__name__=~"openclaw_ext_calendar_.*"}` |
| Count of custom metrics | `count({__name__=~"openclaw_ext_.*"})` |
| Weekly average | `avg_over_time(openclaw_ext_fitness_steps[7d])` |
| Daily trend | `openclaw_ext_git_commits_today` with range `now-7d` to `now` |
| Custom counter rate | `rate(openclaw_ext_api_calls_total[5m])` |
| Custom gauge value | `openclaw_ext_fitness_steps` |

## Example: Weekly Work Review Workflow

1. Push daily work data:
```json
{ "metrics": [
  { "name": "git_commits_today", "value": 12 },
  { "name": "calendar_meetings", "value": 4, "labels": { "type": "standup" } },
  { "name": "calendar_focus_hours", "value": 5.5 },
  { "name": "tasks_completed", "value": 3 }
]}
```

2. Create dashboard: `{ "template": "weekly-review", "title": "My Work Week" }`

3. Query totals: `{ "expr": "openclaw_ext_git_commits_today", "datasourceUid": "prom1" }`

4. Share chart: `{ "dashboardUid": "...", "panelId": 4, "from": "now-7d" }`

## Historical Backfill

To push data with specific timestamps (e.g., last week's step counts), add `timestamp` (ISO 8601) to each data point.

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `timestamp` | No | string | ISO 8601 (e.g., `"2025-01-15"`, `"2025-01-15T10:30:00Z"`). Omit for current time. |

**Rules:**
- Only gauge metrics support timestamps — counters with timestamps are rejected
- Timestamped and real-time points can be mixed in one batch
- Multiple timestamps for the same metric in one call is supported (e.g., 7 days of steps)
- Data flows through OTLP to the same backend — same PromQL queries work

**Example: Backfill a week of fitness data**
```json
{ "metrics": [
  { "name": "fitness_steps", "value": 8000, "timestamp": "2025-01-13" },
  { "name": "fitness_steps", "value": 10500, "timestamp": "2025-01-14" },
  { "name": "fitness_steps", "value": 7200, "timestamp": "2025-01-15" },
  { "name": "fitness_steps", "value": 12000, "timestamp": "2025-01-16" },
  { "name": "fitness_steps", "value": 6500, "timestamp": "2025-01-17" },
  { "name": "fitness_steps", "value": 15000, "timestamp": "2025-01-18" },
  { "name": "fitness_steps", "value": 9800, "timestamp": "2025-01-19" }
]}
```

Then query with: `avg_over_time(openclaw_ext_fitness_steps[7d])`

**Backend note**: Some Prometheus/Mimir backends reject samples with timestamps too far in the past (configurable via `out_of_order_time_window`). New time series with no existing data should accept any timestamp.

## Metric Types

- **Gauge** (default): Values that go up and down — weight, temperature, account balance, step count.
  PromQL name = push name (e.g., push `steps` → query `openclaw_ext_steps`).
  Push is idempotent — last value wins.
- **Counter**: Values that only increase — total commits, total expenses, total API calls (lifetime).
  PromQL name gets `_total` suffix (e.g., push `api_calls` → query `openclaw_ext_api_calls_total`).
  Push is additive — value added to cumulative total. Use `rate()` in PromQL.

Push chooses gauge by default. Specify `"type": "counter"` for cumulative metrics.
The push response includes a `queryNames` map with exact PromQL names — use these directly.
