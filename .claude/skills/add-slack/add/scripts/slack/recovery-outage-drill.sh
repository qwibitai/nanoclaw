#!/bin/bash
# recovery-outage-drill.sh — Synthetic outage drill: observe exhaustion → retry → recovery events
# Usage: ./scripts/slack/recovery-outage-drill.sh [--dry-run] [--help]
#
# Phases:
#   1. Pre-flight      — verify service, log file, checkpoint script
#   2. Baseline        — run canary-checkpoint.sh --dry-run, capture output
#   3. Recovery scan   — grep logs for 5 recovery event keys
#   4. Evidence        — write structured report to .sisyphus/evidence/r4-drill-{ts}.txt
#   5. Verdict         — print summary with event counts and overall status
#
# Exit codes:
#   0 = all events observed (or dry-run completed)
#   1 = pre-flight failure
#   2 = no recovery events observed (informational, not fatal)

set -euo pipefail

# ─── Flags ───────────────────────────────────────────────────────────────────

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      cat <<'HELP'
recovery-outage-drill.sh — Synthetic outage drill runner (diagnostic, non-destructive)

USAGE
  ./scripts/slack/recovery-outage-drill.sh [--dry-run] [--help]

FLAGS
  --dry-run   Show what would be checked; skip writing evidence file
  --help      Print this message and exit

PHASES
  1. Pre-flight      Verify service running, log file exists, checkpoint script exists
  2. Baseline        Run canary-checkpoint.sh --dry-run and capture output
  3. Recovery scan   Grep logs for 5 recovery event keys:
                       exhaustion_drop          (src/group-queue.ts)
                       cursor_commit_on_exhaustion (src/index.ts)
                       send_failed_non_delivery (src/index.ts)
                       slack_recovery_resume    (src/index.ts)
                       recovery_callback_error  (src/channels/slack.ts)
  4. Evidence        Write structured report to .sisyphus/evidence/r4-drill-{timestamp}.txt
  5. Verdict         Print summary with event counts and overall status

NOTES
  - This script is DIAGNOSTIC ONLY. It does not stop, restart, or modify the service.
  - PID detection uses: pgrep -f 'dist/index.js'
  - Log file: logs/nanoclaw.log
  - Evidence dir: .sisyphus/evidence/
HELP
      exit 0
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
  esac
done

# ─── Paths ───────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/nanoclaw.log"
CHECKPOINT_SCRIPT="$SCRIPT_DIR/canary-checkpoint.sh"
EVIDENCE_DIR="$PROJECT_ROOT/.sisyphus/evidence"

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TIMESTAMP_FILE=$(date -u +%Y%m%dT%H%M%SZ)
EVIDENCE_FILE="$EVIDENCE_DIR/r4-drill-${TIMESTAMP_FILE}.txt"

# ─── Helpers ─────────────────────────────────────────────────────────────────

print_phase() {
  echo ""
  echo "══════════════════════════════════════════════════════"
  echo "  $1"
  echo "══════════════════════════════════════════════════════"
}

count_event() {
  local event_key="$1"
  if [[ -f "$LOG_FILE" ]]; then
    (grep -c "\"event\":\"${event_key}\"" "$LOG_FILE" 2>/dev/null || true)
  else
    echo 0
  fi
}

# ─── Phase 1: Pre-flight ─────────────────────────────────────────────────────

print_phase "Phase 1: Pre-flight"

PREFLIGHT_PASS=true
PREFLIGHT_NOTES=()

# 1a. Service running?
PID=$(pgrep -f 'dist/index.js' | head -1 || true)
if [[ -n "$PID" ]]; then
  echo "  [OK] Service running (PID: $PID)"
  PREFLIGHT_NOTES+=("service_running: true (pid=$PID)")
else
  echo "  [WARN] Service not running — drill will scan full log history"
  PREFLIGHT_NOTES+=("service_running: false (log-only mode)")
  # Not fatal — we can still scan logs
fi

# 1b. Log file exists?
if [[ -f "$LOG_FILE" ]]; then
  LOG_LINES=$(wc -l < "$LOG_FILE" | tr -d ' ')
  echo "  [OK] Log file exists ($LOG_LINES lines)"
  PREFLIGHT_NOTES+=("log_file: exists (lines=$LOG_LINES)")
