---
name: add-channel-interactions
description: Add channel-agnostic interaction features (reactions, replies, polls, typing, attachments, group metadata) to any NanoClaw channel. Use when building or enhancing a channel that needs interaction capabilities beyond basic messaging.
---

# Add Channel Interactions

This skill extends NanoClaw's Channel interface with optional interaction methods that any channel can implement. Adds reactions, quoted replies, polls, typing indicators, attachment forwarding, and group metadata — all channel-agnostic with graceful fallbacks.

## What It Adds

| Feature | Channel Method | MCP Tool | Fallback |
|---------|---------------|----------|----------|
| Reactions | `sendReaction?()` | `send_reaction` | Warning log (can't approximate) |
| Replies | `sendReply?()` | via `send_message` reply_to_msg_id | Falls back to regular message |
| Polls | `sendPoll?()` | `send_poll` | Warning log (can't approximate) |
| Typing | `setTyping?()` | — | Silently skipped |
| Attachments | via `sendMessage()` | via `send_message` attachments | Skipped with warning |
| Group metadata | `getGroupMetadata?()` | `get_group_info` | Empty metadata |
| /chatid | — | — | Handled at router level |

All methods use TypeScript optional syntax (`method?()`) — zero breaking changes for existing channels.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `channel-interactions` (the `skill:` key from `manifest.yaml`) is in `applied_skills`, stop — the code changes are already in place.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-channel-interactions
```

This deterministically:
- Extends the `Channel` interface in `src/types.ts` with optional interaction methods
- Adds `GroupMetadata` type and extends `NewMessage` with attachments, quotes, and reactions
- Three-way merges IPC support for reactions, replies, polls, and attachment resolution into `src/ipc.ts`
- Three-way merges `msg-id` attributes, quote context, and attachment elements into `src/router.ts`
- Three-way merges IPC wiring with fallback behavior and `/chatid` command into `src/index.ts`
- Three-way merges `writeGroupMetadataSnapshot` into `src/container-runner.ts`
- Three-way merges `send_reaction`, `send_poll`, and `get_group_info` MCP tools into `container/agent-runner/src/ipc-mcp-stdio.ts`
- Three-way merges channel-agnosticism tests into `src/formatting.test.ts`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files in `modify/`:
- `modify/src/types.ts.intent.md` — Channel interface extensions
- `modify/src/ipc.ts.intent.md` — IPC deps and message handling
- `modify/src/router.ts.intent.md` — Message formatting changes
- `modify/src/index.ts.intent.md` — Wiring and /chatid
- `modify/src/container-runner.ts.intent.md` — Group metadata snapshot
- `modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md` — MCP tool additions
- `modify/src/formatting.test.ts.intent.md` — agnosticism test additions

### Validate

```bash
npm test
npm run build
```

All tests must pass and build must be clean.

## Phase 3: Implementing Features in Your Channel

After applying, your channel class can implement any of the new optional methods. Here's what each one does:

### Typing Indicators

```typescript
async setTyping(jid: string, isTyping: boolean): Promise<void> {
  // Show typing indicator in the chat
}
```

### Reactions

```typescript
async sendReaction(jid: string, emoji: string, targetAuthor: string, targetTimestamp: number): Promise<void> {
  // React to a specific message with an emoji
}
```

### Quoted Replies

```typescript
async sendReply(jid: string, text: string, targetAuthor: string, targetTimestamp: number, attachments?: string[]): Promise<void> {
  // Send a message that quotes/replies to a specific earlier message
}
```

### Polls

```typescript
async sendPoll(jid: string, question: string, options: string[]): Promise<void> {
  // Create a poll in the chat
}
```

### Group Metadata

```typescript
getGroupMetadata(jid: string): GroupMetadata | undefined {
  // Return { description?, members?, admins? } for the chat
}
```

### Message IDs for Targeting

For reactions and replies to work, your channel's messages need addressable IDs. The router extracts `msg-id` from message IDs that follow the `prefix-timestamp` pattern (e.g., `signal-1709123456`, `telegram-1709123456`). Agents use these IDs to target specific messages.

If your channel's message IDs don't use this pattern, reactions and replies won't have targets — but everything else still works.

### Attachments

Attachments flow through `sendMessage`'s existing optional `attachments` parameter. The IPC layer resolves container paths to host paths automatically. Your channel just needs to handle the host file paths when sending.

## How It Works

### Agent → Channel Flow

1. Container agent calls MCP tool (e.g., `send_reaction`)
2. Tool writes JSON to `/workspace/ipc/messages/`
3. Host IPC watcher reads the file
4. IPC checks if the dep is wired (optional — graceful skip if not)
5. Calls the channel's method if available

### Message Targeting

Messages include a `msg-id` attribute in the XML context sent to agents:

```xml
<msg sender="Alice" time="2024-03-01T10:00:00Z" msg-id="1709283600:alice@example.com">
  Hello everyone
</msg>
```

Agents pass this `msg-id` back when reacting or replying, allowing the router to target the right message.

## Removal

To remove channel interactions:

1. Revert the optional methods from the `Channel` interface in `src/types.ts`
2. Remove `sendReaction`, `sendReply`, `sendPoll` from `IpcDeps` in `src/ipc.ts`
3. Remove `resolveAttachmentPaths` and reaction/poll/reply handling from `src/ipc.ts`
4. Remove `msg-id`, quote, and attachment formatting from `src/router.ts`
5. Remove the IPC wiring and `/chatid` handler from `src/index.ts`
6. Remove `writeGroupMetadataSnapshot` from `src/container-runner.ts`
7. Remove `send_reaction`, `send_poll`, `get_group_info` tools from `container/agent-runner/src/ipc-mcp-stdio.ts`
8. Rebuild: `npm run build`
