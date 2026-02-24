# SimpleX Channel Implementation Guide

## Architecture

SimpleX Chat CLI runs as a standalone process and exposes a **WebSocket API** on a configurable port (default 5225). Your app connects to `ws://localhost:{port}` and exchanges JSON messages.

```bash
# Start SimpleX Chat CLI with WebSocket API
simplex-chat -p 5225 -d ~/.simplex/data
```

## Receiving Messages

SimpleX pushes events over the WebSocket. Incoming messages arrive as `newChatItems` events:

```json
{
  "resp": {
    "type": "newChatItems",
    "chatItems": [{
      "chatInfo": {
        "type": "direct",
        "contact": {
          "contactId": 5,
          "localDisplayName": "alice_1",
          "profile": {
            "displayName": "alice",
            "fullName": ""
          }
        }
      },
      "chatItem": {
        "chatDir": { "type": "directRcv" },
        "content": {
          "type": "rcvMsgContent",
          "msgContent": { "type": "text", "text": "hello" }
        }
      }
    }]
  }
}
```

For **group messages**, the structure differs:
- `chatInfo.type` is `"group"` with `chatInfo.groupInfo.groupId` and `chatInfo.groupInfo.groupProfile.displayName`
- `chatItem.chatDir.type` is `"groupRcv"` with sender info in `chatDir.groupMember.memberProfile.displayName`

**Filter out sent messages** by checking `chatDir.type` — only process `directRcv` and `groupRcv`.

## Sending Messages

Sending uses **text commands** passed as the `cmd` string field:

```json
{
  "corrId": "1",
  "cmd": "@alice_1 Hello from the bot"
}
```

- **Direct message**: `@{localDisplayName} {text}`
- **Group message**: `#{localDisplayName} {text}`
- **Fallback** (no cached name): `/send @{contactId} text {text}` or `/send #{groupId} text {text}`

## Critical Gotcha: `localDisplayName` vs `profile.displayName`

This is the biggest trap. SimpleX has **two name fields** per contact:

| Field | Purpose | Unique? |
|-------|---------|---------|
| `profile.displayName` | User-chosen display name | **NO** — multiple contacts can share it |
| `localDisplayName` | CLI-internal routing name | **YES** — SimpleX auto-disambiguates (e.g., `alice`, `alice_1`, `alice_2`) |

**The text command `@name` routes by `localDisplayName`, not `profile.displayName`.** If two contacts are both named "alice", the CLI assigns `localDisplayName` values of `alice` and `alice_1`. Using `@alice` always sends to the first one.

**You must cache `localDisplayName` for outbound routing** and use `profile.displayName` only for human-readable display.

## Listing Contacts

To discover contacts and their IDs:

```json
{"corrId": "1", "cmd": "/contacts"}
```

Response:

```json
{
  "corrId": "1",
  "resp": {
    "type": "contactsList",
    "contacts": [
      {
        "contactId": 5,
        "localDisplayName": "alice_1",
        "profile": { "displayName": "alice" }
      }
    ]
  }
}
```

## JID Scheme

Convention for SimpleX JIDs (chat identifiers):
- Direct messages: `sx:{contactId}` (e.g., `sx:5`)
- Groups: `sx:g:{groupId}` (e.g., `sx:g:10`)

## Multiple Contacts → Same Group

A single user can connect from multiple SimpleX clients (desktop + mobile). Each connection creates a **separate contact** with a different `contactId`. If both should route to the same agent/group folder, your registered_groups table must allow multiple JIDs to share the same folder (no UNIQUE constraint on the folder column).

## Connection Management

- The WebSocket can go stale silently — implement reconnection on close
- SimpleX CLI must be running before your app connects
- On reconnect, flush any queued outbound messages

## Message Prefix

Unlike group chats (WhatsApp, etc.) where you might prefix messages with the bot name for clarity, **SimpleX direct messages don't need a name prefix** — the client already shows who sent each message.

## Invite Links

To generate a contact invite link (so users can add the bot):

```json
{"corrId": "1", "cmd": "/address"}
```

This returns the bot's SimpleX address that users can scan/paste in their SimpleX client.

## SimpleX Chat CLI Version Tested

`v6.4.8.0` — the WebSocket API accepts string text commands in the `cmd` field. Structured JSON API commands (with `cmd` as an object) did not work in testing.
