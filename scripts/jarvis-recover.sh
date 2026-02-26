#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RESTART_NANOCLAW=1
RUN_PREFLIGHT=1
error_count=0

usage() {
  cat <<'EOF'
Usage: scripts/jarvis-recover.sh [options]

Options:
  --no-restart-nanoclaw  Do not restart com.nanoclaw service.
  --no-preflight         Skip final preflight validation.
  -h, --help             Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-restart-nanoclaw)
      RESTART_NANOCLAW=0
      shift
      ;;
    --no-preflight)
      RUN_PREFLIGHT=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

step() {
  local label="$1"
  shift
  echo "[STEP] $label"
  if "$@"; then
    echo "[PASS] $label"
  else
    echo "[WARN] $label"
    error_count=$((error_count + 1))
  fi
}

echo "== Jarvis Recovery =="

if command -v launchctl >/dev/null 2>&1; then
  UID_VALUE="$(id -u)"
  step "kickstart buildkit launchd service" launchctl kickstart -k "gui/$UID_VALUE/com.apple.container.container-runtime-linux.buildkit"
  step "kickstart apiserver launchd service" launchctl kickstart -k "gui/$UID_VALUE/com.apple.container.apiserver"
else
  echo "[WARN] launchctl not available; skipping launchd kickstart"
  error_count=$((error_count + 1))
fi

if command -v container >/dev/null 2>&1; then
  step "container system start" container system start
  step "container builder start" container builder start
  step "container system status" container system status
  step "container builder status" container builder status
else
  echo "[WARN] container CLI not available; skipping runtime recovery"
  error_count=$((error_count + 1))
fi

if [ "$RESTART_NANOCLAW" -eq 1 ]; then
  if command -v launchctl >/dev/null 2>&1; then
    UID_VALUE="$(id -u)"
    step "restart com.nanoclaw service" launchctl kickstart -k "gui/$UID_VALUE/com.nanoclaw"
  else
    echo "[WARN] launchctl not available; cannot restart com.nanoclaw"
    error_count=$((error_count + 1))
  fi
fi

if [ "$RUN_PREFLIGHT" -eq 1 ]; then
  echo "[STEP] run preflight checks"
  if "$ROOT_DIR/scripts/jarvis-preflight.sh"; then
    echo "[PASS] run preflight checks"
  else
    echo "[FAIL] run preflight checks"
    exit 1
  fi
else
  echo "[INFO] preflight skipped"
  if [ "$error_count" -gt 0 ]; then
    exit 1
  fi
fi

