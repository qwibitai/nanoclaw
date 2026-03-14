# Intent: src/container-runner.ts modifications

## What changed
Added claude-mem MCP server discovery, volume mounting, and Docker host-gateway networking.

## Key sections

### Imports (top of file)
- Added: `HOME_DIR` from `./config.js` — needed by `findClaudeMemScripts()` to locate the plugin cache

### findClaudeMemScripts() (new function)
- Discovers the claude-mem plugin in `~/.claude/plugins/cache/thedotmack/claude-mem/`
- Finds the latest version by sorting version directories
- Returns the `scripts/` path if `mcp-server.cjs` exists, null otherwise
- This is a host-side discovery — the plugin is installed via Claude Code's plugin system

### buildVolumeMounts()
- Added optional claude-mem mount at the end of the function (after additionalMounts)
- Mounts `scripts/` directory read-only to `/opt/claude-mem/scripts` inside the container
- The agent-runner checks for `/opt/claude-mem/scripts/mcp-server.cjs` to conditionally start the MCP server
- Mount is skipped silently if claude-mem is not installed

### buildContainerArgs()
- Added `--add-host=host.docker.internal:host-gateway` flag
- This allows containers to reach the host's claude-mem worker via `host.docker.internal:37777`
- Placed before the timezone argument for clarity

## Invariants
- All existing volume mounts are preserved (project root, group, sessions, IPC, agent-runner, additional)
- claude-mem mount is always last — after all required mounts and validated additional mounts
- claude-mem mount is always read-only — containers cannot modify the plugin scripts
- `findClaudeMemScripts()` returns null gracefully when not installed (no errors, no warnings)
- The `--add-host` flag is harmless when claude-mem is not installed

## Design decisions

### Plugin cache discovery
The function traverses the Claude Code plugin cache directory structure (`~/.claude/plugins/cache/<org>/<plugin>/<version>/`). Version directories are sorted lexicographically to find the latest. This avoids hardcoding a version and automatically picks up updates when the plugin is upgraded.

### Read-only mount
The MCP server scripts are mounted read-only because:
1. Containers should never modify host plugin files
2. The scripts only need to be executed, not written to
3. Matches the security pattern of the project root mount

### Host-gateway networking
`--add-host=host.docker.internal:host-gateway` resolves to the host IP from inside Docker. The claude-mem worker listens on `0.0.0.0:37777` on the host. Inside the container, the MCP server connects to `host.docker.internal:37777`.

## Must-keep
- All existing imports and mount logic
- The claude-mem mount MUST be after additionalMounts (after validation)
- `findClaudeMemScripts()` must gracefully handle: missing directory, empty version list, missing mcp-server.cjs
- The `--add-host` flag in buildContainerArgs
