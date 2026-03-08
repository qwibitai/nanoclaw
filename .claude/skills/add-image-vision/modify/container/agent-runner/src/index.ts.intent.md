# Intent: container/agent-runner/src/index.ts

## What Changed
- Added `imageAttachments?` field to ContainerInput interface
- Added `ImageContentBlock`, `TextContentBlock`, `ContentBlock` type definitions
- Changed `SDKUserMessage.message.content` type from `string` to `string | ContentBlock[]`
- Added `pushMultimodal(content: ContentBlock[])` method to MessageStream class
- Updated `remaining()` method to filter to text-only content (`.filter((c): c is string => typeof c === 'string')`)
- In `runQuery`: image loading logic reads attachments from disk, base64-encodes, sends as multimodal content blocks

## Key Sections
- **Types** (top of file): New content block interfaces, updated SDKUserMessage
- **MessageStream class**: New pushMultimodal method, updated remaining() filter
- **runQuery function**: Image loading block at top

## Invariants (must-keep)
- JsonRpcTransport import (first import, intercepts stdout)
- createIpcMcpServer import and in-process MCP server setup
- MessageStream push/end/remaining/asyncIterator (text messages still work)
- Transport-based drain loop in runQuery (drainLoop, nextEvent, cancelWait)
- Transport.unshift for re-queuing unconsumed messages
- Session management (getSessionSummary, sessions index)
- PreCompact hook (transcript archiving)
- Bash sanitization hook (4 SECRET_ENV_VARS)
- SDK query options structure (mcpServers as in-process, hooks, permissions)
- Query loop in main() (query -> wait for transport event -> repeat)
- Transport.initialized for receiving ContainerInput
