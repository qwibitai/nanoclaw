#!/bin/bash
# reporting.sh — Logging and JSON report writer.

LOG_DIR="/home/nano-prod/obsidian-sync/Nano CI/Logs"
RUN_ID=""
RUN_LOG=""
REPORT_FILE=""

# Per-phase results (parallel arrays)
PHASE_NAMES=()
PHASE_STATUSES=()
PHASE_DURATIONS=()
PHASE_ERRORS=()

# ── Initialize run logging ──────────────────────────────────────────────────

init_reporting() {
  mkdir -p "$LOG_DIR"

  RUN_ID="$(date '+%Y%m%d-%H%M%S')"
  RUN_LOG="${LOG_DIR}/run-${RUN_ID}.log"
  REPORT_FILE="${LOG_DIR}/report-${RUN_ID}.json"

  # Tee stdout/stderr to log file while keeping terminal output
  touch "$RUN_LOG"
  chown nano-prod:nano-prod "$RUN_LOG" 2>/dev/null || true
  exec > >(tee -a "$RUN_LOG") 2>&1

  log_info "Run ID: ${RUN_ID}"
  log_info "Log: ${RUN_LOG}"
  log_info "Report: ${REPORT_FILE}"
}

# ── Record phase result ─────────────────────────────────────────────────────

record_phase() {
  local name="$1"
  local status="$2"      # pass | fail | skip
  local duration="$3"    # seconds
  local error="${4:-}"

  PHASE_NAMES+=("$name")
  PHASE_STATUSES+=("$status")
  PHASE_DURATIONS+=("$duration")
  PHASE_ERRORS+=("$error")

  if [ "$status" = "pass" ]; then
    log_ok "Phase ${name}: PASS (${duration}s)"
  elif [ "$status" = "skip" ]; then
    log_warn "Phase ${name}: SKIP"
  else
    log_error "Phase ${name}: FAIL (${duration}s) — ${error}"
  fi
}

# ── Write JSON report ───────────────────────────────────────────────────────

write_report() {
  local overall_status="$1"
  local overall_duration="$2"
  local ref="${3:-main}"

  # Build phases JSON array
  local phases_json="["
  local first=true
  for i in "${!PHASE_NAMES[@]}"; do
    if [ "$first" = true ]; then
      first=false
    else
      phases_json+=","
    fi

    # Escape any double quotes in error messages
    local escaped_error="${PHASE_ERRORS[$i]//\"/\\\"}"

    phases_json+=$(cat <<ITEM
{
      "name": "${PHASE_NAMES[$i]}",
      "status": "${PHASE_STATUSES[$i]}",
      "duration_seconds": ${PHASE_DURATIONS[$i]},
      "error": "${escaped_error}"
    }
ITEM
)
  done
  phases_json+="]"

  cat > "$REPORT_FILE" <<REPORT
{
  "run_id": "${RUN_ID}",
  "timestamp": "$(date -Iseconds)",
  "ref": "${ref}",
  "overall_status": "${overall_status}",
  "total_duration_seconds": ${overall_duration},
  "phases": ${phases_json}
}
REPORT

  # Ensure files are owned by nanoclaw, not root
  chown nano-prod:nano-prod "$REPORT_FILE" 2>/dev/null || true

  log_info "Report written to ${REPORT_FILE}"

  # Write filtered markdown (errors/warnings/failures only)
  write_markdown "$overall_status" "$overall_duration" "$ref"
}

# ── Write filtered markdown ─────────────────────────────────────────────────
#
# Exports only errors, warnings, and failed phases to a readable .md file.
# Strips ANSI codes. Obsidian-friendly.

write_markdown() {
  local overall_status="$1"
  local overall_duration="$2"
  local ref="${3:-main}"
  local md_file="${LOG_DIR}/run-${RUN_ID}.md"

  {
    echo "# Pipeline Run ${RUN_ID}"
    echo ""
    echo "- **Date:** $(date '+%Y-%m-%d %H:%M')"
    echo "- **Ref:** ${ref}"
    echo "- **Status:** ${overall_status}"
    echo "- **Duration:** ${overall_duration}s"
    echo ""

    # Summary table — only failed/skipped phases
    local has_issues=false
    for i in "${!PHASE_NAMES[@]}"; do
      if [ "${PHASE_STATUSES[$i]}" != "pass" ]; then
        has_issues=true
        break
      fi
    done

    if [ "$has_issues" = true ]; then
      echo "## Failed / Skipped Phases"
      echo ""
      echo "| Phase | Status | Duration | Error |"
      echo "|-------|--------|----------|-------|"
      for i in "${!PHASE_NAMES[@]}"; do
        if [ "${PHASE_STATUSES[$i]}" != "pass" ]; then
          echo "| ${PHASE_NAMES[$i]} | ${PHASE_STATUSES[$i]} | ${PHASE_DURATIONS[$i]}s | ${PHASE_ERRORS[$i]} |"
        fi
      done
      echo ""
    fi

    # Extract errors, warnings, and subprocess failures from the raw log.
    # Captures our own [ERROR]/[WARN] lines plus common error patterns from
    # subprocesses (diff, npm, FATAL, permission denied, etc.) and test stderr.
    if [ -f "$RUN_LOG" ]; then
      local filtered
      filtered=$(sed 's/\x1b\[[0-9;]*m//g' "$RUN_LOG" \
        | grep -iE '^\[(ERROR|WARN)\]|^stderr \||FATAL:|: error:|: not found|No such file|permission denied|ERR!|^diff:' \
        | grep -ivE 'failedMounts: 0|PASS|Phase.*SKIP' \
        || true)
      if [ -n "$filtered" ]; then
        echo "## Errors & Warnings"
        echo ""
        echo '```'
        echo "$filtered"
        echo '```'
      fi
    fi

    if [ "$overall_status" = "pass" ]; then
      echo ""
      echo "> All phases passed. No issues to report."
    fi
  } > "$md_file"

  chown nano-prod:nano-prod "$md_file" 2>/dev/null || true
}

# ── Print summary table ─────────────────────────────────────────────────────

print_summary() {
  echo ""
  echo -e "${BOLD}──────────────────────────────────────────────────────${NC}"
  echo -e "${BOLD}  Pipeline Summary${NC}"
  echo -e "${BOLD}──────────────────────────────────────────────────────${NC}"

  for i in "${!PHASE_NAMES[@]}"; do
    local status_color
    case "${PHASE_STATUSES[$i]}" in
      pass) status_color="${GREEN}" ;;
      skip) status_color="${YELLOW}" ;;
      *)    status_color="${RED}" ;;
    esac

    printf "  %-20s %b%-4s%b  %3ss" \
      "${PHASE_NAMES[$i]}" \
      "$status_color" "${PHASE_STATUSES[$i]}" "$NC" \
      "${PHASE_DURATIONS[$i]}"

    if [ -n "${PHASE_ERRORS[$i]}" ]; then
      printf "  %b%s%b" "$RED" "${PHASE_ERRORS[$i]}" "$NC"
    fi
    echo ""
  done

  echo -e "${BOLD}──────────────────────────────────────────────────────${NC}"
}
