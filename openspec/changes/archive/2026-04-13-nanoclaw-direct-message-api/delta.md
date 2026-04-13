# Delta: NanoClaw Direct Message API

## Summary

Add a new `api` channel to NanoClaw that exposes an HTTP API for sending messages to any registered group and receiving responses synchronously. Implements as a standard channel via the existing registry pattern, requiring zero changes to the core message loop or router.

---

## New: `src/channels/api.ts`

HTTP server implementing the `Channel` interface. Self-registers via `registerChannel('api', createApiChannel)`.

### Endpoints

#### `POST /api/v1/message`

Send a message to the bot and receive the response.

**Headers:**
```
Authorization: Bearer <NANOCLAW_API_TOKEN>
Content-Type: application/json
```

**Request body:**
```json
{
  "group": "control",
  "sender": "claude-code",
  "sender_name": "Claude Code",
  "content": "What's your status?",
  "stream": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `group` | string | Yes | Group folder name (must be a registered group) |
| `sender` | string | Yes | Sender identifier (e.g. `claude-code`, `nook`) |
| `sender_name` | string | Yes | Human-readable sender name |
| `content` | string | Yes | Message text |
| `stream` | boolean | No | If true, response is SSE stream. Default: false |

**Response (stream=false):**
```json
{
  "request_id": "req_abc123",
  "response": "I'm operational. All systems green.",
  "duration_ms": 4200
}
```

**Response (stream=true):**
SSE stream:
```
event: chunk
data: {"text": "I'm operational."}

event: chunk
data: {"text": " All systems green."}

event: done
data: {"request_id": "req_abc123", "duration_ms": 4200}
```

**Error responses:**
- `401` — Missing or invalid bearer token
- `400` — Invalid request body (missing fields, unknown group)
- `404` — Group not registered
- `408` — Request timeout (default 120s)
- `503` — Server shutting down

#### `GET /api/v1/health`

Health check endpoint. No auth required.

```json
{
  "status": "ok",
  "bot_name": "X",
  "active_containers": 2,
  "registered_groups": 3,
  "connected_channels": ["telegram", "api"],
  "uptime_s": 86400
}
```

### Synthetic JID Routing

- Each API request generates a unique JID: `api:{requestId}` (e.g. `api:req_abc123`)
- `ownsJid(jid)` returns true for any JID starting with `api:`
- `sendMessage(jid, text)` resolves the pending HTTP response (or pushes an SSE chunk) for the matching request ID
- The pending response map is keyed by request ID with a timeout that auto-cleans entries

### Message Flow

1. HTTP request arrives at `/api/v1/message`
2. API channel validates auth, parses body, looks up group by folder name
3. Creates a `NewMessage` with `chat_jid = api:{requestId}` and calls `onMessage()`
4. Also calls `onChatMetadata()` with `channel = 'api'` and `isGroup = false`
5. The existing message loop picks up the message, routes it through `processGroupMessages()`
6. When the container produces output, `routeOutbound()` calls `channel.sendMessage('api:{requestId}', text)`
7. The API channel resolves the HTTP response with the text

**Important design note:** The API channel reuses the group's `chat_jid` for routing through the message loop (so the message gets processed by the correct group's container), but uses the synthetic `api:{requestId}` JID internally for response resolution. This means:
- `onMessage()` is called with the **group's actual chat_jid** so the message enters the correct processing pipeline
- A pending response map keyed by `{groupJid}:{requestId}` allows the channel to intercept outbound messages and resolve the HTTP response
- The `sendMessage()` override checks pending API requests before sending to any external platform

### Timeout Handling

- Default timeout: 120 seconds (env: `NANOCLAW_API_TIMEOUT`, much shorter than container timeout of 30 minutes)
- On timeout: respond with `408` and clean up the pending response entry
- The container continues running (it may still be useful for subsequent requests)

### Shutdown

- On SIGTERM/SIGINT: stop accepting new requests (503), wait for in-flight requests to complete (up to 5s grace), then close the HTTP server

---

## Modified: `src/channels/registry.ts`

No code changes needed. The API channel self-registers on import, same as Telegram/Slack.

## Modified: `src/channels/index.ts`

Add import line:
```typescript
// api (direct message)
import './api.js';
```

## Modified: `src/config.ts`

Add to `readEnvFile()` keys: `NANOCLAW_API_TOKEN`, `NANOCLAW_API_PORT`, `NANOCLAW_API_TIMEOUT`.

Add exports:
```typescript
export const API_PORT = parseInt(process.env.NANOCLAW_API_PORT || '3200', 10);
export const API_TIMEOUT = parseInt(process.env.NANOCLAW_API_TIMEOUT || '120000', 10);
export const API_TOKEN = process.env.NANOCLAW_API_TOKEN || '';
```

Note: `API_TOKEN` is a secret but is needed by the API channel at runtime (unlike Anthropic keys which are proxy-only). It is read from `.env` via `readEnvFile()` and exposed only within the host process, never to containers.

## Modified: `.env.example`

Add:
```env
# Direct Message API
NANOCLAW_API_TOKEN=          # Bearer token for API auth (required to enable API channel)
NANOCLAW_API_PORT=3200       # API server port (default: 3200)
NANOCLAW_API_TIMEOUT=120000  # Request timeout in ms (default: 120s)
```

## Modified: `src/index.ts`

Minimal changes:
- The API channel is loaded via the barrel import (`src/channels/index.ts`) like all other channels
- The shutdown handler already iterates `channels` and calls `disconnect()` — the API channel's `disconnect()` closes the HTTP server
- No changes to message loop, queue, or routing logic

---

## Non-Goals

- Message history query API
- Group management API (register/unregister groups via API)
- Tool management API
- Multi-turn session management (each request is independent)
- WebSocket transport (SSE is sufficient for streaming)
- Per-bot token rotation or scoped tokens
- Public internet exposure or rate limiting

## Open Questions

1. **Group routing**: Should the API require the caller to specify a group folder name, or should it also support routing to the "main" group by default when no group is specified?
2. **Response filtering**: Should the response strip `<internal>` tags (like `formatOutbound()` does) or return raw output? Recommendation: strip by default, add `?raw=true` query param for debugging.
3. **Concurrent requests to same group**: The GroupQueue serializes per-group. Multiple API requests to the same group will queue. Is this acceptable, or should the API reject concurrent requests to the same group with 429?
