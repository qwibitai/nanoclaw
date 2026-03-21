#!/bin/bash
# overnight-dent — Autonomous batch kaizen runner (trampoline).
#
# This is the TRAMPOLINE — a thin outer loop that:
#   1. Parses args and creates the batch
#   2. Pulls main between runs (so merged improvements take effect)
#   3. Delegates each run to overnight-dent-run.sh (re-read from disk each time)
#   4. Prints the batch summary when done
#
# All real logic (prompt building, output parsing, stream-json observability)
# lives in overnight-dent-run.sh → overnight-dent-run.ts, which self-updates
# when PRs merge to main.
#
# Cross-run state is persisted to $LOG_DIR/state.json — survives crashes,
# enables future --resume, and provides L4 reporting data.
#
# Usage:
#   ./scripts/overnight-dent.sh "focus on hooks reliability"
#   ./scripts/overnight-dent.sh --max-runs 5 --budget 5.00 "improve test coverage"
#   ./scripts/overnight-dent.sh --dry-run "test the prompt"
#
# Logs go to logs/overnight-dent/<batch-id>/
#
# See docs/horizons/autonomous-batch-operations.md for the full horizon spec.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Always resolve to the main checkout (not a worktree)
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# ── Defaults ──────────────────────────────────────────────────────────────────
MAX_RUNS=0              # 0 = unlimited
COOLDOWN=30             # seconds between runs
BUDGET=""               # per-run budget
MAX_FAILURES=3          # consecutive failures before stopping
DRY_RUN=false
GUIDANCE=""

# ── Usage ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
overnight-dent — Autonomous batch kaizen runner

Usage: overnight-dent.sh [options] <guidance>
       overnight-dent.sh --status
       overnight-dent.sh --halt [batch-id]

Options:
  --max-runs N         Stop after N iterations (default: unlimited)
  --cooldown N         Seconds between runs (default: 30)
  --budget N.NN        Max USD per run (passed to claude --max-budget-usd)
  --max-failures N     Stop after N consecutive failures (default: 3)
  --dry-run            Show what would run without executing
  --status             Show status of all batches (active and stopped)
  --halt [batch-id]    Halt a specific batch, or all active batches
  --help               Show this help

Self-update: between runs, the trampoline pulls main so that merged
improvements to the runner script take effect on the next iteration.

Halt: Ctrl+C halts from the same terminal. From another terminal:
  ./scripts/overnight-dent.sh --halt              # halt all active
  ./scripts/overnight-dent.sh --halt batch-id     # halt one batch

Examples:
  ./scripts/overnight-dent.sh "focus on hooks reliability"
  ./scripts/overnight-dent.sh --max-runs 5 --budget 5.00 "improve test coverage"
  ./scripts/overnight-dent.sh --max-runs 10 --budget 5.00 "fix area/skills issues"
EOF
  exit 0
}

# ── Subcommands (handled before main arg parsing) ─────────────────────────────
CTL_SCRIPT="$SCRIPT_DIR/overnight-dent-ctl.ts"

if [[ "${1:-}" = "--status" ]]; then
  exec npx tsx "$CTL_SCRIPT" status
fi

if [[ "${1:-}" = "--halt" ]]; then
  shift
  exec npx tsx "$CTL_SCRIPT" halt "$@"
fi

# ── Arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help) usage ;;
    --max-runs) MAX_RUNS="$2"; shift 2 ;;
    --cooldown) COOLDOWN="$2"; shift 2 ;;
    --budget) BUDGET="$2"; shift 2 ;;
    --total-budget) echo "Warning: --total-budget is not yet enforced (L3 work)" >&2; shift 2 ;;
    --max-failures) MAX_FAILURES="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) GUIDANCE="$1"; shift ;;
  esac
done

if [[ -z "$GUIDANCE" ]]; then
  echo "Error: guidance prompt is required" >&2
  echo "Usage: overnight-dent.sh [options] <guidance>" >&2
  exit 1
fi

# ── Batch identity ────────────────────────────────────────────────────────────
BATCH_ID="batch-$(date +%y%m%d-%H%M)-$(printf '%04x' $RANDOM)"
BATCH_START=$(date +%s)
LOG_DIR="$REPO_ROOT/logs/overnight-dent/$BATCH_ID"
mkdir -p "$LOG_DIR"
HALT_FILE="$LOG_DIR/HALT"

# ── Initialize state file ────────────────────────────────────────────────────
STATE_FILE="$LOG_DIR/state.json"

# JSON-escape guidance using node (no python3 dependency)
GUIDANCE_JSON=$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$GUIDANCE")
BUDGET_JSON=$(if [[ -n "$BUDGET" ]]; then echo "\"$BUDGET\""; else echo "null"; fi)

