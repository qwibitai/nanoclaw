#!/bin/bash
set -euo pipefail

# run.sh — NanoClaw Install Pipeline Orchestrator
#
# Creates a clean Linux user, runs every install step programmatically,
# then executes a YAML playbook of E2E scenarios (install, swap, multi-channel)
# and tears down.
#
# Usage:
#   sudo ./test-pipeline/run.sh                              # Full run (default playbook)
#   sudo ./test-pipeline/run.sh --ref my-branch              # Test a branch
#   sudo ./test-pipeline/run.sh --skip-e2e                   # Build-only
#   sudo ./test-pipeline/run.sh --keep-user                  # Don't teardown
#   sudo ./test-pipeline/run.sh --playbook path/to/custom.yaml

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Source library files ────────────────────────────────────────────────────

source "${SCRIPT_DIR}/lib/utils.sh"
source "${SCRIPT_DIR}/lib/credentials.sh"
source "${SCRIPT_DIR}/lib/channel-e2e.sh"
source "${SCRIPT_DIR}/lib/reporting.sh"
source "${SCRIPT_DIR}/lib/auto-fix.sh"
source "${SCRIPT_DIR}/lib/phases.sh"
source "${SCRIPT_DIR}/lib/playbook.sh"

# ── Configuration ──────────────────────────────────────────────────────────

TEST_USER="nanoclaw-test-$(date '+%d%m%y')"
TEST_HOME=""
CLONE_DIR=""
GIT_REF="main"
REPO_URL="https://github.com/qwibitai/nanoclaw.git"
SKIP_E2E=false
KEEP_USER=false
CREDENTIALS_SRC=""
PLAYBOOK_PATH="${SCRIPT_DIR}/playbook.yaml"

# ── Parse arguments ────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)
      GIT_REF="$2"
      shift 2
      ;;
    --credentials)
      CREDENTIALS_SRC="$2"
      shift 2
      ;;
    --playbook)
      PLAYBOOK_PATH="$2"
      shift 2
      ;;
    --skip-e2e)
      SKIP_E2E=true
      shift
      ;;
    --keep-user)
      KEEP_USER=true
      shift
      ;;
    --help|-h)
      echo "Usage: sudo ./test-pipeline/run.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --credentials <path>   Path to credentials.env file to import"
      echo "  --ref <branch>         Git ref to test (default: main)"
      echo "  --playbook <path>      Path to playbook YAML (default: test-pipeline/playbook.yaml)"
      echo "  --skip-e2e             Skip E2E verification in all scenarios"
      echo "  --keep-user            Don't teardown test user after run"
      echo "  --help                 Show this help"
      echo ""
      echo "First run:"
      echo "  sudo ./test-pipeline/run.sh --credentials /path/to/credentials.env"
      echo ""
      echo "Subsequent runs (credentials are persisted):"
      echo "  sudo ./test-pipeline/run.sh"
      echo ""
      echo "Custom playbook:"
      echo "  sudo ./test-pipeline/run.sh --playbook test-pipeline/playbook-telegram-only.yaml"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ── Preflight checks ──────────────────────────────────────────────────────

require_root
require_command git
require_command curl
require_command docker
require_command sqlite3
require_command python3
require_command jq

# Verify PyYAML is available
if ! python3 -c "import yaml" 2>/dev/null; then
  log_info "Installing PyYAML..."
  pip3 install pyyaml -q
fi

# ── Ensure host directories exist ──────────────────────────────────────────

mkdir -p /etc/nanoclaw-test
mkdir -p "$LOG_DIR"
chown nano-prod:nano-prod "$LOG_DIR"

# ── Import credentials if provided ─────────────────────────────────────────

if [ -n "$CREDENTIALS_SRC" ]; then
  if [ ! -f "$CREDENTIALS_SRC" ]; then
    echo "ERROR: Credentials file not found: $CREDENTIALS_SRC"
    exit 1
  fi
  cp "$CREDENTIALS_SRC" "$CREDENTIALS_FILE"
  chmod 600 "$CREDENTIALS_FILE"
  echo "Imported credentials from $CREDENTIALS_SRC"
fi

# ── Initialize ─────────────────────────────────────────────────────────────

init_reporting

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           NanoClaw Install Pipeline                     ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
log_info "Ref: ${GIT_REF}"
log_info "Playbook: ${PLAYBOOK_PATH}"
log_info "Skip E2E: ${SKIP_E2E}"
log_info "Keep user: ${KEEP_USER}"

