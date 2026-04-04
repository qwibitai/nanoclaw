---
name: add-mcp
description: Add custom stdio MCP servers to container agents declaratively via mcp-servers.json config files.
---

# Add Custom MCP Server

Add arbitrary stdio MCP servers to NanoClaw container agents without modifying source code. Servers are configured via `mcp-servers.json` and loaded dynamically at agent startup.

## Phase 1: Pre-flight

### Check if config loading is available

Check if `container/agent-runner/src/index.ts` contains `loadMcpConfig`. If not, the user needs to merge the add-mcp changes first (see the repo's commit history or upstream).

### Collect server details

Use `AskUserQuestion` to gather:

1. **Server name** — identifier used in tool names (`mcp__{name}__*`)
2. **Command** — the executable to run (e.g., `node`, `python3`, or an absolute path)
3. **Arguments** — command-line args (e.g., path to the server script)
4. **Environment variables** — any env vars the server needs (optional)
5. **Host paths to mount** — where the server binary/script and its data dependencies live on the host

## Phase 2: Set Up Volume Mounts

If the server binary or its data lives on the host filesystem, it must be mounted into the container.

### Add to mount allowlist

```bash
# Create or update the mount allowlist
# File: ~/.config/nanoclaw/mount-allowlist.json
```

The allowlist is a JSON array of allowed host path prefixes. Add the directories that need to be mounted.

### Register additional mounts for the group

Use the setup script or direct DB update to add `additionalMounts` to the group's `containerConfig`:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "<chat-id>" \
  --add-mount "<host-path>:/workspace/extra/<name>:ro"
```

Or update the existing group registration to include the mount.

Each mount appears inside the container at `/workspace/extra/<name>/`.

## Phase 3: Configure MCP Server

### Write mcp-servers.json

For a specific group, write to `groups/{folder}/mcp-servers.json`:

```json
{
  "servers": {
    "<server-name>": {
      "command": "<command>",
      "args": ["<arg1>", "<arg2>"],
      "env": {
        "KEY": "value"
      }
    }
  }
}
```

For all groups, write to `groups/global/mcp-servers.json` (read-only from non-main groups).

**Important**: The `command` and `args` must reference paths inside the container, not host paths. For mounted binaries, use `/workspace/extra/<name>/...`.

### Example configurations

**Node.js MCP server mounted from host:**

```json
{
  "servers": {
    "my-tools": {
      "command": "node",
      "args": ["/workspace/extra/my-tools/dist/index.js"],
      "env": {
        "DATA_DIR": "/workspace/extra/my-data"
      }
    }
  }
}
```

**Python MCP server:**

```json
{
  "servers": {
    "analyzer": {
      "command": "python3",
      "args": ["/workspace/extra/analyzer/server.py"],
      "env": {}
    }
  }
}
```

### Multiple servers

Multiple servers can be defined in the same file:

```json
{
  "servers": {
    "server-a": {
      "command": "node",
      "args": ["/workspace/extra/server-a/index.js"]
    },
    "server-b": {
      "command": "node",
      "args": ["/workspace/extra/server-b/index.js"]
    }
  }
}
```

## Phase 4: Verify

### Rebuild (host code only, no container rebuild needed)

```bash
npm run build
```

Agent-runner source changes are recompiled automatically on each container startup.

### Copy updated agent-runner to existing groups

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Restart service

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Test

Send a message to the bot. Check logs for:

```
Additional MCP servers: <server-name>
```

Then ask the agent to use a tool from the MCP server to confirm end-to-end connectivity.

## Phase 5: Adding More Servers Later

To add another MCP server, edit the existing `mcp-servers.json` and add a new entry under `servers`. Set up any needed volume mounts. No code changes or container rebuilds required.

## Troubleshooting

### Server not loading

1. Check the JSON is valid: `python3 -m json.tool groups/{folder}/mcp-servers.json`
2. Check logs for `Failed to load MCP config` errors
3. Verify the server binary is accessible at the container path

### Tools not available to agent

1. Verify server name does not conflict with `nanoclaw` (reserved)
2. Check that the server starts correctly: test the command manually inside the container
3. Look for MCP initialization errors in agent logs

### Permission denied on mounted files

1. Verify the host path is in the mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`)
2. Check file permissions — the container runs as uid matching the host user

## Removal

To remove a custom MCP server:

1. Remove its entry from `mcp-servers.json`
2. Optionally remove the `additionalMounts` from the group's container config
3. Optionally remove the path from the mount allowlist
