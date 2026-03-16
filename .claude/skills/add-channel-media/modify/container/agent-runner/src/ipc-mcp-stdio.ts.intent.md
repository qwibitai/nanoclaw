# Intent: container/agent-runner/src/ipc-mcp-stdio.ts modifications

## What changed
Added two MCP tools for media interaction from within the container agent.

## Key additions

### Constants and helpers
- `MEDIA_DIR = '/workspace/media'` — Container-side media directory
- `sleep(ms)` — Utility for polling loop

### get_media tool
Allows the agent to download and view media attachments referenced in messages.

Flow:
1. Agent sees `<attachment id="..." />` in a message
2. Agent calls `get_media(media_id="...")`
3. Tool checks if file already exists in `/workspace/media/`
4. If not, writes IPC `media_download` request to tasks directory
5. Polls `/workspace/media/` for up to 30s (500ms interval) waiting for host to download
6. Detects `.error` sentinel files immediately — returns descriptive error instead of waiting for timeout
7. Returns file path for agent to use with Read tool

### send_media tool
Allows the agent to send files/images to the current chat.

Flow:
1. Agent creates or downloads a file to `/workspace/`
2. Agent calls `send_media(file_path="...", caption="...", filename="...")`
3. Tool validates path is under `/workspace/` and file exists
4. Writes IPC `media_message` request to tasks directory
5. Host picks up the IPC file and routes through the appropriate channel

## Placement
Both tools are added after `register_group` and before the transport initialization.

## Must-keep
- All existing MCP tools (send_message, schedule_task, list_tasks, pause/resume/cancel_task, register_group)
- The writeIpcFile helper
- Environment variable extraction at top
- StdioServerTransport initialization at bottom
