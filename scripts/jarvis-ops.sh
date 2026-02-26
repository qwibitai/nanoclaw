#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/jarvis-ops.sh <command> [args]

Commands:
  preflight   Run runtime/auth/db health checks.
  recover     Run container/runtime recovery and preflight.
  smoke       Rebuild worker image and run worker e2e smoke.
  watch       Show log summary and follow categorized events.
  help        Show this help.
EOF
}

command_name="${1:-help}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command_name" in
  preflight)
    exec "$SCRIPT_DIR/jarvis-preflight.sh" "$@"
    ;;
  recover)
    exec "$SCRIPT_DIR/jarvis-recover.sh" "$@"
    ;;
  smoke)
    exec "$SCRIPT_DIR/jarvis-smoke.sh" "$@"
    ;;
  watch)
    exec "$SCRIPT_DIR/jarvis-watch.sh" "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $command_name"
    usage
    exit 1
    ;;
esac

