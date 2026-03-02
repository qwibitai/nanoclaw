# Intent: container/agent-runner/src/index.ts

## What Changed
- Added `imageAttachments?` field to ContainerInput interface
- Added `ImageContentBlock`, `TextContentBlock`, `ContentBlock` type definitions
- Changed `SDKUserMessage.message.content` type from `string` to `string | ContentBlock[]`
- Added `pushMultimodal(content: ContentBlock[])` method to MessageStream class
- In `runQuery`: replaced simple `stream.push(prompt)` with image loading logic that reads attachments from disk, base64-encodes them, and sends as multimodal content blocks

## Key Sections
- **Types** (top of file): New content block interfaces, updated SDKUserMessage
- **MessageStream class**: New pushMultimodal method
- **runQuery function**: Image loading block at the start, before IPC polling setup

## Invariants (must-keep)
- All IPC protocol logic (input polling, close sentinel, message stream)
- MessageStream push/end/asyncIterator (text messages still work)
- readStdin, writeOutput, log functions
- Session management (getSessionSummary, sessions index)
- PreCompact hook (transcript archiving) — signature and behavior unchanged
- Bash sanitization hook — SECRET_ENV_VARS list unchanged
- SDK query options (allowedTools, mcpServers, hooks, permissions)
- Query loop in main() (query → wait for IPC → repeat)
- All existing ContainerInput fields preserved
