# Dashboard Composition Guide

How to choose templates, compose custom dashboards, and select the right panel types for any metric.

## Template Selection

Pick the right template based on what the user is asking:

| User mentions | Template | Why |
|--------------|----------|-----|
| Server, CPU, memory, disk, system health | `node-exporter` | Pre-built system panels with `$instance` filter |
| HTTP, API, requests, errors, latency, RED | `http-service` | Golden signals with `$job` filter |
| "Explore", single metric deep-dive | `metric-explorer` | 6 angles on any single `$metric` |
| Multiple KPIs, overview, top-N metrics | `multi-kpi` | 4-metric dashboard with `$metric1`..`$metric4` |
| Agent health, cost, latency, errors, live feeds | `llm-command-center` | Single-pane AI health with `$provider`, `$model`, `$channel` filters |
| Per-session drill-down, trace hierarchy | `session-explorer` | Session debug with `$session` textbox + Tempo traces |
| Cost trends, model attribution, cache savings | `cost-intelligence` | Financial analysis with `$provider`, `$model` filters |
| Tool reliability, latency ranking, SRE | `tool-performance` | Tool leaderboard with `$tool` filter + Tempo traces |
| Weekly review, calendar, commits, habits | `weekly-review` | Cross-domain life dashboard |
| Nothing fits | **Custom JSON** | Compose using the rules below |

**All templates have dropdown selectors** in Grafana. AI templates (`llm-command-center`, `session-explorer`, `cost-intelligence`, `tool-performance`) also have Loki log-to-trace correlation via Tempo.

## Metric Type → Panel Type

Use `grafana_list_metrics` with `metadata: true` to learn metric types before composing.

| Metric Type | Best Panel | PromQL Pattern | Example |
|-------------|-----------|----------------|---------|
| counter | timeseries (rate) | `rate(metric[5m])` | `rate(http_requests_total[5m])` |
| counter (total) | stat | `sum(metric)` | `sum(orders_total)` |
| gauge (current) | stat or gauge | `metric` | `sensor_temperature_celsius` |
| gauge (over time) | timeseries | `metric` | `portfolio_value_usd` |
| histogram (percentiles) | timeseries | `histogram_quantile(0.95, sum(rate(metric_bucket[5m])) by (le))` | HTTP latency p95 |
| histogram (heatmap) | heatmap | `sum(rate(metric_bucket[5m])) by (le)` | Request duration distribution |

**Important**: `histogram_quantile` MUST include `sum(...) by (le)` to aggregate across label dimensions. Without it, percentile calculations are incorrect when multiple series exist (e.g., per-model, per-channel).

## Unit Detection from Metric Name

Suffix-based unit selection for `fieldConfig.defaults.unit`:

| Suffix | Unit | Example Metric |
|--------|------|---------------|
| `_bytes` | `bytes` | `node_memory_MemTotal_bytes` |
| `_seconds` | `s` | `http_request_duration_seconds` |
| `_total` | `short` | `http_requests_total` |
| `_total` (in rate()) | `reqps` or `ops` | `rate(http_requests_total[5m])` |
| `_usd` | `currencyUSD` | `openclaw_cost_usd_total` |
| `_ratio` | `percentunit` | `cache_hit_ratio` |
| `_celsius` | `celsius` | `sensor_temperature_celsius` |
| `_percent` | `percent` | `cpu_usage_percent` |
| `_bpm` | `short` | `fitness_heart_rate_bpm` |
| no suffix | `short` | `up`, `active_users` |

## Variable-Based Panel JSON

All custom panels should reference `$datasource` so users can switch datasources in the UI.

### Stat Panel
```json
{
  "id": 1,
  "title": "Current Orders",
  "type": "stat",
  "gridPos": { "h": 4, "w": 6, "x": 0, "y": 0 },
  "datasource": { "type": "prometheus", "uid": "$datasource" },
  "targets": [{ "expr": "sum(orders_total)", "legendFormat": "orders", "refId": "A" }],
  "fieldConfig": { "defaults": { "unit": "short" } }
}
```

