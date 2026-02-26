#!/bin/bash

# NanoClaw Manager - Start/Stop/Restart service with dependency checks
# Usage: ./scripts/nc-manager.sh [start|stop|restart|status]

NC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.nanoclaw.plist"
SERVICE_LABEL="com.nanoclaw"
DIST_FILE="$NC_DIR/dist/index.js"
LOG_FILE="$NC_DIR/logs/nanoclaw.log"
ERROR_LOG_FILE="$NC_DIR/logs/nanoclaw.error.log"
PID_FILE="$NC_DIR/logs/nanoclaw.pid"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Utility functions
log_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
  echo -e "${GREEN}✓${NC} $1"
}

log_error() {
  echo -e "${RED}✗${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

# Check if Docker is running
check_docker() {
  if ! command -v docker &> /dev/null; then
    return 1
  fi

  docker info &>/dev/null 2>&1
}

# Try to start Docker
try_start_docker() {
  if [ -d "/Applications/Docker.app" ]; then
    open -a Docker 2>/dev/null || true
    # Wait max 15 seconds
    for i in {1..15}; do
      sleep 1
      if check_docker; then
        return 0
      fi
    done
  fi
  return 1
}

# Compile TypeScript
compile() {
  log_info "Compiling TypeScript..."

  cd "$NC_DIR"
  if ! npm run build > /dev/null 2>&1; then
    log_error "Compilation failed"
    return 1
  fi

  if [ ! -f "$DIST_FILE" ]; then
    log_error "dist/index.js not created after compilation"
    return 1
  fi

  log_success "Compiled"
  return 0
}

# Check if process is running via PID file
is_running_via_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

# Check if service is loaded in launchctl
is_service_loaded() {
  launchctl list 2>/dev/null | grep -q "com.nanoclaw" 2>/dev/null
}

# Start via launchctl
start_via_launchctl() {
  if is_service_loaded; then
    log_warning "Already loaded in launchctl"
    return 0
  fi

  log_info "Loading service..."

  if launchctl load "$PLIST_PATH" 2>/dev/null; then
    log_success "Loaded via launchctl"
    sleep 1
    return 0
  fi

  log_warning "launchctl load failed"
  return 1
}

# Stop via launchctl
stop_via_launchctl() {
  if ! is_service_loaded; then
    return 0
  fi

  log_info "Unloading service..."

  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  sleep 1
  log_success "Unloaded"
  return 0
}

# Start command
cmd_start() {
  log_info "Starting NanoClaw..."
  echo ""

  # Compile if needed
  if [ ! -f "$DIST_FILE" ]; then
    compile || { log_error "Cannot proceed without compiled code"; return 1; }
  fi

  # Check if already running
  if is_running_via_pid || is_service_loaded; then
    log_warning "Already running"
    return 0
  fi

  # Ensure logs directory exists
  mkdir -p "$(dirname "$LOG_FILE")"

  # Check Docker
  if ! check_docker; then
    log_warning "Docker not accessible, attempting to start..."
    if ! try_start_docker; then
      log_warning "Docker unavailable - NanoClaw needs Docker to run agents"
      log_info "Please open Docker Desktop manually"
      return 1
    fi
  fi

  log_success "Docker ready"

  # Try to load via launchctl first
  if start_via_launchctl; then
    echo ""
    log_success "NanoClaw started"
    return 0
  fi

  # Fallback: start directly
  log_info "Fallback: starting directly..."
  cd "$NC_DIR"
  nohup /opt/homebrew/bin/node "$DIST_FILE" > "$LOG_FILE" 2> "$ERROR_LOG_FILE" &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    log_success "Started (PID: $pid)"
    return 0
  else
    log_error "Failed to start"
    return 1
  fi
}

# Stop command
cmd_stop() {
  log_info "Stopping NanoClaw..."
  echo ""

  stop_via_launchctl || true

  # Kill any running processes
  if [ -f "$PID_FILE" ]; then
    local pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true
    rm "$PID_FILE" 2>/dev/null || true
  fi

  # Final cleanup
  pkill -f "node.*index.js" 2>/dev/null || true

  sleep 1
  log_success "Stopped"
  return 0
}

# Restart command
cmd_restart() {
  log_info "Restarting NanoClaw..."
  echo ""
  cmd_stop
  sleep 2
  cmd_start
}

# Status command
cmd_status() {
  echo ""
  echo "═══════════════════════════════════════════"
  echo "          NanoClaw Status"
  echo "═══════════════════════════════════════════"
  echo ""

  # Docker status
  if check_docker; then
    echo -e "  Docker:        ${GREEN}✓ Running${NC}"
  else
    echo -e "  Docker:        ${RED}✗ Not accessible${NC}"
  fi

  # Compiled status
  if [ -f "$DIST_FILE" ]; then
    local mtime=$(stat -f%Sm -t"%Y-%m-%d %H:%M:%S" "$DIST_FILE" 2>/dev/null || echo "?")
    echo -e "  Compiled:      ${GREEN}✓ Yes${NC} ($mtime)"
  else
    echo -e "  Compiled:      ${RED}✗ No${NC}"
  fi

  # Running status
  if is_running_via_pid; then
    local pid=$(cat "$PID_FILE")
    echo -e "  Running:       ${GREEN}✓ Yes${NC} (PID: $pid)"
  elif is_service_loaded; then
    echo -e "  Running:       ${GREEN}✓ Yes${NC} (via launchctl)"
  else
    echo -e "  Running:       ${RED}✗ No${NC}"
  fi

  # Log info
  if [ -f "$LOG_FILE" ]; then
    local size=$(ls -lh "$LOG_FILE" | awk '{print $5}')
    echo -e "  Log:           $LOG_FILE ($size)"
  fi

  echo ""
  echo "═══════════════════════════════════════════"
  echo ""
}

# Main
main() {
  case "${1:-status}" in
    start)
      cmd_start
      ;;
    stop)
      cmd_stop
      ;;
    restart)
      cmd_restart
      ;;
    status)
      cmd_status
      ;;
    *)
      echo "Usage: $0 {start|stop|restart|status}"
      exit 1
      ;;
  esac
}

main "$@"
