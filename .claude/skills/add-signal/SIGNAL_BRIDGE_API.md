# Signal Bridge API

This document defines the Android bridge contract expected by the NanoClaw `add-signal` skill.

## Authentication

Every request must include:

```http
Authorization: Bearer <SIGNAL_BRIDGE_TOKEN>
```

## Endpoints

### `GET /health`

Used at NanoClaw startup to verify the bridge is reachable.

Example response:

```json
{
  "ok": true,
  "bridgeVersion": "1.0.0",
  "deviceName": "Pixel 9"
}
```

### `GET /threads`

Returns known Signal conversations for registration and metadata sync.

Example response:

```json
{
  "threads": [
    {
      "id": "thread-123",
      "name": "Family",
      "isGroup": true,
      "lastMessageAt": "2026-03-09T12:00:00.000Z"
    },
    {
      "id": "thread-456",
      "name": "Teemu",
      "isGroup": false,
      "lastMessageAt": "2026-03-09T12:05:00.000Z"
    }
  ]
}
```

## `GET /events?cursor=...`

Long-poll or short-poll endpoint for incremental inbound and outbound message events.

Example response:

```json
{
  "events": [
    {
      "id": "evt-001",
      "type": "message",
      "direction": "incoming",
      "threadId": "thread-123",
      "threadName": "Family",
      "senderId": "+358401234567",
      "senderName": "Alice",
      "text": "@Andy what time is dinner?",
      "timestamp": "2026-03-09T12:10:00.000Z",
      "isGroup": true,
      "attachments": []
    }
  ],
  "nextCursor": "cursor-002"
}
```

Supported attachment kinds:

- `image`
- `video`
- `voice`
- `audio`
- `document`
- `sticker`

Unsupported kinds should still be returned, but the NanoClaw adapter may render them as `[Attachment]`.

### `POST /messages`

Used for outbound replies.

Request body:

```json
{
  "threadId": "thread-123",
  "text": "Dinner is at 18:00."
}
```

Success response:

```json
{
  "ok": true,
  "messageId": "out-123"
}
```

## Event Semantics

- `threadId` must be stable across restarts.
- `direction` must be `incoming` or `outgoing`.
- `outgoing` is how the bridge tells NanoClaw that a message came from itself; the adapter uses this to avoid feedback loops.
- `timestamp` must be ISO 8601 UTC.
- `threadName` should be included whenever available, but the adapter tolerates it being omitted.

## Security Notes

- Bind the bridge to localhost or a trusted LAN only.
- Use a random bearer token.
- Do not expose the bridge unauthenticated on the public internet.
