---
name: add-thinking-stream
description: Live thinking stream that shows tool calls and reasoning in chat via edit-in-place messages while the agent works.
---

# Add Thinking Stream

While the agent works, tool calls and thinking snippets appear as a live-updating message in chat. The message edits in-place so it doesn't clutter the conversation. When the final response arrives, the thinking message stops updating and persists as a record of the agent's work.

Tool calls are always streamed (useful even with thinking disabled). Thinking blocks are streamed when extended thinking is enabled (however it's configured).

The thinking stream uses IPC: the agent-runner writes thinking updates to files in the IPC directory, the host picks them up and sends/edits a message in the channel. Channels that support `editMessage` (like Telegram) show the stream; others silently skip it.

## Prerequisites

- A channel that supports message editing must be installed (e.g., `/add-telegram`)
- The channel must implement optional `sendMessageWithId` and `editMessage` methods

## Phase 1: Pre-flight

1. Check `.nanoclaw/state.yaml` for `add-thinking-stream` -- skip if already applied
2. Verify a channel is installed (at minimum, `src/channels/telegram.ts` should exist)

## Phase 2: Apply Code Changes

Apply the skill using the skills engine:

```bash
npx tsx skills-engine/apply-skill.ts add-thinking-stream
```

This modifies the following files. Read the intent files in `modify/` for details on what changes and what must be preserved.

### Types (`src/types.ts`)

Add two optional methods to the `Channel` interface:

```typescript
editMessage?(jid: string, messageId: number, text: string): Promise<void>;
sendMessageWithId?(jid: string, text: string): Promise<number | null>;
```

### Container Runner (`src/container-runner.ts`)

Add `--pull=never` flag to prevent Docker from trying to pull images from registries.

### IPC (`src/ipc.ts`)

Add `sendMessageWithId` and `editMessage` to `IpcDeps` interface.

Add thinking stream state tracking (ThinkingState map keyed by chatJid).

Export `clearThinkingState(chatJid)` function.

In the IPC message loop, handle two new message types before the existing `message` handler:
- `thinking`: Append to a live-updating message (max 8 lines, blockquote for thoughts, italic for tools)
- `clear_thinking`: Reset internal host state so the next turn starts fresh. This does NOT delete the thinking message from chat — it remains as a persistent record of agent activity.

### Orchestrator (`src/index.ts`)

Import `clearThinkingState` from `ipc.ts`.

Add `sendMessageWithId` and `editMessage` callbacks to the IPC deps (delegating to the channel via `findChannel`).

On new inbound messages (not from self, not bot), call `clearThinkingState(chatJid)` to reset the thinking state so the next agent run gets a fresh thinking message.

### Router (`src/router.ts`)

Update `stripInternalTags` to also strip leaked thinking/function_calls XML blocks from outbound messages.

### Agent Runner (`container/agent-runner/src/index.ts`)

Add thinking stream emitter that writes IPC files:
- `summarizeToolCall(toolName, input)` -- Returns a human-readable one-liner for each tool (emoji + truncated description). Returns null for noisy tools (TodoWrite) to skip them.
- `sendThinkingUpdate(chatJid, text, format)` -- Writes a JSON file to `IPC_MESSAGES_DIR` with rate limiting (1.5s between tool updates, no limit on thought updates).
- `clearThinkingState()` -- Writes a `clear_thinking` IPC file before the final result to reset host state, allowing the next turn to start with a fresh thinking message.

In the message loop:
- Extract `thinking` blocks and stream truncated summaries (200 char max)
- Extract `tool_use` blocks and stream summarized tool calls
- Call `clearThinkingState()` before writing the final result

### Telegram Channel (`src/channels/telegram.ts`)

Add two new methods to the TelegramChannel class:

- `sendMessageWithId(jid, text)` -- Sends a message and returns the Telegram message ID
- `editMessage(jid, messageId, text)` -- Edits a previously sent message. Silently ignores "message is not modified" errors from Telegram.

## Phase 3: Rebuild

1. Rebuild the container (agent-runner changes):
   ```bash
   ./container/build.sh
   ```

2. Build the host code:
   ```bash
   npm run build
   ```

3. Restart the service:
   ```bash
   # macOS:
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   # Linux:
   systemctl --user restart nanoclaw
   ```

## Phase 4: Verify

1. Send a message that triggers tool use (e.g., "search for today's news")
2. While the agent works, you should see a live-updating italic message showing tool calls
3. When thinking is enabled, you'll see blockquoted thought snippets
4. When the final response arrives, the thinking message stops updating and remains in chat above the final response

## Removal

1. Remove the `editMessage`/`sendMessageWithId` methods from Channel interface and Telegram implementation
2. Remove thinking stream code from `src/ipc.ts`
3. Remove thinking emitter from `container/agent-runner/src/index.ts`
4. Rebuild: `npm run build && ./container/build.sh`