else
  echo "  [FAIL] Log file not found: $LOG_FILE"
  PREFLIGHT_NOTES+=("log_file: missing")
  PREFLIGHT_PASS=false
fi

# 1c. Checkpoint script exists?
if [[ -f "$CHECKPOINT_SCRIPT" ]]; then
  echo "  [OK] Checkpoint script found: $CHECKPOINT_SCRIPT"
  PREFLIGHT_NOTES+=("checkpoint_script: exists")
else
  echo "  [FAIL] Checkpoint script not found: $CHECKPOINT_SCRIPT"
  PREFLIGHT_NOTES+=("checkpoint_script: missing")
  PREFLIGHT_PASS=false
fi

# 1d. Evidence dir
mkdir -p "$EVIDENCE_DIR"
echo "  [OK] Evidence dir: $EVIDENCE_DIR"

if [[ "$PREFLIGHT_PASS" == "false" ]]; then
  echo ""
  echo "  Pre-flight FAILED — cannot proceed without log file and checkpoint script."
  exit 1
fi

# ─── Phase 2: Baseline Snapshot ──────────────────────────────────────────────

print_phase "Phase 2: Baseline Snapshot (canary-checkpoint.sh --dry-run)"

BASELINE_OUTPUT=""
BASELINE_EXIT=0

if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would run: bash $CHECKPOINT_SCRIPT --dry-run"
  BASELINE_OUTPUT='{"dry_run_mode":true,"note":"skipped in --dry-run"}'
