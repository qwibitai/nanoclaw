# claude-mem Setup Reference

Detailed installation and configuration reference for the claude-mem integration with NanoClaw.

## Plugin Installation

### Via Claude Code CLI

```bash
claude plugins add thedotmack/claude-mem
```

This installs to `~/.claude/plugins/cache/thedotmack/claude-mem/<version>/`.

### Verify Installation

```bash
# Check plugin exists
ls ~/.claude/plugins/cache/thedotmack/claude-mem/

# Check MCP server script
ls ~/.claude/plugins/cache/thedotmack/claude-mem/*/scripts/mcp-server.cjs

# Check worker script
ls ~/.claude/plugins/cache/thedotmack/claude-mem/*/scripts/worker.cjs
```

## Worker Configuration

### Settings File

Location: `~/.claude-mem/settings.json`

```json
{
  "workerHost": "0.0.0.0",
  "workerPort": 37777
}
```

| Setting | Default | NanoClaw Requirement |
|---------|---------|---------------------|
| `workerHost` | `127.0.0.1` | Must be `0.0.0.0` — Docker containers connect via bridge network |
| `workerPort` | `37777` | Default is fine unless port conflicts exist |

### Why 0.0.0.0?

Docker containers use `host.docker.internal` (resolved via `--add-host=host.docker.internal:host-gateway`) to reach the host. This resolves to the Docker bridge IP (typically `172.17.0.1`), not `127.0.0.1`. If the worker only listens on localhost, containers can't connect.

## Service Templates

### Linux (systemd)

File: `~/.config/systemd/user/claude-mem-worker.service`

```ini
[Unit]
Description=claude-mem worker
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node %h/.claude/plugins/cache/thedotmack/claude-mem/latest/scripts/worker.cjs
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Commands:
```bash
systemctl --user daemon-reload
systemctl --user enable claude-mem-worker
systemctl --user start claude-mem-worker
systemctl --user status claude-mem-worker

# View logs
journalctl --user -u claude-mem-worker -f

# Restart
systemctl --user restart claude-mem-worker
```

> **Note**: `%h` expands to `$HOME` in systemd unit files. The `latest` directory should be a symlink or the actual version directory.

### macOS (launchd)

File: `~/Library/LaunchAgents/com.claude-mem.worker.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-mem.worker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/YOUR_USER/.claude/plugins/cache/thedotmack/claude-mem/latest/scripts/worker.cjs</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-mem-worker.err</string>
    <key>StandardOutPath</key>
    <string>/tmp/claude-mem-worker.out</string>
</dict>
</plist>
```

Commands:
```bash
# Load (start + enable on login)
launchctl load ~/Library/LaunchAgents/com.claude-mem.worker.plist

# Unload
launchctl unload ~/Library/LaunchAgents/com.claude-mem.worker.plist

# View logs
tail -f /tmp/claude-mem-worker.err
```

## Connectivity Architecture

```
Docker Container (agent)
  └─ mcp-server.cjs (MCP stdio)
       └─ HTTP → host.docker.internal:37777
                   │
                   ▼
Host Machine
  └─ worker.cjs (HTTP server)
       └─ SQLite → ~/.claude-mem/memory.db
```

### Network Flow

1. `container-runner.ts` adds `--add-host=host.docker.internal:host-gateway` to Docker run args
2. `container-runner.ts` mounts `~/.claude/plugins/cache/.../scripts/` to `/opt/claude-mem/scripts/` (read-only)
3. `agent-runner/index.ts` checks if `/opt/claude-mem/scripts/mcp-server.cjs` exists
4. If yes, registers `mcp-search` MCP server with `CLAUDE_MEM_WORKER_HOST=host.docker.internal`
5. Agent tools (`mcp__mcp-search__*`) make HTTP calls to `host.docker.internal:37777`
6. Worker processes requests against the SQLite database

### Per-Group Isolation

Each NanoClaw group gets an isolated memory namespace via `CLAUDE_MEM_PROJECT=<groupFolder>`. Group `main`'s observations are separate from group `my-project`'s observations.

## Troubleshooting

### Worker won't start

```bash
# Check Node.js version (18+ required)
node --version

# Try running manually
node ~/.claude/plugins/cache/thedotmack/claude-mem/*/scripts/worker.cjs
```

### Port already in use

```bash
# Find what's using port 37777
lsof -i :37777

# Kill it or change the port in settings.json
```

### Container can't reach worker

```bash
# Test from a Docker container
docker run --rm --add-host=host.docker.internal:host-gateway alpine wget -qO- http://host.docker.internal:37777/health

# If this fails, check:
# 1. Worker is running and bound to 0.0.0.0
# 2. No firewall blocking port 37777 from Docker bridge
# 3. Docker daemon supports --add-host (most versions do)
```

### Database issues

```bash
# Check database exists
ls -la ~/.claude-mem/

# Check database size
du -h ~/.claude-mem/memory.db

# Test a search (from host, not container)
curl -s http://localhost:37777/api/search?query=test
```

### Plugin version mismatch

```bash
# List installed versions
ls ~/.claude/plugins/cache/thedotmack/claude-mem/

# findClaudeMemScripts() picks the last version alphabetically
# If you have multiple versions and need a specific one, remove the others
```
