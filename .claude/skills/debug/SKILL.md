---
name: debug
description: Debug process agent issues. Use when things aren't working, agent process fails, authentication problems, or to understand how the process execution system works. Covers logs, environment variables, and common issues.
---

# NanoClaw Process Agent Debugging

This guide covers debugging the process-based agent execution system.

## Architecture Overview

```
Host (macOS/Linux)
─────────────────────────────────────────────────────────────
src/process-runner.ts
    │
    │ spawns Node.js subprocess
    │ (node container/agent-runner/dist/index.js)
    │ input JSON via stdin, secrets included
    │
    ├── NANOCLAW_GROUP_DIR ──> groups/{folder}/       (cwd)
    ├── NANOCLAW_IPC_DIR ────> data/ipc/{folder}/
    ├── NANOCLAW_GLOBAL_DIR ─> groups/global/
    └── HOME ────────────────> data/sessions/{folder}/ (isolated per-group)
```

**Important:** `HOME` is set per-group so each group's Claude sessions are stored at `data/sessions/{folder}/.claude/`, preventing cross-group access.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side messaging, routing, process spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Process run logs** | `groups/{folder}/logs/process-*.log` | Per-run: input, stderr, stdout |
| **Claude sessions** | `data/sessions/{folder}/.claude/` | Claude Code session history |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service (macOS), add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
# For systemd service (Linux), add to unit [Service] section:
# Environment=LOG_LEVEL=debug
```

Debug level shows:
- Full process environment configuration
- Process command arguments
- Real-time process stderr

## Common Issues

### 1. "Process agent exited with code 1"

**Check the process log file** in `groups/{folder}/logs/process-*.log`

Common causes:

#### Missing Authentication
```
Invalid API key · Please run /login
```
**Fix:** Ensure `.env` file exists with either OAuth token or API key:
```bash
cat .env  # Should show one of:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
```

### 2. Session Not Resuming / "Process agent exited with code 1"

If sessions aren't being resumed (new session ID every time), or the agent exits with code 1 when resuming:

**Root cause:** The SDK looks for sessions at `$HOME/.claude/projects/`. The process runner sets `HOME=data/sessions/{folder}`, so it looks at `data/sessions/{folder}/.claude/projects/`.

**Check the HOME path:**
```bash
# In process-runner.ts, verify buildEnv sets HOME correctly
grep "HOME:" src/process-runner.ts
```

**Verify sessions exist:**
```bash
ls -la data/sessions/{groupFolder}/.claude/projects/
```

**Fix:** Ensure `process-runner.ts` `buildEnv` sets `HOME` to `data/sessions/{folder}`:
```typescript
HOME: homeDir,  // path.join(DATA_DIR, 'sessions', group.folder)
```

### 3. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the process logs for MCP initialization errors.

### 4. Cursor Mode No Response

When messages get no reply after setting `AGENT_BACKEND=cursor` in `.env`:

1. **Verify backend is active**: Process log stderr should show `[agent-runner] AGENT_BACKEND=cursor`. If it shows `claude`, .env was not loaded correctly (restart the service and retry).
2. **Verify agent CLI is in PATH**: launchd PATH is `~/.local/bin:/usr/local/bin:/usr/bin:/bin`. If `agent` is installed elsewhere, add that path to the plist.
3. **Run with debug logging**: `LOG_LEVEL=debug npm run dev`, then send a message and check the main log for `agentBackend` and the process log stderr.

Manual test for cursor-runner:

```bash
mkdir -p groups/main data/ipc/main data/sessions/main

echo '{
  "prompt": "What is 1+1? Short answer.",
  "groupFolder": "main",
  "chatJid": "test",
  "isMain": true
}' | \
  NANOCLAW_GROUP_DIR=$(pwd)/groups/main \
  NANOCLAW_IPC_DIR=$(pwd)/data/ipc/main \
  NANOCLAW_GLOBAL_DIR=$(pwd)/groups/global \
  AGENT_BACKEND=cursor \
  node container/agent-runner/dist/index.js
```

If stderr shows `[cursor-runner]` and stdout has JSON wrapped in `---NANOCLAW_OUTPUT_START---`, the runner is working. Otherwise check that the Cursor `agent` CLI is available (`agent "hi" --print`). Authentication is handled by `agent login`; no `CURSOR_API_KEY` is required.

## Manual Process Testing

### Build the agent runner first:
```bash
ls container/agent-runner/dist/index.js || npm run build
```

### Test the full agent flow:
```bash
mkdir -p groups/test data/ipc/test data/sessions/test

echo '{
  "prompt": "What is 2+2?",
  "groupFolder": "test",
  "chatJid": "test@g.us",
  "isMain": false,
  "secrets": {"ANTHROPIC_API_KEY": "sk-ant-api03-..."}
}' | \
  NANOCLAW_GROUP_DIR=$(pwd)/groups/test \
  NANOCLAW_IPC_DIR=$(pwd)/data/ipc/test \
  NANOCLAW_GLOBAL_DIR=$(pwd)/groups/global \
  HOME=$(pwd)/data/sessions/test \
  node container/agent-runner/dist/index.js
```

## SDK Options Reference

The agent-runner uses these Claude Agent SDK options:

```typescript
query({
  prompt: input.prompt,
  options: {
    cwd: '/workspace/group',
    allowedTools: ['Bash', 'Read', 'Write', ...],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,  // Required with bypassPermissions
    settingSources: ['project'],
    mcpServers: { ... }
  }
})
```

**Important:** `allowDangerouslySkipPermissions: true` is required when using `permissionMode: 'bypassPermissions'`. Without it, the process exits with code 1.

## Rebuilding After Changes

```bash
# Rebuild main app and agent runner
npm run build
```

## Checking Agent Runner Build

```bash
# Check build output exists
ls -la container/agent-runner/dist/index.js

# Check Node.js version
node --version
```

## Session Persistence

Claude sessions are stored per-group in `data/sessions/{group}/.claude/` for security isolation. Each group has its own `HOME` directory, preventing cross-group access to conversation history.

**The `HOME` environment variable** is set to `data/sessions/{group}` so Claude Code automatically uses `data/sessions/{group}/.claude/` for sessions.

To clear sessions:

```bash
# Clear all sessions for all groups
rm -rf data/sessions/

# Clear sessions for a specific group
rm -rf data/sessions/{groupFolder}/.claude/

# Also clear the session ID from NanoClaw's tracking (stored in SQLite)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```

To verify session resumption is working, check the logs for the same session ID across messages:
```bash
grep "Session initialized" logs/nanoclaw.log | tail -5
# Should show the SAME session ID for consecutive messages in the same group
```

## IPC Debugging

The agent communicates back to the host via files in `data/ipc/{groupFolder}/`:

```bash
# Check pending messages
ls -la data/ipc/{groupFolder}/messages/

# Check pending task operations
ls -la data/ipc/{groupFolder}/tasks/

# Read a specific IPC file
cat data/ipc/{groupFolder}/messages/*.json

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{groupFolder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing messages
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of groups (main only)

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Process Agent Setup ==="

echo -e "\n1. Authentication configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env"

echo -e "\n2. Agent runner built?"
[ -f container/agent-runner/dist/index.js ] && echo "OK" || echo "MISSING - run npm run build"

echo -e "\n3. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n4. Recent process logs?"
ls -t groups/*/logs/process-*.log 2>/dev/null | head -3 || echo "No process logs yet"

echo -e "\n5. Session continuity working?"
SESSIONS=$(grep "Session initialized" logs/nanoclaw.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple different session IDs, may indicate resumption issues"
```