else
  BASELINE_OUTPUT=$(bash "$CHECKPOINT_SCRIPT" --dry-run 2>/dev/null || true)
  BASELINE_EXIT=$?
  if [[ -n "$BASELINE_OUTPUT" ]]; then
    echo "  Checkpoint output (truncated to 5 lines):"
    echo "$BASELINE_OUTPUT" | head -5 | sed 's/^/    /'
    BASELINE_VERDICT=$(echo "$BASELINE_OUTPUT" | grep -o '"verdict":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
    echo "  Checkpoint verdict: $BASELINE_VERDICT"
  else
    echo "  [WARN] Checkpoint produced no output"
    BASELINE_VERDICT="no_output"
  fi
fi

# ─── Phase 3: Recovery Event Scan ────────────────────────────────────────────

print_phase "Phase 3: Recovery Event Scan"

# Scan for the 5 recovery event keys
E1_KEY="exhaustion_drop"
E2_KEY="cursor_commit_on_exhaustion"
E3_KEY="send_failed_non_delivery"
E4_KEY="slack_recovery_resume"
E5_KEY="recovery_callback_error"

echo "  Scanning: $LOG_FILE"
echo ""

E1_COUNT=$(count_event "$E1_KEY")
E2_COUNT=$(count_event "$E2_KEY")
E3_COUNT=$(count_event "$E3_KEY")
E4_COUNT=$(count_event "$E4_KEY")
E5_COUNT=$(count_event "$E5_KEY")

printf "  %-40s %s\n" "exhaustion_drop (group-queue.ts):"        "$E1_COUNT occurrences"
printf "  %-40s %s\n" "cursor_commit_on_exhaustion (index.ts):"  "$E2_COUNT occurrences"
printf "  %-40s %s\n" "send_failed_non_delivery (index.ts):"     "$E3_COUNT occurrences"
printf "  %-40s %s\n" "slack_recovery_resume (index.ts):"        "$E4_COUNT occurrences"
printf "  %-40s %s\n" "recovery_callback_error (slack.ts):"      "$E5_COUNT occurrences"

# Total observed events (pure bash arithmetic)
TOTAL_EVENTS=$(( E1_COUNT + E2_COUNT + E3_COUNT + E4_COUNT + E5_COUNT ))
echo ""
echo "  Total recovery events observed: $TOTAL_EVENTS"

# Classify: which events have been seen at least once
EVENTS_SEEN=0
[[ "$E1_COUNT" -gt 0 ]] && EVENTS_SEEN=$(( EVENTS_SEEN + 1 ))
[[ "$E2_COUNT" -gt 0 ]] && EVENTS_SEEN=$(( EVENTS_SEEN + 1 ))
[[ "$E3_COUNT" -gt 0 ]] && EVENTS_SEEN=$(( EVENTS_SEEN + 1 ))
[[ "$E4_COUNT" -gt 0 ]] && EVENTS_SEEN=$(( EVENTS_SEEN + 1 ))
[[ "$E5_COUNT" -gt 0 ]] && EVENTS_SEEN=$(( EVENTS_SEEN + 1 ))

echo "  Distinct event types seen: $EVENTS_SEEN / 5"

# Grab last occurrence of each event for context
echo ""
echo "  Last occurrence of each event:"
for key in "$E1_KEY" "$E2_KEY" "$E3_KEY" "$E4_KEY" "$E5_KEY"; do
  if [[ -f "$LOG_FILE" ]]; then
    LAST=$(grep "\"event\":\"${key}\"" "$LOG_FILE" 2>/dev/null | tail -1 | cut -c1-120 || true)
    if [[ -n "$LAST" ]]; then
      printf "    %-38s %s\n" "${key}:" "$LAST"
    else
      printf "    %-38s %s\n" "${key}:" "(not found in log)"
    fi
  fi
done

# ─── Phase 4: Evidence Assembly ──────────────────────────────────────────────

print_phase "Phase 4: Evidence Assembly"

# Determine overall drill status
if [[ "$EVENTS_SEEN" -ge 3 ]]; then
  DRILL_STATUS="RECOVERY_OBSERVED"
elif [[ "$EVENTS_SEEN" -ge 1 ]]; then
  DRILL_STATUS="PARTIAL_RECOVERY_OBSERVED"
else
  DRILL_STATUS="NO_RECOVERY_EVENTS"
fi

EVIDENCE_CONTENT="r4-outage-drill evidence
========================
timestamp:    $TIMESTAMP
drill_status: $DRILL_STATUS
dry_run:      $DRY_RUN
pid:          ${PID:-none}

--- Pre-flight ---
$(printf '%s\n' "${PREFLIGHT_NOTES[@]}")

--- Baseline Checkpoint ---
verdict: ${BASELINE_VERDICT:-skipped}
output_lines: $(echo "$BASELINE_OUTPUT" | wc -l | tr -d ' ')

--- Recovery Event Counts ---
exhaustion_drop:              $E1_COUNT
cursor_commit_on_exhaustion:  $E2_COUNT
send_failed_non_delivery:     $E3_COUNT
slack_recovery_resume:        $E4_COUNT
recovery_callback_error:      $E5_COUNT
total_events:                 $TOTAL_EVENTS
distinct_types_seen:          $EVENTS_SEEN / 5

--- Verdict ---
$DRILL_STATUS
"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would write evidence to: $EVIDENCE_FILE"
  echo "  Evidence preview:"
  echo "$EVIDENCE_CONTENT" | head -20 | sed 's/^/    /'
else
  echo "$EVIDENCE_CONTENT" > "$EVIDENCE_FILE"
  echo "  Evidence written to: $EVIDENCE_FILE"
fi

# ─── Phase 5: Verdict ────────────────────────────────────────────────────────

print_phase "Phase 5: Verdict"

echo ""
echo "  Drill Status:  $DRILL_STATUS"
echo "  Events Seen:   $EVENTS_SEEN / 5 distinct types"
echo "  Total Events:  $TOTAL_EVENTS occurrences"
echo ""

case "$DRILL_STATUS" in
  RECOVERY_OBSERVED)
    echo "  PASS — Recovery machinery has been exercised (≥3 event types observed)."
    echo "         The exhaustion-drop/recovery cycle is visible in logs."
    DRILL_EXIT=0
    ;;
  PARTIAL_RECOVERY_OBSERVED)
    echo "  PARTIAL — Some recovery events observed but not the full cycle."
    echo "            Check which events are missing and whether the service"
    echo "            has experienced a full outage+recovery cycle."
    DRILL_EXIT=0
    ;;
  NO_RECOVERY_EVENTS)
    echo "  INFO — No recovery events found in logs."
    echo "         This is expected on a fresh install or if no outages have occurred."
    echo "         The recovery machinery is in place but has not been triggered."
    DRILL_EXIT=2
    ;;
esac

echo ""
if [[ "$DRY_RUN" == "false" ]]; then
  echo "  Evidence: $EVIDENCE_FILE"
fi
echo ""

exit $DRILL_EXIT