### Timeseries (Line)
```json
{
  "id": 2,
  "title": "Request Rate",
  "type": "timeseries",
  "gridPos": { "h": 8, "w": 12, "x": 0, "y": 4 },
  "datasource": { "type": "prometheus", "uid": "$datasource" },
  "targets": [{ "expr": "rate(http_requests_total[5m])", "legendFormat": "{{ handler }}", "refId": "A" }],
  "fieldConfig": { "defaults": { "unit": "reqps", "custom": { "fillOpacity": 10 } } }
}
```

### Timeseries (Stacked Bars)
```json
{
  "id": 3,
  "title": "Response Codes",
  "type": "timeseries",
  "gridPos": { "h": 8, "w": 12, "x": 12, "y": 4 },
  "datasource": { "type": "prometheus", "uid": "$datasource" },
  "targets": [{ "expr": "sum(rate(http_requests_total[5m])) by (code)", "legendFormat": "{{ code }}", "refId": "A" }],
  "fieldConfig": { "defaults": { "unit": "reqps", "custom": { "fillOpacity": 50, "stacking": { "mode": "normal" } } } }
}
```

### Gauge Panel (with thresholds)
```json
{
  "id": 4,
  "title": "CPU Usage",
  "type": "gauge",
  "gridPos": { "h": 6, "w": 6, "x": 0, "y": 0 },
  "datasource": { "type": "prometheus", "uid": "$datasource" },
  "targets": [{ "expr": "cpu_usage_percent", "refId": "A" }],
  "fieldConfig": {
    "defaults": {
      "unit": "percent", "min": 0, "max": 100,
      "thresholds": {
        "mode": "absolute",
        "steps": [
          { "color": "green", "value": null },
          { "color": "yellow", "value": 70 },
          { "color": "red", "value": 90 }
        ]
      }
    }
  }
}
```

### Piechart
```json
{
  "id": 5,
  "title": "Cost by Model",
  "type": "piechart",
  "gridPos": { "h": 8, "w": 12, "x": 0, "y": 12 },
  "datasource": { "type": "prometheus", "uid": "$datasource" },
  "targets": [{ "expr": "sum(openclaw_cost_usd_total) by (openclaw_model)", "legendFormat": "{{ openclaw_model }}", "refId": "A", "instant": true }]
}
```

### Table
```json
{
  "id": 6,
  "title": "All Series",
  "type": "table",
  "gridPos": { "h": 8, "w": 12, "x": 12, "y": 12 },
  "datasource": { "type": "prometheus", "uid": "$datasource" },
  "targets": [{ "expr": "up", "format": "table", "instant": true, "refId": "A" }]
}
```

### Logs Panel (Loki)

For dashboards with Loki datasources. Use `$loki` variable for multi-signal dashboards.

```json
{
  "id": 7,
  "title": "Error Logs",
  "type": "logs",
  "gridPos": { "h": 10, "w": 12, "x": 0, "y": 0 },
  "datasource": { "type": "loki", "uid": "$loki" },
  "targets": [{ "expr": "{service_name=\"openclaw\"} | logfmt | level=~\"ERROR|WARN\"", "refId": "A" }],
  "options": {
    "showTime": true,
    "showLabels": false,
    "showCommonLabels": false,
    "wrapLogMessage": true,
    "prettifyLogMessage": false,
    "enableLogDetails": true,
    "sortOrder": "Descending",
    "dedupStrategy": "none"
  }
}
```

### Traces Panel (Tempo)

For dashboards with Tempo datasources. Use `$tempo` variable for multi-signal dashboards. Uses `traceqlSearch` query type with structured filters.

```json
{
  "id": 8,
  "title": "Recent Traces",
  "type": "traces",
  "gridPos": { "h": 10, "w": 12, "x": 12, "y": 0 },
  "datasource": { "type": "tempo", "uid": "$tempo" },
  "targets": [{
    "queryType": "traceqlSearch",
    "filters": [
      { "id": "service-name", "tag": "service.name", "operator": "=", "value": ["openclaw"], "scope": "resource" },
      { "id": "span-name", "tag": "name", "operator": "=~", "value": ["invoke_agent.*"], "scope": "span" }
    ],
    "limit": 20,
    "refId": "A"
  }]
}
```

