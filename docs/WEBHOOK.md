# Incoming Webhook

Receive HTTP POST requests from external systems to trigger the agent. Useful for local automation such as cron jobs, shell scripts, and service-to-service notifications.

## Setup

1. Add to `.env`:

```
WEBHOOK_ENABLED=true
```

2. Restart NanoClaw.

The webhook server starts on port **8587** by default, bound to `127.0.0.1` (localhost only).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_ENABLED` | `false` | Set to `true` to enable the webhook server |
| `WEBHOOK_PORT` | `8587` | Port number for the webhook server |

Both can be set via `.env` or as environment variables.

## Endpoint

### `POST /hooks/wake`

Send a JSON payload to trigger the agent with a message.

**Request:**

```
POST http://127.0.0.1:8587/hooks/wake
Content-Type: application/json

{"text": "your message here"}
```

**Response codes:**

| Status | Meaning |
|--------|---------|
| 200 | Message accepted — `{"ok": true}` |
| 400 | Invalid JSON, or missing/empty `text` field |
| 404 | Unknown endpoint |
| 405 | Method not allowed (only POST is accepted) |
| 413 | Request body exceeds 1 MB limit |
| 503 | No main group configured |

Messages are delivered to the **main group** (`isMain: true`) and processed immediately through the same event-driven path as channel messages.

## Examples

### curl

```bash
curl -X POST http://127.0.0.1:8587/hooks/wake \
  -H 'Content-Type: application/json' \
  -d '{"text": "Run the daily report"}'
```

### cron

```cron
0 9 * * * curl -s -X POST http://127.0.0.1:8587/hooks/wake -H 'Content-Type: application/json' -d '{"text": "Good morning. Check today'\''s schedule."}'
```

### Shell script

```bash
#!/bin/bash
MESSAGE="Deploy completed: $(git rev-parse --short HEAD)"
curl -s -X POST http://127.0.0.1:8587/hooks/wake \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"$MESSAGE\"}"
```

## Security

- The server binds to **127.0.0.1 only** — it is not accessible from the network.
- Request body is limited to **1 MB**.
- No authentication is required since the endpoint is localhost-only.

## Troubleshooting

**Port conflict:** If the configured port is already in use, NanoClaw logs a warning and continues running without webhook support. Change `WEBHOOK_PORT` to an available port and restart.

**503 — No main group configured:** The webhook requires at least one group with `isMain: true`. Register a main group before enabling the webhook.
