# NanoClaw Debug Checklist

## Known Issues (2026-02-08)

### 1. [FIXED] Resume branches from stale tree position
When agent teams spawns subagent CLI processes, they write to the same session JSONL. On subsequent `query()` resumes, the CLI reads the JSONL but may pick a stale branch tip (from before the subagent activity), causing the agent's response to land on a branch the host never receives a `result` for. **Fix**: pass `resumeSessionAt` with the last assistant message UUID to explicitly anchor each resume.

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT (both 30 min)
Both timers fire at the same time, so containers always exit via hard SIGKILL (code 137) instead of graceful `_close` sentinel shutdown. The idle timeout should be shorter (e.g., 5 min) so containers wind down between messages, while container timeout stays at 30 min as a safety net for stuck agents.

### 3. Cursor advanced before agent succeeds
`processGroupMessages` advances `lastAgentTimestamp` before the agent runs. If the container times out, retries find no messages (cursor already past them). Messages are permanently lost on timeout.

## Quick Status Check

```bash
# 1. Is the service running?
launchctl list | grep nanoclaw
# Expected: PID  0  com.nanoclaw (PID = running, "-" = not running, non-zero exit = crashed)

# 2. Any running containers?
container ls --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 3. Any stopped/orphaned containers?
container ls -a --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 4. Recent errors in service log?
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 5. Is WhatsApp connected? (look for last connection event)
grep -E 'Connected to WhatsApp|Connection closed|connection.*close' logs/nanoclaw.log | tail -5

# 6. Are groups loaded?
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## Session Transcript Branching

```bash
# Check for concurrent CLI processes in session debug logs
ls -la data/sessions/<group>/.claude/debug/

# Count unique SDK processes that handled messages
# Each .txt file = one CLI subprocess. Multiple = concurrent queries.

# Check parentUuid branching in transcript
python3 -c "
import json, sys
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except: pass
"
```

## Container Timeout Investigation

```bash
# Check for recent timeouts
grep -E 'Container timeout|timed out' logs/nanoclaw.log | tail -10

