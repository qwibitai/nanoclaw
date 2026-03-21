# Grafana Lens

**Agent-driven Grafana observability for OpenClaw — query, visualize, alert, trace, and share across 15+ messaging channels.**

> **Note:** This is a community-built OpenClaw plugin, not an official Grafana Labs product. Grafana, Loki, Tempo, and Prometheus are trademarks of Grafana Labs.

[OpenClaw](https://openclaw.com) is an open-source AI agent platform. Grafana Lens extends it with full Grafana integration — 17 composable tools that let your agent query metrics and logs, trace distributed requests, create dashboards, set up alerts, render charts, run security audits, investigate incidents, and push custom data — all through natural language conversation.

---

## Why Grafana Lens?

| Pain Point | How Grafana Lens Helps |
|---|---|
| **"Where did my budget go?"** | Cost dashboards with model-level attribution, token tracking, and cost anomaly alerts |
| **"Is my agent stuck in a loop?"** | Real-time tool loop detection, stuck session monitoring, and SRE operations dashboard |
| **"Am I being prompt-injected?"** | 12-pattern prompt injection detection with security dashboard and threat-level reporting |
| **"I need observability but don't want another SaaS"** | Fully self-hosted, open source, OTLP-native — runs on a free local Grafana stack |
| **"I can't debug multi-step agent sessions"** | Hierarchical traces: session → LLM call → tool execution, with log-to-trace correlation |
| **"My alert fired — now what?"** | `grafana_investigate` gathers metrics, logs, traces in parallel and generates hypotheses with specific tool+params for follow-up |
| **"I want to track my own data in Grafana"** | Push any custom metrics (fitness, calendar, git, finance) from conversation |

---

## Key Features

- **17 Composable Agent Tools** — Query PromQL/LogQL/TraceQL, create dashboards, set alerts, share panel images, run security checks, investigate incidents, push custom metrics, and more
- **SRE Investigation** — Multi-signal triage (`grafana_investigate`), anomaly scoring with z-score against 7-day baselines, seasonality comparison, and alert fatigue detection
- **Full OTLP Observability** — Metrics → Prometheus, Logs → Loki, Traces → Tempo. Push-based with no scraping — data is available immediately
- **Security Monitoring** — 6-check threat assessment covering prompt injection, cost anomalies, tool loops, session enumeration, webhook errors, and stuck sessions
- **12 Pre-Built Dashboard Templates** — From LLM Command Center and Cost Intelligence to Security Overview and SRE Operations
- **Custom Data Observatory** — Push any external data (calendar events, git commits, fitness stats, financial metrics) into Grafana via conversation
- **Works with ANY Datasource** — Not limited to OpenClaw metrics. Query any Prometheus or Loki datasource configured in your Grafana instance

---

## Quick Start

```bash
# 1. Start the LGTM observability stack (Grafana + Prometheus + Loki + Tempo + OTel Collector)
#    See https://github.com/grafana/docker-otel-lgtm for more options
docker pull grafana/otel-lgtm:latest
docker run -d --name lgtm -p 3000:3000 -p 4317:4317 -p 4318:4318 -p 9090:9090 grafana/otel-lgtm:latest

# 2. Install the plugin
openclaw plugins install openclaw-grafana-lens

# 3. Configure credentials (see "Configuration" section below for full options)
export GRAFANA_URL=http://localhost:3000
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_xxxxxxxxxxxx

# 4. Restart the gateway to load the plugin
openclaw gateway restart
```

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup Guide](#setup-guide)
  - [LGTM Stack (Docker)](#1-lgtm-stack-docker)
  - [Plugin Installation](#2-plugin-installation)
  - [Configuration](#3-configuration)
- [What Can You Do?](#what-can-you-do)
- [Agent Tools](#agent-tools)
- [Dashboard Templates](#dashboard-templates)
- [Security Monitoring](#security-monitoring)
- [Custom Metrics](#custom-metrics-data-observatory)
- [Architecture](#architecture)
- [Observability Deep Dive](#observability-deep-dive)
- [Configuration Reference](#configuration-reference)
- [Development](#development)
- [License](#license)

---

## Prerequisites

- **OpenClaw** installed and running
- **Docker** (for the recommended LGTM stack) or an existing Grafana instance
  - [Grafana](https://grafana.com/grafana/) is an open-source platform for monitoring, visualization, and alerting. It connects to data sources like Prometheus (metrics), Loki (logs), and Tempo (traces) to give you dashboards, alerts, and exploration tools for any data.
- **Grafana Service Account Token** with Editor role (see setup steps below)

---

## Setup Guide

### 1. LGTM Stack (Docker)

The recommended local setup uses the [`grafana/otel-lgtm`](https://github.com/grafana/docker-otel-lgtm) all-in-one Docker image, maintained by Grafana Labs. It bundles everything you need in a single container — no configuration files, no compose setup:

| Component | Port | Purpose |
|-----------|------|---------|
| Grafana | 3000 | Dashboards, alerting, visualization |
| Prometheus | 9090 | Metrics storage and querying |
| Loki | — | Log aggregation |
| Tempo | — | Distributed tracing |
| OTel Collector | 4317 (gRPC), 4318 (HTTP) | Receives OTLP metrics, logs, and traces |

```bash
docker pull grafana/otel-lgtm:latest
docker run -d --name lgtm -p 3000:3000 -p 4317:4317 -p 4318:4318 -p 9090:9090 grafana/otel-lgtm:latest
```

> **Tip:** You can also use the [`run-lgtm.sh`](https://github.com/grafana/docker-otel-lgtm) scripts from the official repo for additional options like volume persistence and OBI auto-instrumentation.

**Default credentials:** `admin` / `admin`

#### Create a Service Account Token

1. Open Grafana at `http://localhost:3000`
2. Go to **Administration → Service Accounts → Add service account**
3. Name it (e.g., `grafana-lens`), set role to **Editor**
4. Click **Add service account token → Generate token**
5. Copy the token (starts with `glsa_`) — you'll need it for configuration

### 2. Plugin Installation

```bash
# Install from npm
openclaw plugins install openclaw-grafana-lens

# Restart the gateway to load the plugin
openclaw gateway restart
```

For local development:

```bash
# Clone and link locally
git clone <repo-url> ~/workspace/grafana-lens
cd ~/workspace/grafana-lens && npm install
openclaw plugins install -l ~/workspace/grafana-lens
openclaw gateway restart
```

### 3. Configuration

#### Minimal Setup (Environment Variables)

The simplest way to configure Grafana Lens — just two environment variables:

```bash
export GRAFANA_URL=http://localhost:3000
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_xxxxxxxxxxxx
```

#### Full Configuration

For more control, add the plugin config to `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-grafana-lens": {
        "enabled": true,
        "config": {
          "grafana": {
            "url": "http://localhost:3000",        // or set GRAFANA_URL env var
            "apiKey": "glsa_xxxxxxxxxxxx",         // or set GRAFANA_SERVICE_ACCOUNT_TOKEN env var
            "orgId": 1                             // optional, default 1
          },
          "metrics": {
            "enabled": true                        // enable OTLP telemetry (default: true)
          },
          "otlp": {
            "endpoint": "http://localhost:4318/v1/metrics",  // OTLP collector endpoint
            "exportIntervalMs": 15000,             // push interval in ms (default: 15000)
            "logs": true,                          // push logs to Loki (default: true)
            "traces": true,                        // push traces to Tempo (default: true)
            "captureContent": true,                // include prompts/completions in telemetry (default: true)
            "contentMaxLength": 2000,              // truncation limit for content fields (default: 2000)
            "forwardAppLogs": true,                // forward OpenClaw app logs to Loki (default: true)
            "appLogMinSeverity": "debug",          // min severity: trace/debug/info/warn/error/fatal
            "redactSecrets": true                  // auto-strip API keys/tokens before export (default: true)
          },
          "proactive": {
            "enabled": false,                      // enable Grafana alert webhook handler
            "webhookPath": "/grafana-lens/alerts", // HTTP path for webhook endpoint
            "costAlertThreshold": 5.0              // daily cost alert threshold in USD
          },
          "customMetrics": {
            "enabled": true,                       // allow custom metric push (default: true)
            "maxMetrics": 100,                     // max metric definitions
            "maxLabelsPerMetric": 5,               // max label keys per metric
            "maxLabelValues": 50,                  // max unique label combos per metric
            "defaultTtlDays": null                 // optional auto-expiry in days
          }
        }
      }
    }
  }
}
```

#### Environment Variable Fallbacks

| Env Var | Config Key | Description |
|---------|------------|-------------|
| `GRAFANA_URL` | `grafana.url` | Grafana instance URL |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | `grafana.apiKey` | Service account token |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `otlp.endpoint` | OTLP collector base URL (auto-appends `/v1/metrics`) |
| `OTEL_EXPORTER_OTLP_HEADERS` | `otlp.headers` | Custom headers in `key=value,key2=value2` format |

Config precedence: explicit plugin config > environment variables > defaults.

---

## What Can You Do?

### For OpenClaw Users — Bring Grafana Into Your Agent's Toolkit

Just talk to your agent in natural language:

- **"Create a cost dashboard"** — Creates a pre-built cost intelligence dashboard with model attribution, cache savings, and spending trends
- **"Alert me if daily spend exceeds $5"** — Sets up a Grafana-native alert rule with PromQL condition
- **"Show me a chart of my token usage"** — Renders a panel as a PNG image and delivers it inline to your chat
- **"Am I being attacked?"** — Runs 6 parallel security checks and reports a threat level (green/yellow/red)
- **"Track my daily steps"** — Pushes custom fitness data into Grafana via OTLP for personal dashboards
- **"What metrics are available?"** — Discovers all metrics in your Prometheus datasource with descriptions
- **"What does openclaw_lens_daily_cost_usd mean? Why did it spike?"** — Explains the metric with current value, trend, stats, and drill-down suggestions
- **"Find slow traces in the last hour"** — Searches Tempo traces by duration, status, or span attributes using TraceQL
- **"Show me the trace for session abc123"** — Retrieves full distributed trace with hierarchical span details
- **"Investigate this alert"** — Gathers metrics, logs, traces, and annotations in parallel and suggests hypotheses with specific follow-up tool+params
- **"Is this metric anomalous?"** — Shows z-score against 7-day baseline, seasonality comparison (vs 1 day ago, vs 7 days ago), and severity rating
- **"Which alerts are noisy?"** — Detects always-firing, flapping, and error/nodata rules with optimization suggestions
- **Create and customize your own unique dashboards** — Combine any data from Prometheus, Loki, or custom metrics to build personalized monitoring views

### For Grafana Power Users — Let an AI Agent Manage Your Grafana

- **Natural language PromQL** — Ask questions about your metrics without memorizing syntax
- **Automated alert creation** — Describe alert conditions in plain English; the agent generates the PromQL and creates the rule
- **Dashboard management** — Create, update, add/remove panels, or delete dashboards via conversation
- **Panel sharing** — Render any dashboard panel as an image and deliver it to Telegram, Slack, Discord, and 15+ other channels
- **Infrastructure monitoring** — Use pre-built templates for node-exporter and HTTP service monitoring
- **Metric exploration** — Discover, explain, and drill into any metric with `grafana_explain_metric`
- **Dashboard auditing** — Health-check all panels in a dashboard, find broken queries, verify datasource connectivity
- **Search and discovery** — Find existing dashboards by title, tags, or starred status

---

## Agent Tools

All 17 tools are registered automatically when the plugin loads. The agent decides when to use each tool based on your request.

| Tool | Description | Example Use |
|------|-------------|-------------|
| `grafana_explore_datasources` | Discover datasources configured in Grafana | "What data sources do I have?" |
| `grafana_list_metrics` | Discover available metrics with optional metadata | "What metrics are available?" |
| `grafana_query` | Run PromQL instant or range queries | "What's my token usage today?" |
| `grafana_query_logs` | Run LogQL queries against Loki | "Show me error logs from the last hour" |
| `grafana_create_dashboard` | Create dashboards from 12 templates or custom JSON | "Create a cost dashboard" |
| `grafana_update_dashboard` | Add, remove, or update panels; change dashboard metadata | "Add a latency panel to my dashboard" |
| `grafana_get_dashboard` | Get compact dashboard summary with optional health audit | "What panels are on my overview?" |
| `grafana_search` | Search dashboards by title, tags, or starred status | "Do I have a cost dashboard?" |
| `grafana_share_dashboard` | Render panels as PNG images for inline delivery | "Show me a chart of my costs" |
| `grafana_create_alert` | Create Grafana-native alert rules with PromQL conditions | "Alert me if daily cost > $5" |
| `grafana_check_alerts` | List, acknowledge, silence alerts; manage rules and webhooks | "Are there any alerts firing?" |
| `grafana_annotate` | Create or query event annotations on dashboards | "Mark that deployment on my dashboard" |
| `grafana_push_metrics` | Push custom data (calendar, git, fitness, finance) via OTLP | "Track my daily steps in Grafana" |
| `grafana_explain_metric` | Get metric context: current value, trend, stats, metadata | "Why did my bill spike?" |
| `grafana_security_check` | Run 6 parallel security checks → threat level report | "Am I being attacked?" |
| `grafana_query_traces` | Run TraceQL queries against Tempo; search traces or get full trace by ID | "Find slow traces" / "Show trace for session X" |
| `grafana_investigate` | Multi-signal investigation triage with hypothesis generation | "Investigate this alert" / "What's wrong?" / "Root cause" |

---

## Dashboard Templates

Grafana Lens includes 12 pre-built dashboard templates. Create any of them with:

> "Create a \<template-name\> dashboard"

### AI Observability (Tier 1-3 Drill-Down Hierarchy)

| Template | Purpose | Key Panels |
|----------|---------|------------|
| `llm-command-center` | System overview (Tier 1) | Golden signals, live sessions, cost, cache efficiency, token rates |
| `session-explorer` | Session debugging (Tier 2) | Per-session traces, LLM calls, tool calls, conversation flow |
| `cost-intelligence` | Cost deep-dive (Tier 3a) | Spending trends, model attribution, cache savings, per-session cost |
| `tool-performance` | Tool analytics (Tier 3b) | Tool leaderboard, latency ranking, error rates, execution traces |
| `sre-operations` | SRE operations (Tier 3c) | Queue health, webhook errors, stuck sessions, tool loops, context pressure |
| `genai-observability` | Industry-standard gen_ai | OpenTelemetry gen_ai metrics: token analytics, LLM performance, traces |
| `security-overview` | Security monitoring | Webhook errors, injection signals, session anomalies, cost spikes |

### Infrastructure & Generic

| Template | Purpose | Key Panels |
|----------|---------|------------|
| `node-exporter` | System health | CPU, memory, disk, network (Prometheus node-exporter metrics) |
| `http-service` | Web service monitoring | HTTP request rate, error rate, latency (RED signals) |
| `metric-explorer` | Single metric deep-dive | Interactive exploration of any metric from a dropdown |
| `multi-kpi` | KPI overview | 4-metric side-by-side comparison |
| `weekly-review` | Weekly trends | 2-metric trends with external data table |

All AI templates use **Grafana template variables** for dropdown selectors (`$prometheus`, `$loki`, `$tempo`, `$model`, `$provider`, etc.) and **stable UIDs** for cross-dashboard drill-down navigation.

---

## Security Monitoring

Prompt injection is the [#1 risk in OWASP's Top 10 for LLM Applications](https://genai.owasp.org/llmrisk/llm01-prompt-injection/). Grafana Lens provides detection-only security monitoring — it observes and reports, but never blocks or terminates operations.

### Security Check (`grafana_security_check`)

Runs 6 PromQL queries in parallel using `Promise.allSettled` (a single failing check won't break the others):

| Check | What It Detects | Green | Yellow | Red |
|-------|----------------|-------|--------|-----|
| `webhook_error_ratio` | Failing webhook deliveries | < 20% | 20–50% | ≥ 50% |
| `cost_anomaly` | Unusual daily spending | < $10 | $10–$50 | ≥ $50 |
| `tool_loops` | Agent stuck in repetitive tool calls | 0 | 1–2 | ≥ 3 |
| `injection_signals` | Prompt injection patterns detected | 0 | 1–4 | ≥ 5 |
| `session_enumeration` | Unusual session volume (brute-force) | < 50/hr | 50–200/hr | ≥ 200/hr |
| `stuck_sessions` | Sessions not progressing | 0 | 1–2 | ≥ 3 |

Returns an overall threat level (`green`, `yellow`, or `red`) with suggested investigation actions for each finding.

**Honest limitations:** Authentication failures are invisible to this tool — OpenClaw's auth middleware emits no diagnostic events for failed auth attempts. Monitor gateway access logs separately.

### Security Dashboard

Use the `security-overview` template for a persistent visual dashboard with 15 panels covering all security signals.

### What's Being Monitored

Grafana Lens automatically collects security-relevant metrics from OpenClaw's lifecycle:

- **Prompt injection detection** — 12 regex patterns scanning LLM inputs (configurable via `otlp.captureContent`)
- **Tool error classification** — Categorizes tool failures as network, filesystem, timeout, or other
- **Session anomalies** — Unique session sliding window (1-hour) detects enumeration attempts
- **Gateway restarts** — Tracks infrastructure availability
- **Session resets** — Monitors forced context wipes

---

## SRE Investigation

Grafana Lens includes purpose-built investigation capabilities for diagnosing alerts, anomalies, and outages.

### Multi-Signal Triage (`grafana_investigate`)

Use as the **first step** for any "what's wrong?" question. The tool:

1. **Auto-discovers** Prometheus, Loki, and Tempo datasources (graceful degradation if Loki/Tempo unavailable)
2. **Gathers signals in parallel** using `Promise.allSettled`:
   - **Metrics** — Focus metric current value + trend, anomaly z-score, RED signals (rate, error rate, p95 latency)
   - **Logs** — Volume, severity breakdown, top error patterns, sample errors
   - **Traces** — Error traces, slow traces (>10s)
   - **Context** — Recent annotations, active alerts
3. **Generates hypotheses** — Each includes an `evidence` summary, `confidence` level, and a `testWith` field with the exact tool name and parameters for follow-up

### Anomaly Scoring (`grafana_explain_metric`)

For 24-hour period queries on plain metric names, `grafana_explain_metric` now includes:

- **Anomaly z-score** — Current value compared against the 7-day baseline (avg ± stddev). Severity levels: `normal` (<1.5σ), `mild` (1.5–2σ), `significant` (2–3σ), `critical` (>3σ)
- **Seasonality comparison** — Value vs 1 day ago and vs 7 days ago, with change percentages

### Alert Fatigue Detection (`grafana_check_alerts`)

Use `action: "analyze"` to audit alert rule health:

- **Always-firing** — Rules firing >24 hours, suggesting thresholds need adjustment
- **Flapping** — Rules in error/nodata state, indicating query or datasource issues
- **Overall health** — `healthy`, `moderate_fatigue`, or `severe_fatigue` with specific suggestions

---

## Custom Metrics (Data Observatory)

Push any external data into Grafana via the `grafana_push_metrics` tool — no code required, just ask your agent:

> "Track my daily steps in Grafana"
> "Push my git commit count for today"
> "Record my morning weight"

### How It Works

1. **Register** a metric (or let auto-registration handle it):
   - Metric names are auto-prefixed with `openclaw_ext_` if not already
   - Types: `counter` (ever-increasing) or `gauge` (current value)

2. **Push** values with optional labels and timestamps:
   - Data is pushed immediately via OTLP — no scraping delay
   - Historical data supported via the `timestamp` parameter

3. **Visualize** — create a dashboard or query the metric directly

### Naming Rules

- All custom metrics use the `openclaw_ext_` prefix
- Counter metrics get a `_total` suffix in Prometheus (e.g., `openclaw_ext_steps` → `openclaw_ext_steps_total`)
- Label names follow Prometheus conventions (letters, digits, underscores only)

### Cardinality Limits

| Limit | Default | Purpose |
|-------|---------|---------|
| Max metrics | 100 | Prevents unbounded metric growth |
| Max labels per metric | 5 | Limits label key cardinality |
| Max label values per metric | 50 | Limits unique label combinations |

Definitions persist across restarts in `${stateDir}/custom-metrics.json`.

---

## Architecture

Grafana Lens is a **self-contained OpenClaw plugin** — all Grafana interaction is handled by the bundled `GrafanaClient`. No external MCP servers, no additional infrastructure beyond the LGTM stack.

```
┌─────────────────────────────────────────────────┐
│  OpenClaw Agent                                 │
│  (processes messages, invokes tools)            │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │  Grafana Lens Plugin                    │    │
│  │  • 17 Agent Tools                       │    │
│  │  • MetricsCollector Service             │    │
│  │  • AlertWebhook Service                 │    │
│  │  • LifecycleTelemetry (16 hooks)        │    │
│  │  • Bundled GrafanaClient (REST API)     │    │
│  └────────────┬────────────────────────────┘    │
│               │                                 │
└───────────────┼─────────────────────────────────┘
                │
    ┌───────────┴───────────┐
    │ OTLP HTTP Push (:4318)│
    │  /v1/metrics          │
    │  /v1/logs             │
    │  /v1/traces           │
    └───────────┬───────────┘
                │
┌───────────────┴─────────────────────────────────┐
│  LGTM Stack (grafana/otel-lgtm)                 │
│  ┌──────────────┐  ┌──────┐  ┌───────┐         │
│  │ Prometheus   │  │ Loki │  │ Tempo │         │
│  │ (:9090)      │  │      │  │       │         │
│  │ Metrics      │  │ Logs │  │Traces │         │
│  └──────┬───────┘  └──┬───┘  └──┬────┘         │
│         └──────────────┼────────┬┘              │
│                   ┌────┴────────┴───┐           │
│                   │   Grafana       │           │
│                   │   (:3000)       │           │
│                   │   Dashboards    │           │
│                   └─────────────────┘           │
└─────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Everything is tools | 17 composable tools, no background automation | Agent decides when to act; Grafana handles scheduled work |
| Self-contained | Bundled GrafanaClient (REST API) | No external MCP servers or dependencies |
| OTLP push | Push-based metrics, logs, traces | No scraping delay — data available immediately |
| General-purpose | Works with ANY Grafana datasource | Not limited to `openclaw_lens_*` metrics |
| Alert provenance | `X-Disable-Provenance` header | Agent-created alert rules remain editable in Grafana UI |
| Panel rendering | Grafana Image Renderer plugin | Persistent dashboards + three-tier fallback (PNG → snapshot → deep link) |
| Secret redaction | Auto-strips API keys before OTLP export | Prevents token leakage into observability pipelines |

### Relationship with diagnostics-otel

OpenClaw ships a built-in [`diagnostics-otel`](https://github.com/nicepkg/openclaw) extension that converts diagnostic events into basic counters and histograms (token usage, cost, webhook durations, message processing). Grafana Lens does **not** replace it — they run side by side and complement each other:

| Capability | diagnostics-otel | Grafana Lens |
|-----------|-----------------|-------------|
| Token/cost counters | Yes | Replicated (self-sufficient templates) |
| Session-scoped traces (gen_ai conventions) | No | Yes — hierarchical `invoke_agent → chat → execute_tool` |
| Structured logs → Loki | No | Yes — diagnostic events, LLM I/O, app logs |
| Log-to-trace correlation | No | Yes — `trace_id` in log records for Loki → Tempo click-through |
| Security monitoring | No | Yes — prompt injection, tool error classification, cost anomalies |
| Operational gauges | No | Yes — active sessions, queue depth, context pressure, stuck sessions |
| Secret redaction | No | Yes — auto-strips tokens before OTLP export |
| Content capture controls | No | Yes — configurable prompt/completion logging with truncation |

**Why not just use diagnostics-otel?** It only subscribes to diagnostic events and emits counters — it has no lifecycle hooks, no tracing, no log forwarding, and no security signals. Grafana Lens registers 16 lifecycle hooks (`session_start`, `llm_input`, `after_tool_call`, etc.) to build session-scoped traces and rich log records that diagnostics-otel was never designed to provide.

**Why not extend diagnostics-otel?** It uses `NodeSDK` with global OTel providers (`setGlobalMeterProvider()`). Grafana Lens uses local `MeterProvider`, `LoggerProvider`, and `BasicTracerProvider` instances to avoid conflicts — both extensions coexist safely.

---

## Observability Deep Dive

### Three Pillars — OTLP Push

All telemetry is pushed via OTLP HTTP to the collector (default `localhost:4318`). No Prometheus scraping, no `/metrics` endpoint.

| Signal | Destination | Content |
|--------|-------------|---------|
| **Metrics** | Prometheus (via OTel Collector) | Agent gauges, counters, histograms — token usage, cost, session state, security signals |
| **Logs** | Loki | Diagnostic events, app logs, LLM inputs/outputs (with redaction), security events |
| **Traces** | Tempo | Session-scoped hierarchical traces following gen_ai semantic conventions |

### Trace Hierarchy

Each agent session produces a trace tree:

```
invoke_agent openclaw          (root span)
├── chat claude-3-opus         (LLM call)
├── execute_tool grafana_query (tool execution)
├── chat claude-3-opus         (next LLM turn)
├── execute_tool grafana_create_dashboard
├── openclaw.compaction        (context compression)
└── openclaw.agent.end         (session close)
```

Span names follow the [OpenTelemetry gen_ai semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/): `{operation} {model/provider}`.

### Log-to-Trace Correlation

Span-producing events include a `trace_id` attribute in their log records. In Grafana, this enables click-through from Loki logs directly to the corresponding Tempo trace — useful for debugging specific LLM calls or tool failures.

### Distributed Trace Queries

The `grafana_query_traces` tool queries Tempo directly using TraceQL:

- **Search by attributes** — `{ span.service.name = "openclaw" && duration > 5s }` finds slow spans
- **Search by status** — `{ status = error }` finds failed operations
- **Get trace by ID** — Retrieves the full span tree for a specific trace, with hierarchical parent-child relationships
- **Log-to-trace click-through** — Span-producing events include `trace_id` in Loki log records, enabling one-click navigation from a log line to the full Tempo trace in Grafana

The tool handles both OTLP JSON and Tempo's protobuf-JSON response formats (base64-encoded IDs, string enum kinds/status codes) transparently.

### Secret Redaction

When `otlp.redactSecrets` is enabled (default: `true`), all telemetry data is automatically scanned for sensitive tokens before OTLP export:

- GitHub tokens (`ghp_*`, `github_pat_*`)
- Slack tokens (`xoxb-*`, `xoxp-*`)
- API keys (`sk-*`, `sk-ant-*`, `AIza*`)
- Grafana tokens (`glsa_*`)
- Bearer tokens, PEM private keys, and more

Tokens are redacted to `${first6}...${last4}` format (e.g., `glsa_Ab...x9Zq`).

### Lifecycle Hooks

Grafana Lens registers 16 lifecycle hooks into OpenClaw for deep observability:

`session_start`, `session_end`, `llm_input`, `llm_output`, `agent_end`, `message_received`, `message_sent`, `before_compaction`, `after_compaction`, `subagent_spawned`, `subagent_ended`, `before_tool_call`, `after_tool_call`, `before_reset`, `gateway_start`, `gateway_stop`

These hooks power the session-scoped traces, gen_ai standard metrics, security signals, and SRE operational data.

### Content Capture Controls

For privacy-sensitive deployments, configure what's included in telemetry:

```jsonc
{
  "otlp": {
    "captureContent": false,    // disable prompt/completion logging
    "redactSecrets": true,      // auto-strip tokens (default: true)
    "contentMaxLength": 500,    // truncate content fields
    "forwardAppLogs": false     // disable app log forwarding to Loki
  }
}
```

---

## Configuration Reference

### All Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `grafana.url` | string | — | Grafana instance URL (required) |
| `grafana.apiKey` | string | — | Service account token (required) |
| `grafana.orgId` | number | `1` | Organization ID |
| `metrics.enabled` | boolean | `true` | Enable OTLP telemetry collection |
| `otlp.endpoint` | string | `http://localhost:4318/v1/metrics` | OTLP collector endpoint |
| `otlp.headers` | object | `{}` | Custom HTTP headers for OTLP export |
| `otlp.exportIntervalMs` | number | `15000` | Metric export interval (ms) |
| `otlp.logs` | boolean | `true` | Push logs to Loki via OTLP |
| `otlp.traces` | boolean | `true` | Push traces to Tempo via OTLP |
| `otlp.captureContent` | boolean | `true` | Include prompts/completions in telemetry |
| `otlp.contentMaxLength` | number | `2000` | Max chars for content fields |
| `otlp.forwardAppLogs` | boolean | `true` | Forward OpenClaw app logs to Loki |
| `otlp.appLogMinSeverity` | string | `"debug"` | Min log severity (trace/debug/info/warn/error/fatal) |
| `otlp.redactSecrets` | boolean | `true` | Auto-redact API keys/tokens before OTLP export |
| `proactive.enabled` | boolean | `false` | Enable Grafana alert webhook handler |
| `proactive.webhookPath` | string | `"/grafana-lens/alerts"` | HTTP path for alert webhooks |
| `proactive.costAlertThreshold` | number | `5.0` | Daily cost alert threshold (USD) |
| `customMetrics.enabled` | boolean | `true` | Allow custom metric push |
| `customMetrics.maxMetrics` | number | `100` | Max custom metric definitions |
| `customMetrics.maxLabelsPerMetric` | number | `5` | Max label keys per metric |
| `customMetrics.maxLabelValues` | number | `50` | Max unique label combos per metric |
| `customMetrics.defaultTtlDays` | number | `null` | Optional auto-expiry (days) |

---

## Development

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# TypeScript type-check (no emit)
npm run typecheck

# Link into OpenClaw for local development
openclaw plugins install -l ~/workspace/grafana-lens

# Restart gateway after changes
openclaw gateway restart
```

### Project Structure

```
grafana-lens/
├── index.ts                          # Plugin entry point
├── package.json                      # Package metadata
├── openclaw.plugin.json              # Plugin manifest with config schema
├── src/
│   ├── config.ts                     # Config parsing and validation
│   ├── grafana-client.ts             # Bundled Grafana REST API client
│   ├── metric-definitions.ts         # Shared metric registry
│   ├── tools/                        # 17 agent tools
│   │   ├── query.ts                  # grafana_query
│   │   ├── query-logs.ts             # grafana_query_logs
│   │   ├── create-dashboard.ts       # grafana_create_dashboard
│   │   ├── update-dashboard.ts       # grafana_update_dashboard
│   │   ├── get-dashboard.ts          # grafana_get_dashboard
│   │   ├── search.ts                 # grafana_search
│   │   ├── share-dashboard.ts        # grafana_share_dashboard
│   │   ├── create-alert.ts           # grafana_create_alert
│   │   ├── check-alerts.ts           # grafana_check_alerts
│   │   ├── annotate.ts               # grafana_annotate
│   │   ├── explore-datasources.ts    # grafana_explore_datasources
│   │   ├── list-metrics.ts           # grafana_list_metrics
│   │   ├── push-metrics.ts           # grafana_push_metrics
│   │   ├── explain-metric.ts         # grafana_explain_metric
│   │   ├── security-check.ts         # grafana_security_check
│   │   ├── query-traces.ts           # grafana_query_traces
│   │   └── investigate.ts            # grafana_investigate
│   ├── services/
│   │   ├── metrics-collector.ts      # Diagnostic event → OTLP push
│   │   ├── alert-webhook.ts          # Grafana alert webhook handler
│   │   ├── otel-metrics.ts           # MeterProvider (local, no global)
│   │   ├── otel-logs.ts              # LoggerProvider
│   │   ├── otel-traces.ts            # TracerProvider
│   │   ├── lifecycle-telemetry.ts    # Session-scoped gen_ai traces + metrics
│   │   ├── custom-metrics-store.ts   # Custom metric definitions + state
│   │   └── redact.ts                 # Secret redaction utility
│   └── templates/                    # 12 dashboard JSON templates
│       ├── llm-command-center.json
│       ├── session-explorer.json
│       ├── cost-intelligence.json
│       ├── tool-performance.json
│       ├── sre-operations.json
│       ├── genai-observability.json
│       ├── security-overview.json
│       ├── node-exporter.json
│       ├── http-service.json
│       ├── metric-explorer.json
│       ├── multi-kpi.json
│       └── weekly-review.json
└── skills/
    └── SKILL.md                      # Agent skill file
```

---

## License

MIT

---

> **Disclaimer:** Grafana Lens is a community-built OpenClaw plugin. It is not developed, maintained, or endorsed by Grafana Labs. Grafana, Prometheus, Loki, Tempo, and Mimir are trademarks of Grafana Labs.
