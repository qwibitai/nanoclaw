# Intent: container/agent-runner/src/ipc-mcp-stdio.ts modifications

## What changed
Added 3 new MCP tools for managing SQLite-backed webhook listeners:
- `register_webhook_listener`
- `list_webhook_listeners`
- `remove_webhook_listener`

Also added `CronExpressionParser` import (already present for schedule_task validation).

## Key sections

### New tool: register_webhook_listener
Writes `{ type: 'register_webhook_listener', plugin, action, prompt_template, target_jid, groupFolder, timestamp }` to the tasks IPC dir.

Tool description instructs the agent to:
1. Call `mcp__corsair__list_operations` with `type="webhooks"` to discover exact plugin/action strings
2. Call `mcp__corsair__get_schema` to understand the event payload structure
3. Use only exact strings from those results

Prompt template description explains dot-notation support: `{{event.field.subfield}}`.

### New tool: list_webhook_listeners
Reads `current_webhook_listeners.json` from `IPC_DIR` (same pattern as `list_tasks`).
Formats: `[{id}] {plugin}.{action|*} → "{prompt_template preview}" ({status})`

### New tool: remove_webhook_listener
Writes `{ type: 'remove_webhook_listener', listenerId, groupFolder, isMain, timestamp }` to the tasks IPC dir.

## Invariants
- All existing tools (send_message, schedule_task, list_tasks, pause_task, resume_task, cancel_task, register_group) are completely unchanged
- IPC_DIR, MESSAGES_DIR, TASKS_DIR constants unchanged
- writeIpcFile helper unchanged
- Server startup (StdioServerTransport) unchanged

## Must-keep
- All existing MCP tools
- The writeIpcFile atomic write pattern
- Environment variable reads (chatJid, groupFolder, isMain)
