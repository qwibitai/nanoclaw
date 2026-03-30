# NanoClaw Debug Checklist

## Known Issues (2026-02-08)

### 1. [FIXED] Resume branches from stale tree position
When agent teams spawns subagent CLI processes, they write to the same session JSONL. On subsequent `query()` resumes, the CLI reads the JSONL but may pick a stale branch tip (from before the subagent activity), causing the agent's response to land on a branch the host never receives a `result` for. **Fix**: pass `resumeSessionAt` with the last assistant message UUID to explicitly anchor each resume.

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT (both 30 min)
Both timers fire at the same time, so containers always exit via hard SIGKILL (code 137) instead of graceful `_close` sentinel shutdown. The idle timeout should be shorter (e.g., 5 min) so containers wind down between messages, while container timeout stays at 30 min as a safety net for stuck agents.

### 3. Cursor advanced before agent succeeds
`processGroupMessages` advances `lastAgentTimestamp` before the agent runs. If the container times out, retries find no messages (cursor already past them). Messages are permanently lost on timeout.

### 4. Kubernetes image garbage collection deletes nanoclaw-agent image

**Symptoms**: `Container exited with code 125: pull access denied for nanoclaw-agent` — the container image disappears overnight or after a few hours, even though you just built it.

**Cause**: If your container runtime has Kubernetes enabled (Rancher Desktop enables it by default), the kubelet runs image garbage collection when disk usage exceeds 85%. NanoClaw containers are ephemeral (run and exit), so `nanoclaw-agent:latest` is never protected by a running container. The kubelet sees it as unused and deletes it — often overnight when no messages are being processed. Other images (docker-compose services) survive because they have long-running containers referencing them.

**Fix**: Disable Kubernetes if you don't need it:
```bash
# Rancher Desktop
rdctl set --kubernetes-enabled=false

# Then rebuild the container image
./container/build.sh
```

**Diagnosis**: Check the k3s log for image GC activity:
```bash
grep -i "nanoclaw" ~/Library/Logs/rancher-desktop/k3s.log
# Look for: "Removing image to free bytes" with the nanoclaw-agent image ID
```

Check NanoClaw logs for image status:
```bash
grep -E "image found|image NOT found|image missing" logs/nanoclaw.log
```

If you need Kubernetes enabled, set `CONTAINER_IMAGE` to an image stored in a registry that the kubelet won't GC, or raise the GC thresholds.

## Quick Status Check

```bash
# 1. Is the service running?
launchctl list | grep nanoclaw
# Expected: PID  0  com.nanoclaw (PID = running, "-" = not running, non-zero exit = crashed)

# 2. Any running containers?
docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 3. Any stopped/orphaned containers?
docker ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 4. Recent errors in service log?
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 5. Are channels connected? (look for last connection event)
grep -E 'Connected|Connection closed|connection.*close|channel.*ready' logs/nanoclaw.log | tail -5

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
# Check if messages are being received from channels
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
docker run -i --rm --entrypoint ls nanoclaw-agent:latest /workspace/extra/
```

## Linux: Container Cannot Reach Host Credential Proxy (iptables/UFW)

Symptom: messages are received but agent runs stall silently, especially on cloud Linux hosts with restrictive firewall defaults.

```bash
# Host check: proxy should be reachable locally
curl -sS http://localhost:3001/health || echo "host proxy unreachable"

# Container check: host proxy should be reachable from Docker bridge network
docker run --rm --network bridge curlimages/curl:8.8.0 \
  -sS http://host.docker.internal:3001/health || echo "container cannot reach host proxy"
```

If host works but container fails, check firewall rules:

```bash
# UFW status (if enabled)
sudo ufw status verbose

# iptables INPUT chain (look for blanket REJECT/DROP near the end)
sudo iptables -S INPUT
```

Allow Docker bridge subnet to reach the local proxy port:

```bash
# iptables: allow docker bridge -> host:3001
sudo iptables -I INPUT 1 -s 172.17.0.0/16 -p tcp --dport 3001 -j ACCEPT

# If UFW is enabled, allow bridge subnet explicitly
sudo ufw allow from 172.17.0.0/16 to any port 3001 proto tcp
```

Then re-run the container check:

```bash
docker run --rm --network bridge curlimages/curl:8.8.0 \
  -sS http://host.docker.internal:3001/health
```

After the network rule is fixed, restart NanoClaw with your service manager (`launchd`, `systemd`, `pm2`, etc.).

## Channel Auth Issues

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