# Check container log files for the timed-out container
ls -lt groups/*/logs/container-*.log | head -10

# Read the most recent container log (replace path)
cat groups/<group>/logs/container-<timestamp>.log

# Check if retries were scheduled and what happened
grep -E 'Scheduling retry|retry|Max retries' logs/nanoclaw.log | tail -10
```

## Agent Not Responding

```bash
# Check if messages are being received from WhatsApp
grep 'New messages' logs/nanoclaw.log | tail -10

# Check if messages are being processed (container spawned)
grep -E 'Processing messages|Spawning container' logs/nanoclaw.log | tail -10

# Check if messages are being piped to active container
grep -E 'Piped messages|sendMessage' logs/nanoclaw.log | tail -10

# Check the queue state — any active containers?
grep -E 'Starting container|Container active|concurrency limit' logs/nanoclaw.log | tail -10

# Check lastAgentTimestamp vs latest message timestamp
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## Container Mount Issues

```bash
# Check mount validation logs (shows on container spawn)
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/nanoclaw.log | tail -10

# Verify the mount allowlist is readable
cat ~/.config/nanoclaw/mount-allowlist.json

# Check group's container_config in DB
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"

# Test-run a container to check mounts (dry run)
# Replace <group-folder> with the group's folder name
container run -i --rm --entrypoint ls nanoclaw-agent:latest /workspace/extra/
```

## WhatsApp Auth Issues

```bash
# Check if QR code was requested (means auth expired)
grep 'QR\|authentication required\|qr' logs/nanoclaw.log | tail -5

# Check auth files exist
ls -la store/auth/

# Re-authenticate if needed
npm run auth
```

## Service Management

```bash
# Restart the service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# View live logs
tail -f logs/nanoclaw.log

# Stop the service (careful — running containers are detached, not killed)
launchctl bootout gui/$(id -u)/com.nanoclaw

# Start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# Rebuild after code changes
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## vLLM as Anthropic-Compatible Backend

NanoClaw can use [vLLM](https://github.com/vllm-project/vllm)'s Anthropic-compatible `/v1/messages` endpoint instead of the Anthropic API. Set `ANTHROPIC_BASE_URL` to point at your vLLM instance and use `--served-model-name` to match the model name NanoClaw expects.

### Tool Calls Not Working (Raw XML in Response)

**Symptom**: Agent receives tool call markup as plain text instead of structured tool calls. Container logs show `tool_calls: []` (empty) even though the response contains `<function=Bash>` or `<tool_call>` blocks.

**Cause**: Wrong `--tool-call-parser`. Each model family uses a different tool call format:

| Model | Parser |
|-------|--------|
| Qwen3.5 (MoE, e.g. `Qwen3.5-35B-A3B`) | `qwen3_xml` |
| Qwen2.5 / Qwen3 (dense) | `hermes` |
| Llama / Mistral | `hermes` |

**Fix**: Restart vLLM with the correct parser:

```bash
# Example for Qwen3.5:
--enable-auto-tool-choice --tool-call-parser qwen3_xml
```

### Tool Calls Detected but `command` Parameter Missing (Streaming Bug)

**Symptom**: `stop_reason: tool_use` is correct, but the agent SDK reports:

```
InputValidationError: Bash failed: required parameter 'command' is missing
```

The container crashes (exit code 1) and the user receives no response.

**Cause**: A bug in vLLM's Anthropic streaming converter (`vllm/entrypoints/anthropic/serving.py`). The `qwen3_xml` parser sets `tool_call.id` on every streaming delta (not just the first one). The converter's `message_stream_converter()` interprets each delta with an `id` as a **new** tool call, creating a new `content_block_start` for each chunk. The first block gets `name="Bash"` with `input: {}` (empty), then immediately closes. The actual `{"command": "..."}` fragments end up in subsequent orphaned blocks that the SDK ignores.

**Affected versions**: vLLM 0.16.x with `--tool-call-parser qwen3_xml` and streaming enabled (which NanoClaw always uses).

**Fix**: Patch `message_stream_converter()` in the vLLM installation to track the current tool call ID and only create a new content block when the ID actually changes:

```python
# File: vllm/entrypoints/anthropic/serving.py
# In message_stream_converter(), find the variable initialization block:

            content_block_index = 0
            content_block_started = False
            current_tool_call_id = None          # ← ADD THIS LINE

# Then find this condition (in the tool_calls handling):

                            if tool_call.id is not None:

# Replace with:

                            if tool_call.id is not None and tool_call.id != current_tool_call_id:
                                current_tool_call_id = tool_call.id
```

This ensures continuation deltas (which carry the same `id`) are correctly appended to the existing content block instead of spawning new ones.

**Applying the patch inside a running container**:

```bash
docker exec <vllm-container> python3 -c "
with open('/usr/local/lib/python3.12/dist-packages/vllm/entrypoints/anthropic/serving.py', 'r') as f:
    content = f.read()

content = content.replace(
    'content_block_index = 0\n            content_block_started = False',
    'content_block_index = 0\n            content_block_started = False\n            current_tool_call_id = None'
)
content = content.replace(
    'if tool_call.id is not None:',
    'if tool_call.id is not None and tool_call.id != current_tool_call_id:\n                                current_tool_call_id = tool_call.id'
)

with open('/usr/local/lib/python3.12/dist-packages/vllm/entrypoints/anthropic/serving.py', 'w') as f:
    f.write(content)
print('Patch applied')
"
docker restart <vllm-container>
```

**Verification**: After patching, a streaming tool call should show exactly one `content_block_start` of type `tool_use` followed by multiple `input_json_delta` events on the same block index:

```bash
curl -s -N http://localhost:8088/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-name",
    "max_tokens": 200,
    "stream": true,
    "tools": [{"name":"Bash","description":"Run bash","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}],
    "messages": [{"role":"user","content":"Run: echo hello"}]
  }'
# Expected: one content_block_start with tool_use, then input_json_delta chunks
# building up {"command": "echo hello"}, all on the same index.
```
