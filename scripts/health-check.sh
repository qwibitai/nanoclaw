#!/bin/bash
# NanoClaw Health Check — runs every 5 minutes via cron
# Checks critical services and alerts Scott via Signal if any are down.
# Sends alerts via signal-cli's JSON-RPC TCP socket (no JVM spawn).

# Ensure systemd user bus is available (needed when running from cron)
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

ALERT_STATE_DIR="/tmp/nanoclaw-health"
SIGNAL_RPC_HOST="127.0.0.1"
SIGNAL_RPC_PORT="7583"
SCOTT_JID="198c1cdb-8856-4ac7-9b84-a504a0017c79"

mkdir -p "$ALERT_STATE_DIR"

send_alert() {
  local service="$1"
  local message="$2"
  local state_file="$ALERT_STATE_DIR/$service"

  # Only alert once per issue (don't spam on repeated failures)
  if [ -f "$state_file" ]; then
    return
  fi

  touch "$state_file"
  # Send via JSON-RPC TCP socket — reuses the running signal-cli daemon
  local payload
  payload=$(printf '{"jsonrpc":"2.0","method":"send","id":%d,"params":{"recipients":["%s"],"message":"%s"}}' \
    "$(date +%s)" "$SCOTT_JID" "$message")
  echo "$payload" | timeout 5 nc -q1 "$SIGNAL_RPC_HOST" "$SIGNAL_RPC_PORT" >/dev/null 2>&1 || true
}

clear_alert() {
  local service="$1"
  local state_file="$ALERT_STATE_DIR/$service"

  if [ -f "$state_file" ]; then
    rm "$state_file"
    # Notify recovery via JSON-RPC
    local message="✅ $service recovered"
    local payload
    payload=$(printf '{"jsonrpc":"2.0","method":"send","id":%d,"params":{"recipients":["%s"],"message":"%s"}}' \
      "$(date +%s)" "$SCOTT_JID" "$message")
    echo "$payload" | timeout 5 nc -q1 "$SIGNAL_RPC_HOST" "$SIGNAL_RPC_PORT" >/dev/null 2>&1 || true
  fi
}

# --- Check MCP server (localhost) ---
if curl -s --max-time 5 http://localhost:3002/health | grep -q '"status":"ok"'; then
  clear_alert "mcp-server"
else
  send_alert "mcp-server" "⚠️ MCP server is down — port 3002 not responding. Run: systemctl --user restart nanoclaw"
fi

# --- Check Cloudflare tunnel (public) ---
if curl -s --max-time 10 https://mcp.jorgenclaw.ai/health | grep -q '"status":"ok"'; then
  clear_alert "cloudflare-tunnel"
else
  send_alert "cloudflare-tunnel" "⚠️ Cloudflare tunnel is down — mcp.jorgenclaw.ai not reachable. Run: systemctl --user restart cloudflared"
fi

# --- Check Proton Bridge (IMAP) ---
if nc -z 127.0.0.1 1143 2>/dev/null; then
  clear_alert "proton-bridge"
else
  send_alert "proton-bridge" "⚠️ Proton Bridge is down — IMAP port 1143 not responding. Run: systemctl --user restart proton-bridge"
fi

# --- Check nostr-signer daemon ---
SIGNER_SOCKET="${XDG_RUNTIME_DIR:-/run/user/1000}/nostr-signer.sock"
if [ -S "$SIGNER_SOCKET" ]; then
  clear_alert "nostr-signer"
else
  send_alert "nostr-signer" "⚠️ Nostr signer daemon is down — socket missing. Run: systemctl --user restart nostr-signer"
fi

# --- Check NanoClaw service ---
if systemctl --user is-active nanoclaw >/dev/null 2>&1; then
  clear_alert "nanoclaw"
else
  send_alert "nanoclaw" "⚠️ NanoClaw service is down. Run: systemctl --user restart nanoclaw"
fi
