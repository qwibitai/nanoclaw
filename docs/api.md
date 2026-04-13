# Direct Message API

Programmatic HTTP interface to NanoClaw. Send messages and receive agent responses without a chat platform.

## Setup

Set `NANOCLAW_API_TOKEN` in your `.env` file to enable:

```bash
NANOCLAW_API_TOKEN=your-secret-token
NANOCLAW_API_PORT=3200        # default
NANOCLAW_API_TIMEOUT=120000   # 2 minutes, in ms
```

The API channel is disabled when `NANOCLAW_API_TOKEN` is empty.

## Endpoints

### Health Check

```bash
curl http://localhost:3200/api/v1/health
```

Response:
```json
{
  "status": "ok",
  "bot": "Andy",
  "registeredGroups": 3,
  "pendingRequests": 0,
  "uptime": 1234.56
}
```

No authentication required.

### Send Message (Synchronous)

```bash
curl -X POST http://localhost:3200/api/v1/message \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "group": "main",
    "sender": "api-user",
    "sender_name": "API User",
    "content": "What tasks are scheduled?"
  }'
```

Response:
```json
{
  "response": "You have 2 tasks scheduled...",
  "elapsed_ms": 4523
}
```

The request blocks until the agent responds or the timeout is reached.

### Send Message (SSE Streaming)

```bash
curl -N -X POST http://localhost:3200/api/v1/message \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "group": "main",
    "sender": "api-user",
    "sender_name": "API User",
    "content": "Write a summary",
    "stream": true
  }'
```

Response (Server-Sent Events):
```
event: message
data: {"content":"Here is the summary..."}

event: message
data: {"content":"Additional details..."}
```

## Request Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `group` | string | yes | Group folder name (e.g., `main`, `dev-ops`) |
| `sender` | string | yes | Sender identifier |
| `sender_name` | string | yes | Display name for the sender |
| `content` | string | yes | Message content (trigger prefix is added automatically) |
| `stream` | boolean | no | Enable SSE streaming (default: false) |

## Error Codes

| Status | Meaning |
|--------|---------|
| 400 | Invalid JSON or missing required fields |
| 401 | Missing or invalid `Authorization: Bearer` token |
| 404 | Group folder not found in registered groups |
| 408 | Agent did not respond within the timeout |
| 409 | Another request is already in progress for this group |
| 503 | Server is shutting down |

## Notes

- The trigger prefix (`@BotName`) is prepended automatically to the content.
- Only one request per group can be in progress at a time.
- The API channel intercepts the agent's response before it reaches the group's normal channel (Telegram, Slack, etc.).
- Reachable from Tailscale/LAN since the server binds to `0.0.0.0`.
