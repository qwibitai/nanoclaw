---
name: container-test
description: "Build and test the NanoClaw container pipeline. Use when testing container changes, debugging agent-runner, or verifying the container build. Trigger on 'test container', 'container test', 'build container', 'debug container'."
---

# NanoClaw Container Build & Test

## 1. Build

Standard build:

```bash
cd /Users/tomerhamam/personal/projects/claw/nanoclaw/container && ./build.sh
```

Or directly:

```bash
docker build -t nanoclaw-agent:latest /Users/tomerhamam/personal/projects/claw/nanoclaw/container
```

## 2. Clean Build (if cached layers are stale)

BuildKit caches COPY steps even with `--no-cache`. To force a truly clean rebuild:

```bash
docker builder prune -f && cd /Users/tomerhamam/personal/projects/claw/nanoclaw/container && ./build.sh
```

## 3. Test Query

Send a test message through the full pipeline:

```bash
echo '{"prompt":"Hello, test","session_id":"test-session","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
docker run --rm -i -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" nanoclaw-agent:latest
```

For a test with OAuth token instead:

```bash
echo '{"prompt":"Hello, test","session_id":"test-session","groupFolder":"test","chatJid":"test@g.us","isMain":false,"secrets":{"CLAUDE_CODE_OAUTH_TOKEN":"'$CLAUDE_CODE_OAUTH_TOKEN'"}}' | \
docker run --rm -i nanoclaw-agent:latest
```

## 4. Validate Output

Look for sentinel markers in stdout. Valid output looks like:

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"The agent's response text","newSessionId":"abc123"}
---NANOCLAW_OUTPUT_END---
```

Extract JSON between the markers. The `status` field should be `"success"` or `"error"`. The `result` field contains the agent's response text. `newSessionId` is present when a new session was created.

Multiple marker pairs may appear (streaming mode) -- each one is a separate output chunk.

## 5. Common Failures

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| No output at all | HOME is not `/home/node`, entrypoint fails to compile agent-runner | Check Dockerfile USER and HOME, check `npx tsc` output in stderr |
| Partial output / no sentinel markers | Agent-runner stdout writing is broken | Check `container/agent-runner/src/index.ts` -- must write markers around JSON |
| Permission errors | Container not running as `node` user, or mount permissions wrong | Check `USER node` in Dockerfile, check host directory ownership |
| Stale code in container | BuildKit cache serving old COPY layers | Run `docker builder prune -f` then rebuild |
| `Cannot find module` errors | Per-group agent-runner copy is outdated | Delete `data/sessions/{folder}/agent-runner-src/` and re-run |
| TypeScript compilation errors | Agent-runner source has syntax errors | Check stderr for `tsc` output, fix source in `container/agent-runner/src/` |
| Container exits immediately (code 1) | Missing required input fields or auth token | Verify stdin JSON has `prompt`, `groupFolder`, `chatJid`, `isMain` fields |

## 6. IPC Test

To test IPC message delivery, mount a local directory and check for JSON files:

```bash
mkdir -p /tmp/nanoclaw-ipc-test/messages /tmp/nanoclaw-ipc-test/tasks /tmp/nanoclaw-ipc-test/input

echo '{"prompt":"Send a message to the group saying hello","session_id":"test-ipc","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
docker run --rm -i \
  -v /tmp/nanoclaw-ipc-test:/workspace/ipc \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  nanoclaw-agent:latest

# Check for IPC message files
ls -la /tmp/nanoclaw-ipc-test/messages/
cat /tmp/nanoclaw-ipc-test/messages/*.json 2>/dev/null
```

## 7. Interactive Debugging

To shell into the container for inspection:

```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

Inside the container, check:

```bash
whoami              # Should be: node
echo $HOME          # Should be: /home/node
ls /app/            # Agent-runner source and entrypoint.sh
ls /workspace/      # group/, global/, extra/, ipc/
which claude        # Should resolve to globally installed claude-code
```
