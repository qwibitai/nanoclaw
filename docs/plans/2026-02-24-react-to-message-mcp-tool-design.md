# Design: `react_to_message` MCP Tool

**Date:** 2026-02-24
**Status:** Approved
**Branch:** feat/add-reactions-skill

## Problem

The container agent (Andy) cannot send WhatsApp emoji reactions. The host process has `sendReaction()` and `reactToLatestMessage()` on the WhatsApp channel, but there's no MCP tool bridging the container agent to these methods.

## Design

Add a `react_to_message` MCP tool following the existing `send_message` pattern: agent writes an IPC file, host polls and executes.

### MCP Tool (container side)

**File:** `container/agent-runner/src/ipc-mcp-stdio.ts`

**Tool:** `react_to_message`
- `emoji` (string, required) — emoji to react with
- `message_id` (string, optional) — target message ID; omit to react to the latest message in the current chat

**IPC payload:**
```json
{
  "type": "reaction",
  "emoji": "👍",
  "messageId": "3EB0F4C9E7...",
  "chatJid": "<from env>",
  "groupFolder": "<from env>",
  "timestamp": "<ISO string>"
}
```

Written to `/workspace/ipc/messages/` (same directory as outbound messages).

### Host IPC Handler

**File:** `src/ipc.ts`

In the existing message-processing loop, detect `type: 'reaction'` alongside `type: 'message'`:

- If `messageId` is present: construct a `messageKey` and call `channel.sendReaction(chatJid, messageKey, emoji)`
- If `messageId` is absent: call `channel.reactToLatestMessage(chatJid, emoji)`
- Same authorization checks as `send_message` (group ownership or isMain)

### No New Files

Both changes are additions to existing files. No new modules, no new IPC directories.

### Authorization

Same model as `send_message`:
- Non-main groups can only react in their own chat
- Main group can react in any registered chat

### Error Handling

- Missing emoji → MCP tool returns validation error (Zod)
- No messages found for chat → host logs warning, no crash
- WhatsApp send failure → host logs error, agent doesn't get feedback (fire-and-forget, same as `send_message`)
