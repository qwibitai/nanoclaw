# Intent: container/agent-runner/src/index.ts modifications

## What changed
Added multimodal (image) support to the agent runner so Claude can process images sent by users.

## Key sections

### ContentBlock type — new
- Added after SessionsIndex interface, before SDKUserMessage
- Union type: `{ type: 'text'; text: string }` | `{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }`

### SDKUserMessage interface
- Changed: `content` type from `string` to `string | ContentBlock[]`

### buildContentBlocks() — new function
- Placed before `readStdin()`
- Parses XML message text for `image="..."` attributes
- Reads image files from `/workspace/images/` and creates base64-encoded content blocks
- Returns plain string if no images found (zero-cost for text-only messages)
- Handles XML entity decoding (`&amp;`, `&lt;`, `&gt;`, `&quot;`)

### MessageStream.push()
- Changed: parameter type from `string` to `string | ContentBlock[]`

### runQuery()
- Changed: `stream.push(prompt)` to `stream.push(buildContentBlocks(prompt))`
- Changed: `stream.push(text)` (IPC messages) to `stream.push(buildContentBlocks(text))`

## Invariants
- All IPC polling logic is unchanged
- Session management is unchanged
- Output writing and markers are unchanged
- Pre-compact hook (conversation archiving) is unchanged
- Bash sanitization hook is unchanged
- The main() query loop is unchanged
- Environment and secrets handling is unchanged

## Must-keep
- The MessageStream async iterable pattern
- IPC input polling and _close sentinel handling
- All hook functions (PreCompact, PreToolUse)
- Transcript parsing and archiving
- The MCP server configuration
- The SDK query options (allowedTools, permissionMode, etc.)
