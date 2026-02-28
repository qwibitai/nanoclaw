# Intent: src/router.ts modifications

## What changed
Extended message formatting with msg-id attributes, quote context, and attachment elements. Updated routeOutbound to pass attachments through.

## Key sections

### formatMessages()
- Added `msg-id` attribute: extracts from message IDs matching `^[a-z]+-(.+)$` pattern, formatted as `timestamp:sender`. Enables agents to target specific messages for reactions/replies.
- Added `replying-to` attribute: when message has a quote, includes `author: truncated-text` (max 100 chars)
- Added `<attachment>` child elements: for each attachment, emits `<attachment type="contentType" name="filename"/>` inside the message element. Falls back to `type` only when filename is missing.

### routeOutbound()
- Added optional `attachments?: string[]` parameter
- Passes attachments through to `channel.sendMessage()`

## Invariants
- `escapeXml` helper unchanged
- Messages without prefix-timestamp IDs (e.g. WhatsApp hex IDs) get no msg-id — this is correct
- Messages without quotes get no replying-to attribute
- Messages without attachments get no attachment elements
- The `findChannel()` function is unchanged
- All existing routing logic preserved
