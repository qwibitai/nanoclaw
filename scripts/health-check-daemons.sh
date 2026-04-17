#!/bin/bash
# Host daemon health check — writes JSON for container agent to read
# Run as oneshot via systemd timer, exits cleanly after each run

STATUS_FILE="$HOME/NanoClaw/groups/main/status/host-services.json"
mkdir -p "$(dirname "$STATUS_FILE")"

check_service() {
  local name="$1"
  local unit="$2"
  local status pid
  status=$(systemctl --user is-active "$unit" 2>/dev/null | head -1 || echo "inactive")
  pid=$(systemctl --user show "$unit" --property=MainPID --value 2>/dev/null || echo "0")
  echo "\"$name\": {\"status\": \"$status\", \"pid\": $pid}"
}

UPDATED=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$STATUS_FILE" << EOF
{
  "updated": "$UPDATED",
  "services": {
    $(check_service "signal-cli" "signal-cli"),
    $(check_service "nanoclaw" "nanoclaw"),
    $(check_service "nostr-signer" "nostr-signer"),
    $(check_service "radicale" "radicale"),
    $(check_service "badge-claim-listener" "badge-claim-listener"),
    $(check_service "cloudflared" "cloudflared")
  }
}
EOF