**Multi-signal datasource variables**: When combining Prometheus, Loki, and Tempo in one dashboard, use separate datasource variables (`$prometheus`, `$loki`, `$tempo`) instead of a single `$datasource`. Each panel references the variable matching its datasource type.

## Grid Layout Rules

Grafana uses a 24-column grid:

```
Row panel (y:0):  section header (w:24, h:1) — collapsible
Row 0 (y:1):      6× stat panels (w:4, h:3) — summary KPIs
Row panel (y:4):  section header (w:24, h:1)
Row 1 (y:5):      2× timeseries (w:12, h:8) — main charts
Row panel (y:13): section header (w:24, h:1)
Row 2 (y:14):     2× detail panels (w:12, h:8) — breakdowns, tables
```

### Row Panels (Section Headers)
```json
{
  "id": 1,
  "title": "Section Name",
  "type": "row",
  "gridPos": { "h": 1, "w": 24, "x": 0, "y": 0 },
  "collapsed": false,
  "panels": []
}
```

### Panel Conventions
- **Descriptions**: Every panel should have a `"description"` field explaining what it shows, healthy ranges, and when to investigate
- **Table legends**: Timeseries panels should use `"options": { "legend": { "displayMode": "table", "placement": "bottom", "calcs": ["lastNotNull", "mean", "max"] } }`
- **Stat sparklines**: Add `"options": { "graphMode": "area" }` to stat panels where trends matter
- **Background color**: Add `"options": { "colorMode": "background" }` to critical stat panels with thresholds
- **Threshold mode**: Always include `"mode": "absolute"` in threshold blocks for Grafana 10+ compatibility
- **spanNulls**: Add `"custom": { "spanNulls": true }` to timeseries to prevent broken lines during metric gaps
- **Dashboard links**: Add `"links"` with tag-based discovery for dashboard navigation
- **Annotations**: Add `"annotations.list"` with built-in Grafana annotations for deployment markers
- **Piechart queries**: Use `"instant": true` on piechart targets to show current proportions
- **Histogram percentiles**: Always use `sum(...) by (le)` inside `histogram_quantile` — e.g., `histogram_quantile(0.95, sum(rate(metric_bucket[5m])) by (le))`

## Dashboard JSON Skeleton

When composing a custom dashboard, wrap panels in this structure:

```json
{
  "title": "My Dashboard",
  "tags": ["grafana-lens"],
  "timezone": "browser",
  "editable": true,
  "schemaVersion": 39,
  "time": { "from": "now-24h", "to": "now" },
  "refresh": "30s",
  "links": [
    {
      "title": "Related Dashboards",
      "tags": ["grafana-lens"],
      "type": "dashboards",
      "asDropdown": true,
      "icon": "external link"
    }
  ],
  "annotations": {
    "list": [
      {
        "builtIn": 1,
        "datasource": { "type": "grafana", "uid": "-- Grafana --" },
        "enable": true,
        "hide": true,
        "iconColor": "rgba(0, 211, 255, 1)",
        "name": "Annotations & Alerts",
        "type": "dashboard"
      }
    ]
  },
  "templating": {
    "list": [
      { "name": "datasource", "type": "datasource", "query": "prometheus", "current": {}, "hide": 0 }
    ]
  },
  "panels": [ ]
}
```

## Domain Worked Examples

### E-commerce Dashboard

**Discovery**: `grafana_list_metrics` with `metadata: true`, `prefix: "orders_"` or `"revenue_"`

**Template choice**: `multi-kpi` for quick overview, or custom for specific layout.

