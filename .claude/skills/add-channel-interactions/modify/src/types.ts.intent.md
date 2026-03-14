# Intent: src/types.ts modifications

## What changed
Extended the Channel interface with optional interaction methods and added supporting types.

## Key sections

### Attachment interface (new)
- `contentType`, `filename?`, `hostPath`, `containerPath`, `size?`
- Used by NewMessage to describe inbound attachments with both host and container paths

### NewMessage extensions
- Added `attachments?: Attachment[]` — inbound message attachments
- Added `quote?: { author, text }` — quoted/replied-to message context
- Added `reaction?: { emoji, targetAuthor, targetTimestamp }` — reaction metadata

### GroupMetadata interface (new)
- `description?`, `members?`, `admins?`
- Returned by `Channel.getGroupMetadata()` for group info queries

### Channel interface extensions
- `setTyping?(jid, isTyping)` — typing indicator
- `sendReaction?(jid, emoji, targetAuthor, targetTimestamp)` — react to a message
- `sendReply?(jid, text, targetAuthor, targetTimestamp, attachments?)` — quote-reply
- `sendPoll?(jid, question, options)` — create a poll
- `getGroupMetadata?(jid)` — get group description, members, admins

## Invariants
- All new Channel methods use `?` (optional) — existing channel classes compile unchanged
- Existing types (RegisteredGroup, ContainerConfig, etc.) are untouched
- OnInboundMessage and OnChatMetadata callbacks are unchanged
- `sendMessage` signature extended with optional `attachments?: string[]` parameter — existing channels that implement `sendMessage(jid, text)` still satisfy the interface due to TypeScript structural compatibility with optional params
