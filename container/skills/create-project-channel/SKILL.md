---
name: create-project-channel
description: Create a Discord channel linked to a ~/projects/ directory. Use when the user asks to create a project channel, link a project to Discord, or set up a channel for a codebase.
---

# /create-project-channel — Create a Discord project channel via IPC

Creates a Discord text channel linked to a project directory. The host process handles Discord API calls and group registration — you just write an IPC task file.

**Main-channel only.** Check:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond:
> This command is only available from the main channel.

Then stop.

## Steps

### 1. List projects

Read `/home/square/projects/` and cross-reference with `available_groups.json`:

```bash
ls -1 /home/square/projects/
cat /workspace/ipc/available_groups.json
```

Present which projects already have channels (those with a `projectPath` field) and which don't.

### 2. Confirm

State the channel name (`#project-<folder-name>`) and project path. Ask for confirmation before proceeding.

### 3. Create via IPC

Write the action file:

```bash
cat > /workspace/ipc/tasks/create_project_channel_$(date +%s).json << 'IPCEOF'
{
  "type": "create_project_channel",
  "projectName": "<folder-name>",
  "projectPath": "/home/square/projects/<folder-name>",
  "channelName": "project-<folder-name>",
  "requestedBy": "<chat-jid-of-requesting-channel>"
}
IPCEOF
```

Replace the placeholders with actual values. `requestedBy` is the JID of the chat where the user made the request.

### 4. Read result

Wait a few seconds, then check for the result:

```bash
ls -t /workspace/ipc/input/create_project_channel_result_*.json 2>/dev/null | head -1 | xargs cat
```

Report success or failure to the user.

## Channel naming

All project channels use the `project-` prefix: `#project-<folder-name>`.
