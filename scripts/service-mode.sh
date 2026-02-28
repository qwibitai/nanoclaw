#!/usr/bin/env bash
set -euo pipefail

LABEL="com.nanoclaw"
PLIST="$HOME/Library/LaunchAgents/com.nanoclaw.plist"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/service-mode.sh <install|start|stop|restart|status|logs>

Commands:
  install  Generate and load service config (same as setup service step)
  start    Build and start service mode
  stop     Stop service mode
  restart  Restart service mode
  status   Show launchd status
  logs     Tail runtime logs
EOF
}

ensure_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "service-mode.sh currently supports macOS launchd only."
    exit 1
  fi
}

is_loaded() {
  launchctl list | grep -q "$LABEL"
}

cmd_install() {
  ensure_macos
  cd "$PROJECT_ROOT"
  npm run setup -- --step service
}

cmd_start() {
  ensure_macos
  cd "$PROJECT_ROOT"

  if [[ ! -f "$PLIST" ]]; then
    echo "LaunchAgent plist not found, installing service config..."
    cmd_install
    return
  fi

  npm run build

  if is_loaded; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
  else
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi

  echo "Service started: $LABEL"
}

cmd_stop() {
  ensure_macos
  if is_loaded; then
    launchctl bootout "gui/$(id -u)/$LABEL"
    echo "Service stopped: $LABEL"
  else
    echo "Service is not running: $LABEL"
  fi
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_status() {
  ensure_macos
  if is_loaded; then
    launchctl list | grep "$LABEL"
  else
    echo "Service not loaded: $LABEL"
  fi
}

cmd_logs() {
  cd "$PROJECT_ROOT"
  tail -f logs/nanoclaw.log
}

main() {
  local command="${1:-}"
  case "$command" in
    install) cmd_install ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    logs) cmd_logs ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
