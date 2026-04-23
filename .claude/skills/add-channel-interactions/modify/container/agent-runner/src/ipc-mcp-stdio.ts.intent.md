# Intent: container/agent-runner/src/ipc-mcp-stdio.ts modifications

## What changed
Added MCP tools for reactions, polls, and group info. Extended send_message with attachments and reply support.

## Key sections

### send_message tool (extended)
- Added `attachments` parameter: array of file paths to send as attachments
- Added `reply_to_msg_id` parameter: quote-reply to a specific message using the msg-id format
- Added `sender` parameter: role/identity name for multi-bot channels
- Reply parsing: splits `msg_id` at first colon into `replyToTimestamp` and `replyToAuthor`

### send_reaction tool (new)
- Takes `emoji` and `msg_id` (format: "timestamp:sender")
- Validates msg_id format before writing IPC
- Writes `type: 'reaction'` to messages IPC directory

### send_poll tool (new)
- Takes `question` and `options` (2-12 choices)
- Writes `type: 'poll'` to messages IPC directory

### get_group_info tool (new)
- Reads `group_metadata.json` from the IPC directory
- Returns description, members, and admins
- Gracefully handles missing or empty metadata

### register_group description
- Updated to be channel-agnostic (removed WhatsApp-specific JID example)
- Now shows generic format and mentions `available_groups.json`

## Invariants
- All existing tools unchanged (schedule_task, list_tasks, pause/resume/cancel_task)
- The writeIpcFile helper unchanged
- Environment variable reading unchanged
- StdioServerTransport setup unchanged
- The `mcp__nanoclaw__*` wildcard in index.ts covers new tools automatically
