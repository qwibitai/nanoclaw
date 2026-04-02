#!/bin/bash
# NanoClaw Watchdog — runs every 60s via launchd
# Checks: NanoClaw process alive, no stuck containers, service healthy
# Restarts if needed, logs all actions

LOG="/Users/freddyk/github/nanoclaw/logs/watchdog.log"
NANOCLAW_LOG="/Users/freddyk/github/nanoclaw/logs/nanoclaw.log"
MAX_CONTAINER_AGE_SECONDS=3600  # Kill containers older than 1 hour

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"
}

# 1. Check if NanoClaw process is running
NANOCLAW_PID=$(launchctl list | grep "com.nanoclaw$" | awk '{print $1}')
if [ -z "$NANOCLAW_PID" ] || [ "$NANOCLAW_PID" = "-" ]; then
  log "ALERT: NanoClaw not running — restarting"
  launchctl kickstart gui/$(id -u)/com.nanoclaw 2>/dev/null
  sleep 5
  NEW_PID=$(launchctl list | grep "com.nanoclaw$" | awk '{print $1}')
  if [ -z "$NEW_PID" ] || [ "$NEW_PID" = "-" ]; then
    log "ERROR: Failed to restart NanoClaw"
  else
    log "OK: NanoClaw restarted (PID $NEW_PID)"
  fi
  exit 0
fi

# 2. Check if NanoClaw process is responsive (log updated in last 5 minutes)
if [ -f "$NANOCLAW_LOG" ]; then
  LAST_MOD=$(stat -f %m "$NANOCLAW_LOG" 2>/dev/null)
  NOW=$(date +%s)
  AGE=$(( NOW - LAST_MOD ))
  if [ "$AGE" -gt 300 ]; then
    log "WARN: NanoClaw log stale (${AGE}s since last write)"
  fi
fi

# 3. Check for stuck containers (running > MAX_CONTAINER_AGE_SECONDS)
if command -v container &>/dev/null; then
  STUCK=$(container ls --format json 2>/dev/null | /usr/local/bin/node -e "
    const now = Date.now() / 1000;
    const max = $MAX_CONTAINER_AGE_SECONDS;
    const APPLE_EPOCH_OFFSET = 978307200; // Apple epoch (2001-01-01) to Unix epoch
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    d.filter(c => c.configuration.id.startsWith('nanoclaw-') && c.status === 'running')
      .filter(c => {
        const startUnix = c.startedDate + APPLE_EPOCH_OFFSET;
        return (now - startUnix) > max;
      })
      .forEach(c => {
        const age = Math.round(now - (c.startedDate + APPLE_EPOCH_OFFSET));
        console.log(c.configuration.id + '|' + age + 's');
      });
  " 2>/dev/null)

  if [ -n "$STUCK" ]; then
    while IFS='|' read -r name age; do
      log "ALERT: Killing stuck container $name (age: ${age})"
      container stop "$name" &>/dev/null &
    done <<< "$STUCK"
  fi
fi

# 4. Check credential proxy is reachable
if ! curl -s --max-time 2 http://127.0.0.1:3001/ >/dev/null 2>&1; then
  # Proxy might just reject the request (no valid route) — that's fine
  # Only worry if connection refused
  if ! curl -s --max-time 2 --connect-timeout 1 http://127.0.0.1:3001/ 2>&1 | grep -q "Connection refused"; then
    : # proxy is up (returned something)
  else
    log "WARN: Credential proxy not reachable on port 3001"
  fi
fi