cat > "$STATE_FILE" << STATEOF
{
  "batch_id": "$BATCH_ID",
  "guidance": $GUIDANCE_JSON,
  "batch_start": $BATCH_START,
  "max_runs": $MAX_RUNS,
  "cooldown": $COOLDOWN,
  "budget": $BUDGET_JSON,
  "max_failures": $MAX_FAILURES,
  "run": 0,
  "consecutive_failures": 0,
  "current_cooldown": $COOLDOWN,
  "stop_reason": "",
  "prs": [],
  "issues_filed": [],
  "issues_closed": [],
  "cases": [],
  "last_issue": "",
  "last_pr": "",
  "last_case": "",
  "last_branch": "",
  "last_worktree": "",
  "progress_issue": ""
}
STATEOF

# ── State helpers (using node, not python3) ───────────────────────────────────
read_state() {
  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const v = s[process.argv[2]];
    console.log(v === null || v === undefined ? '' : String(v));
  " "$STATE_FILE" "$1"
}

update_state() {
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    s[process.argv[2]] = process.argv[3];
    fs.writeFileSync(process.argv[1], JSON.stringify(s, null, 2) + '\n');
  " "$STATE_FILE" "$1" "$2"
}

# ── Graceful shutdown ─────────────────────────────────────────────────────────
SHUTTING_DOWN=false

handle_shutdown() {
  if [[ "$SHUTTING_DOWN" = true ]]; then return; fi
  SHUTTING_DOWN=true
  echo ""
  echo ">>> Received shutdown signal. Finishing current run, then stopping..."
  update_state stop_reason "signal (SIGTERM/SIGINT)"
}
trap handle_shutdown SIGTERM SIGINT

# Print last-worked-on state on exit
print_last_state() {
  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
    npx tsx "$CTL_SCRIPT" halt-state "$STATE_FILE" 2>/dev/null || true
  fi
}

check_halt_file() {
  if [[ -n "$HALT_FILE" && -f "$HALT_FILE" ]]; then
    echo ">>> Halt file detected: $HALT_FILE"
    update_state stop_reason "halt file (remote request)"
    SHUTTING_DOWN=true
    return 0
  fi
  return 1
}

# ── Banner ────────────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              overnight-dent (trampoline)                ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║ Batch ID:  $BATCH_ID"
echo "║ Guidance:  $GUIDANCE"
echo "║ Max runs:  $([ "$MAX_RUNS" -eq 0 ] && echo "unlimited" || echo "$MAX_RUNS")"
echo "║ Cooldown:  ${COOLDOWN}s"
[[ -n "$BUDGET" ]] && echo "║ Budget/run: \$$BUDGET"
echo "║ Max consecutive failures: $MAX_FAILURES"
echo "║ Logs:      $LOG_DIR"
echo "║ State:     $STATE_FILE"
echo "║ Halt:      touch $HALT_FILE  (or --halt from another terminal)"
echo "║ Self-update: enabled (pulls main between runs)"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

if [[ "$DRY_RUN" = true ]]; then
  echo "[dry-run] Would execute per run:"
  echo "  $REPO_ROOT/scripts/overnight-dent-run.sh $STATE_FILE"
  echo ""
  echo "[dry-run] State file:"
  cat "$STATE_FILE"
  exit 0
fi