**Custom composition** (if `multi-kpi` isn't enough):
| Panel | Type | PromQL | Unit |
|-------|------|--------|------|
| Total Revenue | stat | `sum(revenue_usd_total)` | `currencyUSD` |
| Orders/min | stat | `sum(rate(orders_total[5m])) * 60` | `short` |
| Cart Abandonment | gauge | `cart_abandonment_ratio * 100` | `percent` |
| Revenue Over Time | timeseries | `sum(rate(revenue_usd_total[1h])) by (product)` | `currencyUSD` |
| Orders by Region | timeseries (stacked) | `sum(rate(orders_total[5m])) by (region)` | `ops` |

### IoT / Sensor Monitoring

**Discovery**: `grafana_list_metrics` with `prefix: "sensor_"`

**Template choice**: `metric-explorer` for one sensor, `multi-kpi` for overview of 4 sensors.

**Custom composition**:
| Panel | Type | PromQL | Unit |
|-------|------|--------|------|
| Temperature | gauge | `sensor_temperature_celsius` | `celsius` |
| Humidity | gauge | `sensor_humidity_ratio * 100` | `percent` |
| Temperature Over Time | timeseries | `sensor_temperature_celsius` | `celsius` |
| Battery Voltage | timeseries | `sensor_battery_volts` | `volt` |

### Fitness / Health Tracking

**Discovery**: `grafana_list_metrics` with `prefix: "fitness_"` or `"health_"`

**Template choice**: `multi-kpi` with steps, heart rate, sleep hours, calories.

**Custom composition**:
| Panel | Type | PromQL | Unit |
|-------|------|--------|------|
| Steps Today | stat | `fitness_steps_total` | `short` |
| Heart Rate | gauge | `fitness_heart_rate_bpm` | `short` (suffix: bpm) |
| Steps Over Time | timeseries | `rate(fitness_steps_total[1h]) * 3600` | `short` |
| Sleep Hours | timeseries | `health_sleep_hours` | `short` |

### Financial / Portfolio

**Discovery**: `grafana_list_metrics` with `prefix: "portfolio_"` or `"crypto_"`

**Template choice**: `metric-explorer` for deep-dive on one asset, `multi-kpi` for portfolio overview.

**Custom composition**:
| Panel | Type | PromQL | Unit |
|-------|------|--------|------|
| Portfolio Value | stat | `portfolio_value_usd` | `currencyUSD` |
| BTC Price | stat | `crypto_price_usd{coin="btc"}` | `currencyUSD` |
| Portfolio Over Time | timeseries | `portfolio_value_usd` | `currencyUSD` |
| Asset Allocation | piechart | `portfolio_allocation_usd` by asset (instant) | `currencyUSD` |

### Redis / Database

**Discovery**: `grafana_list_metrics` with `metadata: true`, `prefix: "redis_"`

**Template choice**: Custom — Redis has specific panel needs.

**Custom composition**:
| Panel | Type | PromQL | Unit |
|-------|------|--------|------|
| Commands/sec | stat | `rate(redis_commands_processed_total[5m])` | `ops` |
| Memory Used | gauge | `redis_memory_used_bytes / redis_memory_max_bytes * 100` | `percent` |
| Connected Clients | stat | `redis_connected_clients` | `short` |
| Command Rate Over Time | timeseries | `rate(redis_commands_processed_total[5m])` | `ops` |
| Memory Over Time | timeseries | `redis_memory_used_bytes` | `bytes` |
| Hit Rate | timeseries | `rate(redis_keyspace_hits_total[5m]) / (rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m]))` | `percentunit` |

### CI/CD Pipeline

**Discovery**: `grafana_list_metrics` with `prefix: "ci_"` or `"github_"`

**Template choice**: Custom for specific CI workflow.

**Custom composition**:
| Panel | Type | PromQL | Unit |
|-------|------|--------|------|
| Builds Today | stat | `sum(ci_builds_total)` | `short` |
| Success Rate | gauge | `sum(rate(ci_builds_total{status="success"}[24h])) / sum(rate(ci_builds_total[24h])) * 100` | `percent` |
| Build Duration p95 | stat | `histogram_quantile(0.95, sum(rate(ci_build_duration_seconds_bucket[1h])) by (le))` | `s` |
| Build Duration Over Time | timeseries | p50/p95/p99 of `ci_build_duration_seconds` | `s` |
| Builds by Status | timeseries (stacked) | `sum(rate(ci_builds_total[1h])) by (status)` | `ops` |
