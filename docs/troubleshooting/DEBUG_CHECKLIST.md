# NanoClaw Debug Checklist
Use this file as the active operational checklist for Apple Container runtime debugging.

For the full runtime debug workflow, use:

- `docs/workflow/runtime/nanoclaw-container-debugging.md`
- `docs/workflow/runtime/nanoclaw-jarvis-debug-loop.md`

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

## Jarvis Ops Script Shortcuts

Use the script dispatcher for consistent debug/recovery/smoke flow:

```bash
# Health checks (runtime + auth + DB queue)
bash scripts/jarvis-ops.sh preflight

# Reliability triage (service/runtime/log/IPC)
bash scripts/jarvis-ops.sh reliability

# Current lane health and recent failure reasons
bash scripts/jarvis-ops.sh status

# End-to-end timeline for a lane/chat/run
bash scripts/jarvis-ops.sh trace --lane andy-developer

# Dispatch payload contract/session lint
bash scripts/jarvis-ops.sh dispatch-lint --file /tmp/dispatch.json --target-folder jarvis-worker-1

# DB schema/index/consistency checks
bash scripts/jarvis-ops.sh db-doctor

# Incident registry status
bash scripts/jarvis-ops.sh incident list --status open

# Manual incident creation (if you want to track before running bundle)
bash scripts/jarvis-ops.sh incident add --title "Andy not responding to hi" --lane andy-developer

# Attach verified cause/impact details after debugging
bash scripts/jarvis-ops.sh incident enrich --id <incident-id> --cause "<root cause>" --impact "<impact>" --next-action "<next step>"

# Active worker-lane probe dispatch (jarvis-worker-*)
bash scripts/jarvis-ops.sh probe

# Connectivity gate (preflight + probe + DB pass/fail checks)
bash scripts/jarvis-ops.sh verify-worker-connectivity

# Deterministic acceptance gate + evidence manifest
bash scripts/jarvis-ops.sh acceptance-gate

# Acceptance gate including user-facing happiness validation
bash scripts/jarvis-ops.sh acceptance-gate --include-happiness --happiness-user-confirmation "<manual User POV runbook completed>"

# Recurring issue hotspots (failure reasons + lane ranking)
bash scripts/jarvis-ops.sh hotspots --window-hours 72

# Capture incident artifact bundle for handoff
bash scripts/jarvis-ops.sh incident-bundle --window-minutes 180 --lane andy-developer

# Capture and append evidence to an existing tracked incident
bash scripts/jarvis-ops.sh incident-bundle --window-minutes 180 --lane andy-developer --incident-id <incident-id>

# Mark resolved only after explicit user confirmation
bash scripts/jarvis-ops.sh incident resolve --id <incident-id> --resolution "<exact fix>" --verification "<proof>" --fix-reference "<commit/pr>" --user-confirmed-fixed --user-confirmation "<user confirmed fixed>"

# Runtime/builder recovery and service restart
bash scripts/jarvis-ops.sh recover

# Worker image rebuild + end-to-end smoke gate (live DB by default)
bash scripts/jarvis-ops.sh smoke

# Isolated smoke mode (in-memory DB)
bash scripts/jarvis-ops.sh smoke --isolated-db

# Log summary and categorized live watch
bash scripts/jarvis-ops.sh watch --lines 120
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

## Buildkit Storage Corruption (`structure needs cleaning`)

**Root cause**: Apple Virtualization.framework has a known disk cache mode bug that can corrupt ext4 inside the builder VM. Combined with buildkit crashes during garbage collection, blob storage becomes unrecoverable.

Symptom patterns:

- `container logs buildkit` shows `structure needs cleaning`
- `content garbage collection failed` in builder logs
- Builds hang with no progress
- `.dockerignore: no such file or directory` errors (secondary symptom of degraded builder)

**Recovery** (automated in build scripts):

```bash
# 1) Check for corruption
container logs buildkit 2>&1 | grep "structure needs cleaning"

# 2) If found, destroy and recreate builder (cached layers are lost)
container stop buildkit 2>/dev/null || pkill -f buildkit
sleep 2
container rm buildkit
container builder start
sleep 3
container builder status  # should show RUNNING

# 3) Rebuild images (no cache, clean storage)
cd container && bash build.sh
cd container/worker && bash build.sh
```

**Prevention**:

| Strategy | Detail |
|----------|--------|
| `.dockerignore` in every build dir | Reduces context transfer, avoids triggering degraded build paths |
| Build scripts auto-detect corruption | `ensure_builder_healthy()` checks logs before build, auto-recovers |
| Keep builds on internal SSD | External storage increases Virtualization.framework corruption risk |
| Avoid concurrent heavy I/O builds | Serialise agent + worker builds to reduce VM disk pressure |
| Update Apple Container when available | Storage and builder fixes ship in newer versions |
