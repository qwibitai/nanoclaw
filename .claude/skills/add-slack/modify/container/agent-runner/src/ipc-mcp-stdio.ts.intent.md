# ipc-mcp-stdio.ts intent

## Changes
- Added `send_file` MCP tool: takes `file_path` (relative to workspace root) and optional `comment`, writes an IPC message with a `files` array that the host resolves and delivers via the channel's `sendFile()`
- Updated `register_group` tool description and `jid` parameter to document Slack JID formats alongside WhatsApp (`slack:C0XXXXXXXXX` for channels, `slack:D0XXXXXXXXX` for DMs)

## Invariants
- All existing MCP tools (send_message, schedule_task, list_tasks, pause_task, resume_task, cancel_task) must remain unchanged
- IPC file format for existing tools must remain unchanged
