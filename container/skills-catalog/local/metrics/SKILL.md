---
name: metrics
description: Log structured metrics events for agent observability. Use to record tool calls, skill activations, message processing, and errors to /home/node/work/metrics.jsonl for Grafana/Prometheus monitoring.
---

# Metrics Logging

Log structured events to `/home/node/work/metrics.jsonl` (newline-delimited JSON) for agent observability via Grafana/Loki.

## Setup

Ensure the metrics file directory exists:

```bash
mkdir -p /home/node/work
touch /home/node/work/metrics.jsonl
```

## Logging Events

Use `echo` with `$(date +%s)` for the timestamp. Always append (`>>`) — never overwrite.

### Message processed

```bash
echo '{"ts":'$(date +%s)',"event":"message_processed","group":"'"$GROUP"'","tokens_in":'"$TOKENS_IN"',"tokens_out":'"$TOKENS_OUT"',"duration_ms":'"$DURATION_MS"'}' >> /home/node/work/metrics.jsonl
```

### Tool call

```bash
echo '{"ts":'$(date +%s)',"event":"tool_call","tool":"'"$TOOL"'","skill":"'"$SKILL"'","group":"'"$GROUP"'","duration_ms":'"$DURATION_MS"'}' >> /home/node/work/metrics.jsonl
```

### Skill activated

```bash
echo '{"ts":'$(date +%s)',"event":"skill_activated","skill":"'"$SKILL"'","group":"'"$GROUP"'"}' >> /home/node/work/metrics.jsonl
```

### Scheduled task run

```bash
echo '{"ts":'$(date +%s)',"event":"scheduled_task_run","task_id":"'"$TASK_ID"'","status":"'"$STATUS"'","duration_ms":'"$DURATION_MS"'}' >> /home/node/work/metrics.jsonl
```

### File sent

```bash
echo '{"ts":'$(date +%s)',"event":"file_sent","file_type":"'"$FILE_TYPE"'","group":"'"$GROUP"'"}' >> /home/node/work/metrics.jsonl
```

### Error

```bash
echo '{"ts":'$(date +%s)',"event":"error","type":"'"$ERROR_TYPE"'","tool":"'"$TOOL"'","message":"'"$MESSAGE"'"}' >> /home/node/work/metrics.jsonl
```

## Event Schema

| Field | Type | Description |
|-------|------|-------------|
| `ts` | integer | Unix timestamp (seconds) |
| `event` | string | Event type (see below) |
| `group` | string | Group/channel identifier (e.g. `discord_general`) |
| `tool` | string | Tool name (e.g. `Bash`, `Read`, `Write`) |
| `skill` | string | Skill name (e.g. `openscad`, `chart`) |
| `tokens_in` | integer | Input tokens consumed |
| `tokens_out` | integer | Output tokens generated |
| `duration_ms` | integer | Operation duration in milliseconds |
| `task_id` | string | Scheduled task identifier |
| `status` | string | `success` or `failure` |
| `file_type` | string | File extension without dot (e.g. `png`, `zip`) |
| `type` | string | Error category (e.g. `tool_failure`, `api_error`) |
| `message` | string | Human-readable error description |

## Event Types

- `message_processed` — A user message was received and responded to
- `tool_call` — A tool was invoked (Bash, Read, Write, etc.)
- `skill_activated` — A skill was loaded and used
- `scheduled_task_run` — A scheduled/cron task executed
- `file_sent` — A file was sent to chat via `mcp__nanoclaw__send_files`
- `error` — An error or failure occurred

## Integration with Grafana

The `metrics.jsonl` file can be shipped to Loki using Promtail. Grafana dashboards
are provided in `docs/grafana-dashboards/`. See the README there for setup instructions.

## When to Log

Log these events automatically during your work:

1. **Start of message processing** — log `message_processed` after responding, including token estimates if known
2. **Each tool call** — log `tool_call` with tool name, active skill, and approximate duration
3. **Skill activation** — log `skill_activated` when a skill's instructions are first used in a session
4. **File sends** — log `file_sent` whenever `mcp__nanoclaw__send_files` is called
5. **Errors** — log `error` whenever a tool fails, an API error occurs, or something goes wrong
6. **Scheduled tasks** — log `scheduled_task_run` at the end of each scheduled task execution