# Parse the playbook before loading credentials (so we fail fast on bad YAML)
if ! parse_playbook "$PLAYBOOK_PATH"; then
  log_error "Cannot proceed without a valid playbook"
  exit 1
fi

# Load credentials (needed for scenario credentials/E2E phases)
if ! load_credentials; then
  if [ "$SKIP_E2E" = true ]; then
    log_warn "Credentials not loaded — E2E will be skipped anyway"
    # Set dummy values so credential-dependent phases can still work for build-only
    CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-DUMMY}"
    TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-000000:DUMMY}"
    TELEGRAM_TEST_CHAT_ID="${TELEGRAM_TEST_CHAT_ID:-tg:0}"
    SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-xoxb-DUMMY}"
    SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-xapp-DUMMY}"
    SLACK_TEST_CHAT_ID="${SLACK_TEST_CHAT_ID:-slack:0}"
    DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-DUMMY}"
    DISCORD_TEST_CHAT_ID="${DISCORD_TEST_CHAT_ID:-dc:0}"
  else
    log_error "Cannot run full pipeline without credentials"
    exit 1
  fi
fi

# ── Run phases ──────────────────────────────────────────────────────────────

OVERALL_START=$(timer_start)
FAILED_PHASE=""

# Helper: run a phase with timing and error handling
run_phase() {
  local phase_num="$1"
  local phase_name="$2"
  local phase_func="$3"

  log_phase "$phase_num" "$phase_name"

  local start
  start=$(timer_start)

  if "$phase_func"; then
    local duration
    duration=$(timer_elapsed "$start")
    record_phase "$phase_name" "pass" "$duration"
    return 0
  else
    local duration
    duration=$(timer_elapsed "$start")
    record_phase "$phase_name" "fail" "$duration" "phase function returned non-zero"
    FAILED_PHASE="$phase_name"
    return 1
  fi
}

# Helper: record a skipped phase
skip_phase() {
  local phase_name="$1"
  record_phase "$phase_name" "skip" "0"
}

# ── Sequential phase execution ──────────────────────────────────────────────

# Setup phases, then playbook scenarios, then teardown
run_pipeline() {
  # ── Setup (once) ─────────────────────────────────────────────────────
  run_phase 1 "user_create"     phase_user_create     || return 1
  run_phase 2 "clone"           phase_clone           || return 1
  run_phase 3 "bootstrap"       phase_bootstrap       || return 1
  run_phase 4 "build"           phase_build           || return 1
  run_phase 5 "environment"     phase_environment     || return 1
  run_phase 6 "container_build" phase_container_build || return 1
  run_phase 7 "mounts"          phase_mounts          || return 1

  # ── Scenarios (from playbook) ────────────────────────────────────────
  if ! run_playbook; then
    return 1
  fi

  return 0
}

# Run the pipeline, capture success/failure
PIPELINE_OK=true
if ! run_pipeline; then
  PIPELINE_OK=false
fi

# ── Teardown ────────────────────────────────────────────────────────────────

if [ "$KEEP_USER" = true ]; then
  skip_phase "teardown"
  log_warn "Keeping test user ${TEST_USER} (--keep-user)"
  log_warn "To clean up manually: sudo userdel -r ${TEST_USER}"
else
  log_phase "T" "teardown"
  local_start=$(timer_start)
  if phase_teardown; then
    record_phase "teardown" "pass" "$(timer_elapsed "$local_start")"
  else
    record_phase "teardown" "fail" "$(timer_elapsed "$local_start")" "teardown error"
  fi
fi

# ── Report ──────────────────────────────────────────────────────────────────

OVERALL_DURATION=$(timer_elapsed "$OVERALL_START")

if [ "$PIPELINE_OK" = true ]; then
  OVERALL_STATUS="pass"
else
  OVERALL_STATUS="fail"
fi

write_report "$OVERALL_STATUS" "$OVERALL_DURATION" "$GIT_REF" "$PLAYBOOK_PATH"
print_summary

echo ""
if [ "$OVERALL_STATUS" = "pass" ]; then
  log_ok "Pipeline PASSED in ${OVERALL_DURATION}s"
  exit 0
else
  log_error "Pipeline FAILED at phase: ${FAILED_PHASE} (total: ${OVERALL_DURATION}s)"
  exit 1
fi
