# Intent: src/index.ts modifications

## What changed
Added two MemOS integration points in `processGroupMessages()`: auto-recall (inject memories before agent runs) and auto-capture (store exchange after agent finishes).

## Key sections

### Imports
- Added: `MEMOS_API_URL` to the config import
- Added: `import { addMemory, searchMemories } from './memos-client.js'`

### Auto-recall (before agent invocation)
- Changed `const prompt` to `let prompt` to allow prepending memories
- Added block: when `MEMOS_API_URL` is set, search MemOS using the last user message, format matches as `<memory>` XML elements with relevance scores, and prepend to prompt
- Gated on `MEMOS_API_URL` — skipped entirely when unconfigured

### Response chunk collection
- Added `const userText` (joins all missed message content)
- Added `const responseChunks: string[]` accumulator
- Added `responseChunks.push(text)` inside the streaming callback

### Auto-capture (after container exits)
- Added block: when `MEMOS_API_URL` is set and output was sent to the user, store `User: {text}\nAssistant: {response}` in MemOS
- Fire-and-forget via `.catch()` — failures are logged as warnings, never block response delivery
- Captures even on container error (idle timeout, SIGKILL) as long as output was sent

## Invariants
- All existing message processing, routing, and response delivery are unchanged
- Credential proxy startup and shutdown are unchanged
- Remote control handling is unchanged
- The message loop, group queue, and channel event handling are all untouched

## Must-keep
- `startCredentialProxy` / `proxyServer.close()` lifecycle
- `handleRemoteControl` function
- All channel event registration and message routing
- The `runAgent()` call and its streaming callback structure
- `outputSentToUser` flag logic
