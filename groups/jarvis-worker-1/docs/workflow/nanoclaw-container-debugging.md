# NanoClaw Container Debugging Workflow

Step-by-step workflow for debugging container issues.

## Quick Diagnostic

Run this first to identify the issue category:

```bash
echo "=== NanoClaw Container Diagnostic ==="

echo -e "\n1. Auth configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING"

echo -e "\n2. Container runtime?"
docker info &>/dev/null && echo "OK" || echo "NOT RUNNING"

echo -e "\n3. Container image?"
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n4. Session mount path?"
grep -q "/home/node/.claude" src/container-runner.ts && echo "OK" || echo "WRONG"

echo -e "\n5. Recent logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -1 && tail -20 "$(ls -t groups/*/logs/container-*.log | head -1)" 2>/dev/null || echo "No logs"
```

## Issue Categories

| Symptom | Section |
|---------|---------|
| "Claude Code process exited with code 1" | #1-authentication |
| Env vars not passing | #2-environment-variables |
| Mount errors | #3-mount-issues |
| Permission denied | #4-permission-issues |
| Session not resuming | #5-session-issues |
| MCP server failures | #6-mcp-failures |

---

## 1. Authentication Issues

**Error:** `Invalid API key · Please run /login`

**Check:**

```bash
cat .env | grep -E "(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)"
```

**Fix:** Add valid token to `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  # subscription
# OR
ANTHROPIC_API_KEY=sk-ant-api03-...        # pay-per-use
```

---

## 2. Environment Variables

**Issue:** Environment variables lost in container

**Verify env vars reach container:**

```bash
echo '{}' | docker run -i \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "OAuth: ${#CLAUDE_CODE_OAUTH_TOKEN} chars"'
```

---

## 3. Mount Issues

**Check mounted contents:**

```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

**Expected structure:**

```
/workspace/
├── env-dir/env       # Auth vars
├── group/            # Group folder
├── project/          # Project root (main only)
├── ipc/              # IPC files
│   ├── messages/
│   └── tasks/
└── extra/            # Custom mounts
```

---

## 4. Permission Issues

**Check container user:**

```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'whoami; ls -la /workspace/ /app/'
```

Container runs as `node` (uid 1000). All `/workspace/` and `/app/` should be owned by `node`.

---

## 5. Session Resumption Issues

**Error:** New session ID every message, or exit code 1 on resume

**Root cause:** Sessions mounted to `/root/.claude/` instead of `/home/node/.claude/`

**Verify mount path:**

```bash
grep -A3 "Claude sessions" src/container-runner.ts
```

**Fix in container-runner.ts:**

```typescript
mounts.push({
  hostPath: claudeDir,
  containerPath: '/home/node/.claude',  // NOT /root/.claude
  readonly: false
});
```

**Verify sessions accessible:**

```bash
docker run --rm --entrypoint /bin/bash \
  -v ~/.claude:/home/node/.claude \
  nanoclaw-agent:latest -c 'ls -la $HOME/.claude/projects/'
```

---

## 6. MCP Failures

Check container logs for MCP initialization errors. MCP servers must be properly configured in the container.

---

## Log Locations

| Log | Path |
|-----|------|
| Main app | `logs/nanoclaw.log` |
| Main errors | `logs/nanoclaw.error.log` |
| Container runs | `groups/{folder}/logs/container-*.log` |

**Enable debug logging:**

```bash
LOG_LEVEL=debug npm run dev
```

---

## Manual Testing

**Test full agent flow:**

```bash
mkdir -p data/env groups/test
cp .env data/env/env

echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  docker run -i \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc \
  nanoclaw-agent:latest
```

**Test Claude Code directly:**

```bash
docker run --rm --entrypoint /bin/bash \
  -v $(pwd)/data/env:/workspace/env-dir:ro \
  nanoclaw-agent:latest -c '
  export $(cat /workspace/env-dir/env | xargs)
  claude -p "Say hello" --dangerously-skip-permissions --allowedTools ""
  '
```

**Interactive shell:**

```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

---

## Rebuild

```bash
npm run build
./container/build.sh

# Or force clean rebuild
docker builder prune -af
./container/build.sh
```

---

## IPC Debugging

```bash
# Check pending messages
ls -la data/ipc/messages/

# Check pending tasks
ls -la data/ipc/tasks/

# Read IPC file
cat data/ipc/messages/*.json

# Check available groups (main only)
cat data/ipc/main/available_groups.json
```

---

## Session Management

**Clear sessions:**

```bash
# All groups
rm -rf data/sessions/

# Specific group
rm -rf data/sessions/{groupFolder}/.claude/

# Also clear from SQLite
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
```

**Verify resumption:**

```bash
grep "Session initialized" logs/nanoclaw.log | tail -5
# Same session ID = working
```
