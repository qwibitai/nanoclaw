#!/bin/bash
# Diagnostic: probe the gmail-mcp inside a running NanoClaw container.
# Dumps OAuth state and runs a no-op API call to verify the MCP can talk
# to Google. Use when Telegram complains "Gmail tools are no longer available".
#
# Usage:
#   ./scripts/check-gmail-mcp.sh                      # auto-pick the first nanoclaw container
#   ./scripts/check-gmail-mcp.sh nanoclaw-telegram-main-1234567890

set -e

CONTAINER="${1:-}"
if [ -z "$CONTAINER" ]; then
  CONTAINER=$(docker ps --filter name=nanoclaw- --format '{{.Names}}' | head -1)
fi

if [ -z "$CONTAINER" ]; then
  echo "ERROR: no running nanoclaw containers found" >&2
  exit 1
fi

echo "=== Probing $CONTAINER ==="
echo

echo "--- /home/node/.gmail-mcp listing ---"
docker exec "$CONTAINER" sh -c 'ls -la /home/node/.gmail-mcp/ 2>&1' || echo "(directory missing inside container)"
echo

echo "--- credentials.json expiry (personal) ---"
docker exec "$CONTAINER" sh -c "
  if [ -f /home/node/.gmail-mcp/credentials.json ]; then
    node -e '
      const c = require(\"/home/node/.gmail-mcp/credentials.json\");
      const now = Date.now();
      const exp = c.expiry_date || 0;
      const minLeft = (exp - now) / 1000 / 60;
      console.log(\"expiry_date:\", exp);
      console.log(\"now:\", now);
      console.log(\"minutes_until_expiry:\", minLeft.toFixed(1));
      console.log(\"has_refresh_token:\", !!c.refresh_token);
      console.log(\"scope:\", c.scope || \"(none)\");
    '
  else
    echo '(credentials.json missing)'
  fi
" || true
echo

echo "--- Running gmail-mcp tool list (probe) ---"
echo "NOTE: this probes a FRESH gmail-mcp instance inside the container, not"
echo "      the long-running one currently serving the agent. A green probe"
echo "      here means 'the package + credentials + network are healthy,'"
echo "      but does NOT guarantee the wedged in-process MCP is fine."
echo "      If the probe is green but the agent still complains about Gmail"
echo "      tools being unavailable, send the agent a new message — the next"
echo "      container spawn will re-register tools with a fresh MCP process."
echo
docker exec "$CONTAINER" sh -c '
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}" \
    | timeout 10 npx -y @gongrzhe/server-gmail-autoauth-mcp 2>&1 \
    | head -50
' || echo "(probe failed — see error above)"
echo

echo "=== Done ==="
echo "If credentials.json is missing or expired, run: python3 scripts/refresh-gmail-tokens.py"
echo "If the tool-list probe failed, check the container logs:"
echo "  docker logs $CONTAINER 2>&1 | grep -i gmail | tail -30"
