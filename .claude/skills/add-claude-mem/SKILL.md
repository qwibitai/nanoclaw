---
name: add-claude-mem
description: Add cross-session memory to NanoClaw agents via claude-mem MCP server. Agents can search, store, and recall observations across conversations. Runs on the host — no npm dependencies.
---

# Add Cross-Session Memory (claude-mem)

This skill adds persistent cross-session memory to NanoClaw agents using the [claude-mem](https://github.com/thedotmack/claude-mem) MCP server. After setup, agents can search past conversations, recall decisions, and build on prior work across sessions.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `claude-mem` is in `applied_skills`, skip to Phase 3 (Install claude-mem). The code changes are already in place.

### Check prerequisites

1. Claude Code CLI must be installed and working
2. Docker must be running (containers need `--add-host` support)
3. The host machine must be Linux or macOS (claude-mem worker uses systemd or launchd)

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-claude-mem
```

This deterministically:
- Exports `HOME_DIR` from `src/config.ts` (was a local const)
- Adds `findClaudeMemScripts()` to `src/container-runner.ts` (discovers plugin cache)
- Adds claude-mem volume mount and `--add-host=host.docker.internal:host-gateway`
- Adds `mcp__mcp-search__*` to allowed tools in `container/agent-runner/src/index.ts`
- Adds conditional mcp-search MCP server configuration
- Adds `HOME_DIR` mock to `src/container-runner.test.ts`

If the apply reports merge conflicts, read the intent files:
- `modify/src/config.ts.intent.md`
- `modify/src/container-runner.ts.intent.md`
- `modify/src/container-runner.test.ts.intent.md`
- `modify/container/agent-runner/src/index.ts.intent.md`

### Validate code changes

```bash
npx vitest run src/container-runner.test.ts
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Install claude-mem

### Install the plugin

Install claude-mem as a Claude Code plugin:

```bash
claude plugins add thedotmack/claude-mem
```

This installs the plugin to `~/.claude/plugins/cache/thedotmack/claude-mem/<version>/`.

### Verify installation

```bash
ls ~/.claude/plugins/cache/thedotmack/claude-mem/*/scripts/mcp-server.cjs
```

Should show the mcp-server.cjs file. If not, the plugin install may have failed.

## Phase 4: Configure Worker

The claude-mem worker needs to:
1. Bind to `0.0.0.0` (not just localhost) so Docker containers can reach it
2. Run as a background service

### Configure settings

Create or update `~/.claude-mem/settings.json`:

```json
{
  "workerHost": "0.0.0.0",
  "workerPort": 37777
}
```

See [CLAUDE_MEM_SETUP.md](CLAUDE_MEM_SETUP.md) for the full settings reference.

### Create systemd service (Linux)

Create `~/.config/systemd/user/claude-mem-worker.service`:

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

> **Note**: Replace `latest` with the actual version directory name if there's no `latest` symlink. Check with `ls ~/.claude/plugins/cache/thedotmack/claude-mem/`.

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable claude-mem-worker
systemctl --user start claude-mem-worker
systemctl --user status claude-mem-worker
```

### Create launchd plist (macOS)

Create `~/Library/LaunchAgents/com.claude-mem.worker.plist`:

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

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.claude-mem.worker.plist
```

## Phase 5: Rebuild Container

The container image doesn't need rebuilding — the MCP server scripts are bind-mounted from the host. But you do need to rebuild if the agent-runner source changed:

```bash
./container/build.sh
```

Then restart NanoClaw:

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 6: Verify

### Health check

Check the worker is running:

```bash
curl -s http://localhost:37777/health
```

Should return a JSON response.

### Docker bridge connectivity

From a test container, verify the host is reachable:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway alpine wget -qO- http://host.docker.internal:37777/health
```

### Test message

Send a message to any registered channel mentioning the assistant. The agent should have access to memory tools (`mcp__mcp-search__*`). Check the container logs:

```bash
tail -f logs/nanoclaw.log
```

Look for MCP server registration messages indicating `mcp-search` was loaded.

## Troubleshooting

### Agent doesn't have memory tools

1. Check claude-mem is installed: `ls ~/.claude/plugins/cache/thedotmack/claude-mem/*/scripts/mcp-server.cjs`
2. Check worker is running: `curl http://localhost:37777/health`
3. Check container logs for MCP registration errors
4. Rebuild container: `./container/build.sh`

### Worker not reachable from containers

1. Verify worker binds to `0.0.0.0`: check `~/.claude-mem/settings.json`
2. Test Docker bridge: `docker run --rm --add-host=host.docker.internal:host-gateway alpine wget -qO- http://host.docker.internal:37777/health`
3. Check firewall rules (port 37777 must be accessible from Docker bridge network)

### Memory not persisting

1. Check worker logs: `journalctl --user -u claude-mem-worker` (Linux) or `/tmp/claude-mem-worker.err` (macOS)
2. Verify the database exists: `ls ~/.claude-mem/`
3. Check per-group isolation: each group folder maps to a separate `CLAUDE_MEM_PROJECT`

## Architecture

```
Host Machine                          Docker Container
┌─────────────────────┐               ┌─────────────────────┐
│ claude-mem worker    │               │ agent-runner         │
│ (port 37777)         │◄──────────────│                     │
│                      │  HTTP via     │ mcp-server.cjs      │
│ ~/.claude-mem/db     │  host.docker  │ (MCP stdio server)  │
│                      │  .internal    │                     │
│ ~/.claude/plugins/   │               │ /opt/claude-mem/    │
│   cache/thedotmack/  │──mount(ro)──→│   scripts/          │
│   claude-mem/v/      │               │                     │
│   scripts/           │               │                     │
└─────────────────────┘               └─────────────────────┘
```

## Known Limitations

- **Host-only worker** — The claude-mem worker runs on the host machine, not in containers. It cannot be containerized because it needs persistent database access.
- **Single-node only** — The worker binds to one host. Multi-node NanoClaw setups would need a shared worker or database.
- **Plugin version tracking** — `findClaudeMemScripts()` picks the lexicographically last version directory. If the plugin cache has multiple versions, it always uses the latest alphabetically (which should be the newest semver).
- **No automatic cleanup** — Observations accumulate indefinitely. Manual database pruning may be needed for long-running installations.
