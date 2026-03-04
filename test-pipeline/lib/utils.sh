#!/bin/bash
# utils.sh — Shared helpers for the test pipeline.

# ── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Logging ─────────────────────────────────────────────────────────────────

log_info()  { echo -e "${BLUE}[INFO]${NC}  $(date '+%H:%M:%S')  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $(date '+%H:%M:%S')  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $(date '+%H:%M:%S')  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $(date '+%H:%M:%S')  $*"; }

log_phase() {
  local phase_num="$1"; shift
  echo ""
  echo -e "${BOLD}════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  Phase ${phase_num}: $*${NC}"
  echo -e "${BOLD}════════════════════════════════════════════════════════════${NC}"
}

# ── Run command as test user ────────────────────────────────────────────────
#
# Usage: run_as_user <command...>
#
# Runs a command as TEST_USER with a login shell, preserving PATH for Node.js.
# Requires TEST_USER and TEST_HOME to be set.

run_as_user() {
  local uid
  uid=$(id -u "$TEST_USER")
  sudo -u "$TEST_USER" \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
    bash -lc "$*"
}

# ── Parse structured status blocks ─────────────────────────────────────────
#
# NanoClaw setup steps emit blocks like:
#   === NANOCLAW SETUP: STEP_NAME ===
#   KEY: value
#   === END ===
#
# Usage: parse_status_field <output> <FIELD_NAME>
# Returns the value of the field, or empty string if not found.

parse_status_field() {
  local output="$1"
  local field="$2"
  echo "$output" | grep "^${field}:" | head -1 | sed "s/^${field}: *//"
}

# ── Timing helpers ──────────────────────────────────────────────────────────

timer_start() {
  date +%s
}

timer_elapsed() {
  local start="$1"
  local now
  now=$(date +%s)
  echo $(( now - start ))
}

# ── Require root ────────────────────────────────────────────────────────────

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_error "This script must be run as root (sudo ./test-pipeline/run.sh)"
    exit 1
  fi
}

# ── Check command exists ────────────────────────────────────────────────────

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" &>/dev/null; then
    log_error "Required command not found: $cmd"
    exit 1
  fi
}
