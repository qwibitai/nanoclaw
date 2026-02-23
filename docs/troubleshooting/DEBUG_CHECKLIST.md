# NanoClaw Debug Checklist

## Known Issues (2026-02-08)

### 1. [FIXED] Resume branches from stale tree position
When agent teams spawns subagent CLI processes, they write to the same session JSONL. On subsequent `query()` resumes, the CLI reads the JSONL but may pick a stale branch tip (from before the subagent activity), causing the agent's response to land on a branch the host never receives a `result` for. **Fix**: pass `resumeSessionAt` with the last assistant message UUID to explicitly anchor each resume.

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT (both 30 min)
Both timers fire at the same time, so containers always exit via hard SIGKILL (code 137) instead of graceful `_close` sentinel shutdown. The idle timeout should be shorter (e.g., 5 min) so containers wind down between messages, while container timeout stays at 30 min as a safety net for stuck agents.

### 3. Cursor advanced before agent succeeds
`processGroupMessages` advances `lastAgentTimestamp` before the agent runs. If the container times out, retries find no messages (cursor already past them). Messages are permanently lost on timeout.

### 4. [FIXED 2026-02-22] Skill sync crash (`ERR_FS_CP_EINVAL`)
Symptom:

- Group receives messages but does not reply.
- Log shows:
  - `Agent error`
  - `src and dest cannot be the same .../.claude/skills/.docs`

Cause:

- Hidden skill metadata (for example `.docs`) from symlinked skill sources can create copy collisions during per-group skill staging.

Fix:

- Skill staging now skips hidden entries and guards against overlapping source/destination paths in `src/container-runner.ts`.
- Runtime now copies real skill files into `data/sessions/<group>/.claude/skills` (not symlink mount passthrough).

Verification:

1. `npm run build`
2. `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
3. confirm log shows `Spawning container agent` followed by `Message sent` without repeated `ERR_FS_CP_EINVAL`.

### 5. Claude subscription quota hit (model responds but task does not progress)
Symptom:

- Group replies with `You've hit your limit ...` (or equivalent quota text).

Cause:

- Upstream Claude account quota exhausted for the model configured in that group.

Action:

1. Verify response in `logs/nanoclaw.log` (`Agent output: You've hit your limit ...`).
2. Wait for reset or switch that group to an available model/runtime.
3. For worker execution lane, continue routing bounded tasks to OpenCode workers (`jarvis-worker-*`) via `andy-developer`.

### 6. [FIXED 2026-02-23] Duplicate running group containers
Symptom:

- Two `nanoclaw-andy-developer-*` (or same-group) containers appear as `running`.
- New runs may race with stale prior runs, causing unstable behavior.

Cause:

- Stop path did not always verify runtime-level container shutdown before new launch.
- Runtime could report inconsistent stop state without escalation.

Fix:

- Startup orphan cleanup now uses verified stop escalation (`stop` -> `stop SIGKILL` -> `kill` + running-state verification).
- Pre-launch cleanup now stops any already-running container with same group prefix before new spawn.
- Timeout shutdown now uses verified stop escalation and logs attempt history.

Verification:

1. `npm run build`
2. `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
3. Trigger one message in Andy lane.
4. Confirm only one running group container:
   `container ls -a | rg 'nanoclaw-andy-developer|nanoclaw-jarvis'`

## Quick Status Check

```bash
# 1. Is the service running?
launchctl list | grep nanoclaw
# Expected: PID  0  com.nanoclaw (PID = running, "-" = not running, non-zero exit = crashed)

# 2. Container state snapshot (running + stopped)
container ls -a | rg nanoclaw

# 3. Recent errors in service log?
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 4. Is WhatsApp connected? (look for last connection event)
grep -E 'Connected to WhatsApp|Connection closed|connection.*close' logs/nanoclaw.log | tail -5

# 5. Are groups loaded?
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## Duplicate Container Recovery (if runtime state is inconsistent)

```bash
# 1) Restart Apple Container services
/bin/zsh -lc "launchctl kickstart -k gui/$(id -u)/com.apple.container.apiserver && launchctl kickstart -k gui/$(id -u)/com.apple.container.container-runtime-linux.buildkit"

# 2) Ensure runtime is up
container system start

# 3) Restart NanoClaw
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 4) Re-check group container state
container ls -a | rg 'nanoclaw-andy-developer|nanoclaw-jarvis'
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

## Apple Container Builder Stuck / Hanging

Symptom patterns:
- `container build ...` shows `Dialing builder` for a long time
- `container builder stop` hangs
- `container system logs` shows `Connection invalid [uuid=buildkit]`

```bash
# 1) Confirm runtime and builder state
container system status
container builder status

# 2) Check recent builder/system logs
container system logs | tail -n 80
container logs buildkit | tail -n 80

# 3) If stop hangs, restart launchd services directly
/bin/zsh -lc "launchctl kickstart -k gui/$(id -u)/com.apple.container.container-runtime-linux.buildkit && launchctl kickstart -k gui/$(id -u)/com.apple.container.apiserver"

# 4) Bring services back and verify
container system start
container builder start
container system status
container builder status

# 5) Retry build from Dockerfile directory
cd container
container build -t nanoclaw-agent:latest .
```

To monitor progress reliably during build:

```bash
while true; do
  clear
  date
  container logs buildkit | tail -n 60
  sleep 2
done
```
