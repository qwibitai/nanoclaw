#!/usr/bin/env bash
# runner/test/smoke.sh — integration smoke test
#
# Topology: nanoclaw-runner binary in Docker → WebSocket → central stub on host
# Verifies: RUNNER_REGISTER → ACK → HEARTBEAT round-trip
#
# Usage (from nanoclaw root or runner/test/):
#   ./runner/test/smoke.sh
#
# Requirements: docker, pnpm (with tsx), go
#
# Env overrides:
#   RUNNER_PORT     WebSocket port for the central stub (default: 3031)
#   SKIP_DOCKER     Set to 1 to run the Go binary directly (no Docker)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER_DIR="$NANOCLAW_ROOT/runner"

RUNNER_PORT="${RUNNER_PORT:-3031}"
SKIP_DOCKER="${SKIP_DOCKER:-0}"

CENTRAL_LOG="$(mktemp /tmp/nanoclaw-central.XXXXXX.log)"
RUNNER_LOG="$(mktemp /tmp/nanoclaw-runner.XXXXXX.log)"
CENTRAL_PID=""

cleanup() {
  [ -n "$CENTRAL_PID" ] && kill "$CENTRAL_PID" 2>/dev/null || true
  docker stop nanoclaw-runner-inttest 2>/dev/null || true
  rm -f "$CENTRAL_LOG" "$RUNNER_LOG"
}
trap cleanup EXIT

echo "==> nanoclaw-runner integration smoke test"
echo "    nanoclaw root : $NANOCLAW_ROOT"
echo "    runner port   : $RUNNER_PORT"
echo "    skip docker   : $SKIP_DOCKER"
echo ""

# ── 1. Build TypeScript ───────────────────────────────────────────────────────
echo "==> [1/4] Building NanoClaw TypeScript..."
cd "$NANOCLAW_ROOT"
pnpm run build 2>&1 | tail -3

# ── 2. Start central stub ─────────────────────────────────────────────────────
echo "==> [2/4] Starting central stub (port $RUNNER_PORT)..."
RUNNER_WS_PORT="$RUNNER_PORT" pnpm exec tsx runner/test/central-stub.ts \
  >"$CENTRAL_LOG" 2>&1 &
CENTRAL_PID=$!

# Wait up to 10s for credentials to appear in log
echo -n "    Waiting for stub to emit credentials..."
for i in $(seq 1 20); do
  if grep -q 'RUNNER_TOKEN=' "$CENTRAL_LOG" 2>/dev/null; then echo " ok"; break; fi
  if ! kill -0 "$CENTRAL_PID" 2>/dev/null; then
    echo " FAILED (central stub died)"
    cat "$CENTRAL_LOG"
    exit 1
  fi
  sleep 0.5
  if [ "$i" -eq 20 ]; then echo " TIMED OUT"; cat "$CENTRAL_LOG"; exit 1; fi
done

RUNNER_TOKEN="$(grep 'RUNNER_TOKEN=' "$CENTRAL_LOG" | head -1 | cut -d= -f2 | tr -d '[:space:]')"
RUNNER_NAME="$(grep 'RUNNER_NAME=' "$CENTRAL_LOG" | head -1 | cut -d= -f2 | tr -d '[:space:]')"
echo "    Runner name: $RUNNER_NAME"

# ── 3. Build and start runner ─────────────────────────────────────────────────
if [ "$SKIP_DOCKER" = "1" ]; then
  echo "==> [3/4] Building Go runner binary (no Docker)..."
  cd "$RUNNER_DIR"
  go build -o /tmp/nanoclaw-runner-inttest ./cmd/nanoclaw-runner

  echo "==> [4/4] Starting runner binary..."
  NANOCLAW_CENTRAL_URL="ws://localhost:$RUNNER_PORT/runner/connect" \
  NANOCLAW_RUNNER_NAME="$RUNNER_NAME" \
  NANOCLAW_RUNNER_TOKEN="$RUNNER_TOKEN" \
  NANOCLAW_RUNNER_VERSION="inttest-0.1.0" \
  NANOCLAW_HEARTBEAT_INTERVAL_SEC="5" \
    /tmp/nanoclaw-runner-inttest >"$RUNNER_LOG" 2>&1 &
else
  echo "==> [3/4] Building nanoclaw-runner Docker image..."
  docker build -t nanoclaw-runner:inttest "$RUNNER_DIR" 2>&1 | tail -5

  echo "==> [4/4] Starting runner container (--network host)..."
  docker run --rm --name nanoclaw-runner-inttest \
    --network host \
    -e NANOCLAW_CENTRAL_URL="ws://localhost:$RUNNER_PORT/runner/connect" \
    -e NANOCLAW_RUNNER_NAME="$RUNNER_NAME" \
    -e NANOCLAW_RUNNER_TOKEN="$RUNNER_TOKEN" \
    -e NANOCLAW_RUNNER_VERSION="inttest-0.1.0" \
    -e NANOCLAW_HEARTBEAT_INTERVAL_SEC="5" \
    nanoclaw-runner:inttest >"$RUNNER_LOG" 2>&1 &
fi

# ── 5. Wait for central stub to exit ─────────────────────────────────────────
echo ""
echo "==> Waiting for round-trip (up to 30s)..."
wait "$CENTRAL_PID" && EXIT_CODE=0 || EXIT_CODE=$?

echo ""
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "============================================"
  echo "  PASSED: register → ack → heartbeat OK"
  echo "============================================"
  echo ""
  echo "--- central log (last 15 lines) ---"
  grep -v '^RUNNER_' "$CENTRAL_LOG" | tail -15
  exit 0
else
  echo "============================================"
  echo "  FAILED (central exited $EXIT_CODE)"
  echo "============================================"
  echo ""
  echo "--- central log ---"
  cat "$CENTRAL_LOG"
  echo ""
  echo "--- runner log ---"
  cat "$RUNNER_LOG"
  exit 1
fi
