#!/usr/bin/env bash
# End-to-end test: verify a container agent can reach the host Chrome via CDP.
#
# Usage:
#   ./scripts/test-host-browser.sh
#
# Prerequisites:
#   - Host browser running (./scripts/start-host-browser.sh)
#   - Container image built (./container/build.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CDP_URL_FILE="$HOME/.nanoclaw/cdp-url"
RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "=== Host Browser CDP Test ==="
echo ""

# Step 1: Check CDP URL file exists
echo "1. Checking CDP URL file..."
if [[ ! -f "$CDP_URL_FILE" ]]; then
  echo "   FAIL: $CDP_URL_FILE not found"
  echo "   Start the host browser: ./scripts/start-host-browser.sh"
  exit 1
fi

CDP_URL=$(cat "$CDP_URL_FILE")
if [[ ! "$CDP_URL" =~ ^ws:// ]]; then
  echo "   FAIL: Invalid CDP URL in file: $CDP_URL"
  exit 1
fi

# Extract port from ws://127.0.0.1:PORT/...
PORT=$(echo "$CDP_URL" | sed -E 's|^ws://[^:]+:([0-9]+)/.*|\1|')
echo "   OK: CDP URL found (port $PORT)"
echo ""

# Step 2: Verify host browser is reachable
echo "2. Checking host browser is running..."
if ! curl -s --connect-timeout 3 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then
  echo "   FAIL: Host browser not responding on port $PORT"
  echo "   Restart: ./scripts/start-host-browser.sh"
  exit 1
fi
VERSION=$(curl -s "http://127.0.0.1:$PORT/json/version" | grep -o '"Browser"[^,]*' | head -1)
echo "   OK: $VERSION"
echo ""

# Step 3: Determine gateway for container
if [[ "$RUNTIME" == "container" ]]; then
  GATEWAY="192.168.64.1"
else
  GATEWAY="host.docker.internal"
fi

echo "3. Container runtime: $RUNTIME (gateway: $GATEWAY)"
echo ""

# Rewrite URL for container access
CONTAINER_CDP_URL=$(echo "$CDP_URL" | sed -E "s|^ws://[^:]+:|ws://${GATEWAY}:|")

# Build runtime-specific args
EXTRA_ARGS=()
if [[ "$RUNTIME" != "container" ]] && [[ "$(uname -s)" == "Linux" ]]; then
  EXTRA_ARGS=(--add-host=host.docker.internal:host-gateway)
fi

# Step 4: Run agent-browser snapshot inside a container
echo "4. Testing agent-browser from inside container..."
echo ""

CONTAINER_NAME="nanoclaw-browser-test-$$"

TEST_SCRIPT="
set -e
echo '  Running: agent-browser --cdp \"$CONTAINER_CDP_URL\" snapshot'
agent-browser-real --cdp '$CONTAINER_CDP_URL' open 'https://example.com' 2>&1
TITLE=\$(agent-browser-real --cdp '$CONTAINER_CDP_URL' get title 2>&1)
echo \"  Title: \$TITLE\"
echo 'BROWSER_TEST_PASSED'
"

RESULT=$($RUNTIME run -i --rm \
  --name "$CONTAINER_NAME" \
  -e "NODE_OPTIONS=--dns-result-order=ipv4first" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
  --entrypoint /bin/bash \
  nanoclaw-agent:latest \
  -c "$TEST_SCRIPT" 2>&1) || true

echo "$RESULT"
echo ""

if echo "$RESULT" | grep -q "BROWSER_TEST_PASSED"; then
  echo "=== TEST PASSED ==="
  echo ""
  echo "Container agents can reach the host browser via CDP."
  echo ""
  if ! grep -q 'HOST_BROWSER_CDP_ENABLED=true' "$PROJECT_ROOT/.env" 2>/dev/null; then
    echo "To enable for NanoClaw, add to .env:"
    echo "  HOST_BROWSER_CDP_ENABLED=true"
  fi
else
  echo "=== TEST FAILED ==="
  echo ""
  echo "Troubleshooting:"
  echo "  1. Is the host browser running? ./scripts/start-host-browser.sh"
  echo "  2. Is the container image built? ./container/build.sh"
  echo "  3. Can the container reach the host?"
  echo "     Try: $RUNTIME run --rm --entrypoint curl nanoclaw-agent:latest -s http://$GATEWAY:$PORT/json/version"
  exit 1
fi
