# Message API

POST endpoint for proactive outbound messaging through NanoClaw channels.

## Endpoint

```
POST /api/v1/messages
```

Default: `http://127.0.0.1:3003/api/v1/messages`

Configure port via `MESSAGE_API_PORT` env var (default: 3003).

## Request

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `recipient` | string | yes | — | Channel JID (e.g. `tg:12345`) |
| `content` | string | yes | — | Message text |
| `template` | string | no | `custom` | One of: `alert`, `digest`, `notification`, `custom` |
| `priority` | string | no | `normal` | One of: `critical`, `high`, `normal`, `low` |
| `scheduled_for` | string | no | — | ISO 8601 timestamp for delayed delivery |
| `batch_key` | string | no | — | Group messages by this key for batched delivery |
| `batch_window` | number | no | `300000` | Batch window in ms (default 5 min) |
| `recipient_type` | string | no | `channel_jid` | Recipient identifier type |

## Response

### 201 Created

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending"
}
```

With `batch_key`:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "batched",
  "batch_key": "daily-digest"
}
```

With `scheduled_for`:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "scheduled_for": "2025-06-01T09:00:00Z"
}
```

### 400 Bad Request

```json
{ "error": "content is required and must be a string" }
```

### 429 Too Many Requests

```json
{ "error": "Rate limit exceeded: max 10 messages per 60s for this recipient" }
```

## Check Message Status

```
GET /api/v1/messages/:id
```

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "recipient_id": "tg:12345",
  "template": "alert",
  "priority": "critical",
  "status": "sent",
  "created_at": "2025-06-01T08:00:00Z",
  "sent_at": "2025-06-01T08:00:01Z",
  "error_message": null,
  "retry_count": 0
}
```

## Examples

### Send a simple message

```bash
curl -X POST http://localhost:3003/api/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"recipient": "tg:12345", "content": "Hello from the API"}'
```

### Send an alert

```bash
curl -X POST http://localhost:3003/api/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "recipient": "tg:12345",
    "content": "CPU usage above 90%",
    "template": "alert",
    "priority": "critical"
  }'
```

### Send a batched digest

```bash
# Multiple messages with same batch_key are aggregated
curl -X POST http://localhost:3003/api/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "recipient": "tg:12345",
    "content": "New commit: fix login bug",
    "template": "digest",
    "batch_key": "daily-commits",
    "batch_window": 300000
  }'

curl -X POST http://localhost:3003/api/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "recipient": "tg:12345",
    "content": "New commit: add user settings",
    "template": "digest",
    "batch_key": "daily-commits"
  }'
```

### Schedule a message

```bash
curl -X POST http://localhost:3003/api/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "recipient": "tg:12345",
    "content": "Time for standup!",
    "template": "notification",
    "scheduled_for": "2025-06-01T09:00:00Z"
  }'
```

### Check delivery status

```bash
curl http://localhost:3003/api/v1/messages/550e8400-e29b-41d4-a716-446655440000
```

## Templates

| Template | Format |
|----------|--------|
| `alert` | `🚨 *Alert*\n\n{content}` |
| `digest` | `📋 *Digest*\n\n{content}` |
| `notification` | `🔔 {content}` |
| `custom` | `{content}` (no formatting) |

## Priority Levels

Messages are processed in priority order:

1. `critical` — sent first
2. `high` — sent after critical
3. `normal` — default
4. `low` — sent last

## Batching

When `batch_key` is provided, messages with the same key are held for `batch_window` ms (default 5 min) and delivered as a single aggregated message. The timer starts when the first message in a batch arrives.

## Rate Limiting

Default: 10 messages per recipient per 60 seconds. Configure via:

- `MESSAGE_RATE_LIMIT_MAX` — max messages per window (default: 10)
- `MESSAGE_RATE_LIMIT_WINDOW_MS` — window size in ms (default: 60000)

## Retry Logic

Failed deliveries are retried up to 3 times with exponential backoff (1s, 2s, 4s). All delivery attempts are logged in the `outbound_messages` SQLite table.

## Database Schema

The `outbound_messages` table in `store/messages.db`:

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `recipient_id` | TEXT | Channel JID |
| `recipient_type` | TEXT | Default: `channel_jid` |
| `template` | TEXT | Template type |
| `content` | TEXT | Message content |
| `priority` | TEXT | Priority level |
| `status` | TEXT | `pending`, `batched`, `sending`, `sent`, `failed` |
| `scheduled_for` | TEXT | ISO timestamp for delayed delivery |
| `batch_key` | TEXT | Batching group key |
| `batch_window` | INTEGER | Batch window in ms |
| `retry_count` | INTEGER | Number of delivery attempts |
| `created_at` | TEXT | ISO timestamp |
| `sent_at` | TEXT | ISO timestamp of successful delivery |
| `error_message` | TEXT | Last error if failed |
