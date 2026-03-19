#!/usr/bin/env bash
# Start a headed host Chrome browser via agent-browser for NanoClaw.
# Uses a persistent profile so login sessions survive restarts.
# Writes the CDP WebSocket URL to ~/.nanoclaw/cdp-url for the daemon to read.
#
# Prerequisites:
#   brew install agent-browser && agent-browser install
#   OR: npm install -g agent-browser && agent-browser install
#
# Usage:
#   ./scripts/start-host-browser.sh

set -euo pipefail

PROFILE_DIR="${NANOCLAW_BROWSER_PROFILE:-$HOME/.nanoclaw/host-browser-profile}"
CDP_URL_FILE="$HOME/.nanoclaw/cdp-url"

if ! command -v agent-browser &>/dev/null; then
  echo "ERROR: agent-browser not found." >&2
  echo "Install with one of:" >&2
  echo "  brew install agent-browser && agent-browser install" >&2
  echo "  npm install -g agent-browser && agent-browser install" >&2
  exit 1
fi

# Kill any existing agent-browser daemon
agent-browser close 2>/dev/null || true

mkdir -p "$(dirname "$PROFILE_DIR")" "$(dirname "$CDP_URL_FILE")"

echo "Starting host browser..."
echo "  Profile: $PROFILE_DIR"

CDP_URL=$(agent-browser --headed --profile "$PROFILE_DIR" get cdp-url)

if [[ ! "$CDP_URL" =~ ^ws:// ]]; then
  echo "ERROR: Invalid CDP URL: $CDP_URL" >&2
  exit 1
fi

echo "$CDP_URL" > "$CDP_URL_FILE"

echo "Host browser ready."
echo "  CDP URL file: $CDP_URL_FILE"
echo ""
echo "The browser window is visible — log into sites your agents need."
echo "NanoClaw containers will connect automatically when HOST_BROWSER_CDP_ENABLED=true."
