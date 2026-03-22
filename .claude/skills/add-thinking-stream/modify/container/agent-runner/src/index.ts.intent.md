# Intent: container/agent-runner/src/index.ts

## What Changed

- Added IPC_MESSAGES_DIR constant and thinking stream rate limiting
- Added `summarizeToolCall(toolName, input)` function that returns emoji + description for each tool type
- Added `sendThinkingUpdate(chatJid, text, format)` that writes thinking IPC files with rate limiting
- Added `clearThinkingState()` that writes clear_thinking IPC file
- In message loop: extract thinking blocks and tool_use blocks from assistant messages, stream them via sendThinkingUpdate
- Before writing final result: call clearThinkingState()

## Key Sections

- **Constants**: IPC_MESSAGES_DIR, rate limit vars
- **summarizeToolCall**: Tool name to emoji+description mapping
- **sendThinkingUpdate**: Rate-limited IPC file writer
- **clearThinkingState**: IPC clear file writer
- **runQuery message loop**: thinking/tool_use extraction from assistant messages
- **runQuery result handler**: clearThinkingState before writeOutput

## Invariants (must-keep)

- IPC input streaming (IPC_INPUT_DIR, push-based async iterable)
- All MCP server setup (nanoclaw MCP with scheduling tools)
- Session management (resume, sessionId)
- Output parsing (OUTPUT_START/END markers)
- writeOutput function
- All hooks (PreCompact, PreToolUse/Bash sanitization)
- Environment variable passthrough
- Container working directory setup
- Extra directory handling
- Allowed tools list
- Permission bypass configuration
- Model selection (NANOCLAW_MODEL env var — exists in base, not added by this skill)