# ── Main loop (trampoline) ────────────────────────────────────────────────────
# This loop is intentionally minimal. All real logic is in the runner.
while true; do
  if [[ "$SHUTTING_DOWN" = true ]]; then break; fi
  check_halt_file && break

  # Read current state
  RUN=$(read_state run)
  CONSEC_FAIL=$(read_state consecutive_failures)
  CUR_COOLDOWN=$(read_state current_cooldown)
  STOP_REASON=$(read_state stop_reason)
  NEXT_RUN=$((RUN + 1))

  # Stop conditions (checked in trampoline so they work even if runner changes)
  if [[ -n "$STOP_REASON" ]]; then
    echo ">>> Stopping: $STOP_REASON"
    break
  fi

  if [[ "$MAX_RUNS" -gt 0 && "$NEXT_RUN" -gt "$MAX_RUNS" ]]; then
    update_state stop_reason "max runs reached ($MAX_RUNS)"
    break
  fi

  if [[ "$CONSEC_FAIL" -ge "$MAX_FAILURES" ]]; then
    echo ">>> Stopping: $MAX_FAILURES consecutive failures"
    update_state stop_reason "$MAX_FAILURES consecutive failures"
    break
  fi

  # ── Self-update: pull main before each run ──────────────────────────────
  echo ">>> Pulling main for self-update..."
  if git -C "$REPO_ROOT" pull --ff-only origin main 2>/dev/null; then
    echo ">>> Main updated."
  else
    echo ">>> Main already up-to-date (or pull failed, continuing with current)."
  fi

  # ── Resolve runner (re-resolve after pull in case it was added/moved) ───
  RUNNER="$REPO_ROOT/scripts/overnight-dent-run.sh"
  if [[ ! -x "$RUNNER" ]]; then
    echo ">>> ERROR: Runner not found: $RUNNER"
    echo ">>> This may happen if the trampoline PR merged but the runner isn't on main yet."
    update_state stop_reason "runner not found"
    break
  fi

  # ── Execute the runner (re-read from disk each time) ────────────────────
  echo "━━━ Run #$NEXT_RUN starting at $(date) ━━━"
  EXIT_CODE=0
  "$RUNNER" "$STATE_FILE" || EXIT_CODE=$?

  # Runner updates state.json with results. Check for stop signal.
  STOP_REASON=$(read_state stop_reason)
  if [[ -n "$STOP_REASON" ]]; then
    echo ">>> Stopping: $STOP_REASON"
    break
  fi

  if [[ "$SHUTTING_DOWN" = true ]]; then break; fi

  # ── Cross-run progress ─────────────────────────────────────────────────
  COMPLETED_RUNS=$(read_state run)
  CONSEC_FAIL=$(read_state consecutive_failures)
  CUR_COOLDOWN=$(read_state current_cooldown)
  PR_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).prs.length)")
  CLOSED_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).issues_closed.length)")
  ELAPSED=$(( $(date +%s) - BATCH_START ))
  HOURS=$(( ELAPSED / 3600 ))
  MINS=$(( (ELAPSED % 3600) / 60 ))
  RUNS_LABEL="$COMPLETED_RUNS"
  [[ "$MAX_RUNS" -gt 0 ]] && RUNS_LABEL="$COMPLETED_RUNS/$MAX_RUNS"

  echo "━━━ Batch Progress ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Runs: $RUNS_LABEL completed | $CONSEC_FAIL consecutive failures"
  echo "  PRs:  $PR_COUNT created | Issues: $CLOSED_COUNT closed"
  echo "  Time: ${HOURS}h ${MINS}m elapsed"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Check max-runs after run
  if [[ "$MAX_RUNS" -gt 0 && "$COMPLETED_RUNS" -ge "$MAX_RUNS" ]]; then
    update_state stop_reason "max runs reached ($MAX_RUNS)"
    break
  fi

  if [[ "$SHUTTING_DOWN" = true ]]; then break; fi
  check_halt_file && break

  # Cooldown with halt file polling (check every 3s)
  echo "Cooling down for ${CUR_COOLDOWN}s before next run... (touch $HALT_FILE to stop)"
  COOLDOWN_REMAINING=$CUR_COOLDOWN
  while [[ "$COOLDOWN_REMAINING" -gt 0 ]]; do
    POLL_INTERVAL=$(( COOLDOWN_REMAINING < 3 ? COOLDOWN_REMAINING : 3 ))
    sleep "$POLL_INTERVAL" &
    SLEEP_PID=$!
    wait $SLEEP_PID 2>/dev/null || true
    COOLDOWN_REMAINING=$((COOLDOWN_REMAINING - POLL_INTERVAL))
    if [[ "$SHUTTING_DOWN" = true ]]; then break; fi
    check_halt_file && break 2
  done
done

# ── Close batch progress issue ────────────────────────────────────────────────
npx tsx "$SCRIPT_DIR/overnight-dent-run.ts" --close-batch "$STATE_FILE" 2>/dev/null || true

# ── Batch summary ─────────────────────────────────────────────────────────────
node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));

  const duration = Math.floor(Date.now() / 1000) - s.batch_start;
  const hours = Math.floor(duration / 3600);
  const mins = Math.floor((duration % 3600) / 60);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║             overnight-dent — Batch Summary              ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║ Batch ID:  ' + s.batch_id);
  console.log('║ Guidance:  ' + s.guidance);
  console.log('║ Runs:      ' + s.run);
  console.log('║ Duration:  ' + hours + 'h ' + mins + 'm');
  console.log('║ Stop:      ' + (s.stop_reason || 'completed'));
  console.log('╠══════════════════════════════════════════════════════════╣');

  if (s.prs.length > 0) {
    console.log('║ PRs created:');
    s.prs.forEach(pr => console.log('║   ' + pr));
  } else {
    console.log('║ PRs created: none');
  }

  if (s.issues_filed.length > 0) {
    console.log('║ Issues filed:');
    s.issues_filed.forEach(i => console.log('║   ' + i));
  }

  if (s.issues_closed.length > 0) {
    console.log('║ Issues closed: ' + s.issues_closed.join(' '));
  }

  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Finalize state
  if (!s.stop_reason) s.stop_reason = 'completed';
  s.batch_end = Math.floor(Date.now() / 1000);
  fs.writeFileSync(process.argv[1], JSON.stringify(s, null, 2) + '\n');
  console.log('State: ' + process.argv[1]);

  // Also write plain-text summary for quick review
  const summaryPath = process.argv[1].replace('state.json', 'batch-summary.txt');
  const lines = [
    'batch_id=' + s.batch_id,
    'guidance=' + s.guidance,
    'runs=' + s.run,
    'total_duration_seconds=' + duration,
    'stop_reason=' + (s.stop_reason || 'completed'),
    'prs=' + s.prs.join(' '),
    'issues_filed=' + s.issues_filed.join(' '),
    'issues_closed=' + s.issues_closed.join(' '),
    'cases=' + s.cases.join(' '),
  ].join('\n');
  fs.writeFileSync(summaryPath, lines + '\n');
  console.log('Summary: ' + summaryPath);
" "$STATE_FILE"

# Print last-worked-on state for easy resume
print_last_state
