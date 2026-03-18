# NanoClaw Grafana Dashboards

Grafana dashboard templates for monitoring the NanoClaw AI agent. Three dashboards are provided:

| File | UID | Description |
|------|-----|-------------|
| `agent-overview.json` | `nanoclaw-overview` | Messages, tools, skills, errors |
| `token-usage.json` | `nanoclaw-tokens` | Claude API token consumption and cost estimates |
| `scheduled-tasks.json` | `nanoclaw-tasks` | Scheduled task health and execution history |

---

## Prerequisites

- Grafana 10.x or later
- A **Loki** datasource configured in Grafana
- Log lines from `metrics.jsonl` shipped into Loki with the label `job="nanoclaw"`

---

## Importing the Dashboards

1. Open Grafana in your browser.
2. Go to **Dashboards → Import** (or click the `+` icon → Import).
3. Click **Upload JSON file** and select one of the `.json` files from this directory.
4. In the **Loki** datasource dropdown, choose your Loki instance.
5. Click **Import**.

Repeat for each of the three dashboard files.

---

## Required Data Source: Loki

The dashboards use a single Loki datasource. Configure it in Grafana under **Configuration → Data sources → Add data source → Loki**.

All queries filter on the label `{job="nanoclaw"}`. Make sure your log shipper sets this label (see Promtail config below).

---

## Shipping Logs from metrics.jsonl to Loki

### Option A — Promtail (recommended)

Add a job to your Promtail config that tails the metrics file:

```yaml
# promtail-config.yaml (add to the scrape_configs section)
scrape_configs:
  - job_name: nanoclaw
    static_configs:
      - targets:
          - localhost
        labels:
          job: nanoclaw
          host: nanoclaw-agent
          __path__: /home/node/work/metrics.jsonl
    pipeline_stages:
      - json:
          expressions:
            event: event
            group: group
            skill: skill
            tool: tool
      - labels:
          event:
          group:
          skill:
          tool:
```

Start Promtail pointing at your Loki instance:

```bash
promtail \
  --config.file=promtail-config.yaml \
  --client.url=http://loki:3100/loki/api/v1/push
```

### Option B — Docker Compose with Loki log driver

If NanoClaw runs in Docker, you can configure the Loki log driver to collect container logs directly. However, the structured metrics in `metrics.jsonl` still need to be tailed via Promtail or a sidecar.

### Option C — Vector

```toml
# vector.toml
[sources.nanoclaw_metrics]
type = "file"
include = ["/home/node/work/metrics.jsonl"]

[sinks.loki]
type = "loki"
inputs = ["nanoclaw_metrics"]
endpoint = "http://loki:3100"
encoding.codec = "raw_message"
labels.job = "nanoclaw"
```

---

## Metrics Event Schema

The agent writes newline-delimited JSON to `/home/node/work/metrics.jsonl`. Each line is one event.

### Common fields

| Field | Type | Description |
|-------|------|-------------|
| `ts` | integer | Unix timestamp (seconds since epoch) |
| `event` | string | Event type (see below) |
| `group` | string | Group/channel identifier, e.g. `discord_general` |

### Event types and their fields

#### `message_processed`
Logged when the agent finishes responding to a user message.

```json
{"ts": 1710000000, "event": "message_processed", "group": "discord_general", "tokens_in": 1200, "tokens_out": 340, "duration_ms": 2100}
```

| Field | Type | Description |
|-------|------|-------------|
| `tokens_in` | integer | Approximate input tokens sent to Claude |
| `tokens_out` | integer | Approximate output tokens received from Claude |
| `duration_ms` | integer | Total response time in milliseconds |

#### `tool_call`
Logged each time a tool is invoked.

```json
{"ts": 1710000001, "event": "tool_call", "tool": "Bash", "skill": "openscad", "group": "discord_general", "duration_ms": 450}
```

| Field | Type | Description |
|-------|------|-------------|
| `tool` | string | Tool name, e.g. `Bash`, `Read`, `Write`, `agent-browser` |
| `skill` | string | Active skill at the time of the call (empty string if none) |
| `duration_ms` | integer | Tool execution time in milliseconds |

#### `skill_activated`
Logged when a skill's instructions are loaded for a session.

```json
{"ts": 1710000002, "event": "skill_activated", "skill": "openscad", "group": "discord_general"}
```

| Field | Type | Description |
|-------|------|-------------|
| `skill` | string | Skill name, e.g. `openscad`, `chart`, `agent-browser` |

#### `scheduled_task_run`
Logged at the end of each scheduled or cron task execution.

```json
{"ts": 1710000003, "event": "scheduled_task_run", "task_id": "abc123", "status": "success", "duration_ms": 800}
```

| Field | Type | Description |
|-------|------|-------------|
| `task_id` | string | Task identifier from the scheduler |
| `status` | string | `success` or `failure` |
| `duration_ms` | integer | Task execution time in milliseconds |

#### `file_sent`
Logged whenever a file is sent to chat via `mcp__nanoclaw__send_files`.

```json
{"ts": 1710000004, "event": "file_sent", "file_type": "png", "group": "discord_general"}
```

| Field | Type | Description |
|-------|------|-------------|
| `file_type` | string | File extension without dot, e.g. `png`, `zip` |

#### `error`
Logged when a tool fails, an API error occurs, or something unexpected happens.

```json
{"ts": 1710000005, "event": "error", "type": "tool_failure", "tool": "Bash", "message": "permission denied"}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Error category, e.g. `tool_failure`, `api_error`, `skill_error` |
| `tool` | string | Tool involved (if applicable) |
| `message` | string | Human-readable error description |

---

## Dashboard Details

### Agent Overview (`nanoclaw-overview`)

Default time range: last 24 hours. Refreshes every minute.

Panels:
- **Messages Processed (24h)** — stat, count of `message_processed` events
- **Active Skills Today** — stat, count of `skill_activated` events
- **Files Sent Today** — stat, count of `file_sent` events
- **Error Rate (24h)** — stat, errors / total events as a percentage
- **Messages Per Hour (7d)** — time series
- **Tool Calls Per Hour (7d)** — time series
- **Top Tools Used (24h)** — bar chart grouped by `tool` label
- **Top Skills Activated (24h)** — bar chart grouped by `skill` label
- **Recent Errors** — table of the last 10 `error` events

### Token Usage & Cost (`nanoclaw-tokens`)

Default time range: last 7 days. Refreshes every 5 minutes.

Pricing model: `claude-sonnet-4-6` at $3/1M input tokens, $15/1M output tokens.

Panels:
- **Total Tokens Today** — sum of `tokens_in + tokens_out` (24h)
- **Estimated Cost Today** — USD cost estimate (24h)
- **Input Tokens Today** — stat
- **Output Tokens Today** — stat
- **Token Usage Over Time** — stacked time series (input vs output per hour)
- **Estimated Daily Cost Trend** — time series (rolling 1-day window)
- **Token Usage by Group** — bar chart broken down by `group` label

### Scheduled Tasks (`nanoclaw-tasks`)

Default time range: last 7 days. Refreshes every minute.

Panels:
- **Tasks Succeeded Today** — stat
- **Tasks Failed Today** — stat (red threshold at 1+)
- **Task Success Rate (24h)** — gauge (green >95%, yellow >80%, red otherwise)
- **Task Execution Rate Over Time** — time series (success vs failure per hour)
- **Task Duration Over Time** — time series (avg ms per hour)
- **Task Run History** — table with task_id, status, duration, timestamp
