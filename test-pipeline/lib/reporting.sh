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
PHASE_DETAILS=()   # Actual error output (compiler messages, script errors, etc.)

# Scenario tracking
SCENARIO_NAMES=()          # Populated by playbook.sh as scenarios run
SCENARIO_START_INDICES=()  # Index into PHASE_* arrays where each scenario starts

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
  local detail="${5:-}"

  PHASE_NAMES+=("$name")
  PHASE_STATUSES+=("$status")
  PHASE_DURATIONS+=("$duration")
  PHASE_ERRORS+=("$error")
  PHASE_DETAILS+=("$detail")

  if [ "$status" = "pass" ]; then
    log_ok "Phase ${name}: PASS (${duration}s)"
  elif [ "$status" = "skip" ]; then
    log_warn "Phase ${name}: SKIP"
  else
    log_error "Phase ${name}: FAIL (${duration}s) — ${error}"
  fi
}

# ── Mark the start of a scenario ────────────────────────────────────────────
#
# Called by playbook.sh before running each scenario's sub-phases.

begin_scenario() {
  local name="$1"
  SCENARIO_NAMES+=("$name")
  SCENARIO_START_INDICES+=(${#PHASE_NAMES[@]})
}

# ── Write JSON report ───────────────────────────────────────────────────────

write_report() {
  local overall_status="$1"
  local overall_duration="$2"
  local ref="${3:-main}"
  local playbook_path="${4:-}"

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
    local escaped_detail="${PHASE_DETAILS[$i]//\"/\\\"}"
    # Replace newlines with \n for JSON
    escaped_detail="${escaped_detail//$'\n'/\\n}"

    phases_json+=$(cat <<ITEM
{
      "name": "${PHASE_NAMES[$i]}",
      "status": "${PHASE_STATUSES[$i]}",
      "duration_seconds": ${PHASE_DURATIONS[$i]},
      "error": "${escaped_error}",
      "detail": "${escaped_detail}"
    }
ITEM
)
  done
  phases_json+="]"

  # Build scenarios JSON array
  local scenarios_json="["
  local first_scenario=true
  local num_scenarios=${#SCENARIO_NAMES[@]}

  for s in $(seq 0 $((num_scenarios - 1))); do
    if [ "$first_scenario" = true ]; then
      first_scenario=false
    else
      scenarios_json+=","
    fi

    local start_idx=${SCENARIO_START_INDICES[$s]}
    local end_idx
    if [ $((s + 1)) -lt "$num_scenarios" ]; then
      end_idx=${SCENARIO_START_INDICES[$((s + 1))]}
    else
      end_idx=${#PHASE_NAMES[@]}
    fi

    # Determine scenario status: fail if any sub-phase failed
    local scenario_status="pass"
    local scenario_phases="["
    local first_phase=true

    for i in $(seq "$start_idx" $((end_idx - 1))); do
      if [ "$first_phase" = true ]; then
        first_phase=false
      else
        scenario_phases+=","
      fi

      local escaped_err="${PHASE_ERRORS[$i]//\"/\\\"}"
      local escaped_det="${PHASE_DETAILS[$i]//\"/\\\"}"
      escaped_det="${escaped_det//$'\n'/\\n}"
      scenario_phases+=$(cat <<SITEM
{
            "name": "${PHASE_NAMES[$i]}",
            "status": "${PHASE_STATUSES[$i]}",
            "duration_seconds": ${PHASE_DURATIONS[$i]},
            "error": "${escaped_err}",
            "detail": "${escaped_det}"
          }
SITEM
)
      if [ "${PHASE_STATUSES[$i]}" = "fail" ]; then
        scenario_status="fail"
      fi
    done
    scenario_phases+="]"

    local escaped_name="${SCENARIO_NAMES[$s]//\"/\\\"}"
    scenarios_json+=$(cat <<SCENARIO
{
      "name": "${escaped_name}",
      "status": "${scenario_status}",
      "phases": ${scenario_phases}
    }
SCENARIO
)
  done
  scenarios_json+="]"

  # Build autofix_attempts JSON array
  local autofix_json="["
  local first_af=true
  for i in "${!AUTOFIX_PHASE_NAMES[@]}"; do
    if [ "$first_af" = true ]; then
      first_af=false
    else
      autofix_json+=","
    fi

    local af_error="${AUTOFIX_ERRORS_IN[$i]//\"/\\\"}"
    af_error="${af_error//$'\n'/\\n}"
    local af_fix="${AUTOFIX_FIX_TEXT[$i]//\"/\\\"}"
    af_fix="${af_fix//$'\n'/\\n}"

    autofix_json+=$(cat <<AFIX
{
      "phase": "${AUTOFIX_PHASE_NAMES[$i]}",
      "attempt": ${AUTOFIX_ATTEMPT_NUMS[$i]},
      "outcome": "${AUTOFIX_OUTCOMES[$i]}",
      "input_tokens": ${AUTOFIX_INPUT_TOKENS[$i]},
      "output_tokens": ${AUTOFIX_OUTPUT_TOKENS[$i]},
      "cost_usd": ${AUTOFIX_COSTS[$i]:-0},
      "duration_seconds": ${AUTOFIX_DURATIONS[$i]},
      "error_snippet": "${af_error:0:500}",
      "fix_diff": "${af_fix:0:2000}"
    }
AFIX
)
  done
  autofix_json+="]"

  cat > "$REPORT_FILE" <<REPORT
{
  "run_id": "${RUN_ID}",
  "timestamp": "$(date -Iseconds)",
  "ref": "${ref}",
  "playbook": "${playbook_path}",
  "overall_status": "${overall_status}",
  "total_duration_seconds": ${overall_duration},
  "phases": ${phases_json},
  "scenarios": ${scenarios_json},
  "autofix_attempts": ${autofix_json}
}
REPORT

  # Ensure files are owned by nanoclaw, not root
  chown nano-prod:nano-prod "$REPORT_FILE" 2>/dev/null || true

  log_info "Report written to ${REPORT_FILE}"

  # Write filtered markdown (errors/warnings/failures only)
  write_markdown "$overall_status" "$overall_duration" "$ref" "$playbook_path"
}

# ── Write filtered markdown ─────────────────────────────────────────────────
#
# Exports errors, warnings, and failed phases to a readable .md file.
# Groups results by scenario. Strips ANSI codes. Obsidian-friendly.

write_markdown() {
  local overall_status="$1"
  local overall_duration="$2"
  local ref="${3:-main}"
  local playbook_path="${4:-}"
  local md_file="${LOG_DIR}/run-${RUN_ID}.md"

  {
    echo "# Pipeline Run ${RUN_ID}"
    echo ""
    echo "- **Date:** $(date '+%Y-%m-%d %H:%M')"
    echo "- **Ref:** ${ref}"
    if [ -n "$playbook_path" ]; then
      echo "- **Playbook:** ${playbook_path}"
    fi
    echo "- **Status:** ${overall_status}"
    echo "- **Duration:** ${overall_duration}s"
    echo ""

    # ── Issues: failed phases and auto-fixed phases ──────────────────────
    local issue_count=0

    for i in "${!PHASE_NAMES[@]}"; do
      local is_fail=false
      local is_autofixed=false

      if [ "${PHASE_STATUSES[$i]}" = "fail" ]; then
        is_fail=true
      fi
      if [ "${PHASE_DETAILS[$i]:-}" = "auto-fixed" ]; then
        is_autofixed=true
      fi

      if [ "$is_fail" = true ] || [ "$is_autofixed" = true ]; then
        issue_count=$((issue_count + 1))

        if [ "$issue_count" -eq 1 ]; then
          echo "## Issues"
          echo ""
        fi

        # Title
        local title=""
        if [ "$is_autofixed" = true ]; then
          title="${PHASE_NAMES[$i]} — auto-fixed"
        else
          title="${PHASE_ERRORS[$i]:-${PHASE_NAMES[$i]} failed}"
          title="$(echo "${title:0:1}" | tr '[:lower:]' '[:upper:]')${title:1}"
        fi

        echo "### ${title}"
        echo ""

        if [ "$is_autofixed" = true ]; then
          echo "Build failed but was automatically fixed by Claude."
          echo ""

          # Show auto-fix attempts for this phase
          for af in "${!AUTOFIX_PHASE_NAMES[@]}"; do
            if [ "${AUTOFIX_PHASE_NAMES[$af]}" = "${PHASE_NAMES[$i]}" ]; then
              # Show error on first attempt
              if [ "${AUTOFIX_ATTEMPT_NUMS[$af]}" = "1" ] && [ -n "${AUTOFIX_ERRORS_IN[$af]:-}" ]; then
                echo "**Error:**"
                echo '```'
                echo "${AUTOFIX_ERRORS_IN[$af]}" | head -20
                echo '```'
                echo ""
              fi

              echo "**Fix Attempt ${AUTOFIX_ATTEMPT_NUMS[$af]}** — ${AUTOFIX_OUTCOMES[$af]} (${AUTOFIX_DURATIONS[$af]}s, \$${AUTOFIX_COSTS[$af]})"
              echo "Tokens: ${AUTOFIX_INPUT_TOKENS[$af]} in / ${AUTOFIX_OUTPUT_TOKENS[$af]} out"

              if [ -n "${AUTOFIX_FIX_TEXT[$af]:-}" ]; then
                echo '```diff'
                echo "${AUTOFIX_FIX_TEXT[$af]}" | head -40
                echo '```'
              fi
              echo ""
            fi
          done
        else
          # Regular failure — same as before
          # Find which scenario this belongs to
          local scenario_label=""
          local num_scenarios=${#SCENARIO_NAMES[@]}
          for s in $(seq 0 $((num_scenarios - 1))); do
            local s_start=${SCENARIO_START_INDICES[$s]}
            local s_end
            if [ $((s + 1)) -lt "$num_scenarios" ]; then
              s_end=${SCENARIO_START_INDICES[$((s + 1))]}
            else
              s_end=${#PHASE_NAMES[@]}
            fi
            if [ "$i" -ge "$s_start" ] && [ "$i" -lt "$s_end" ]; then
              scenario_label="Scenario $((s + 1)): ${SCENARIO_NAMES[$s]}"
              break
            fi
          done

          if [ -n "$scenario_label" ]; then
            echo "- **Scenario:** ${scenario_label}"
          fi
          echo "- **Phase:** ${PHASE_NAMES[$i]}"
          echo "- **Duration:** ${PHASE_DURATIONS[$i]}s"

          if [ -n "${PHASE_DETAILS[$i]:-}" ]; then
            echo ""
            echo '```'
            echo "${PHASE_DETAILS[$i]}"
            echo '```'
          fi
          echo ""
        fi
      fi
    done

    if [ "$issue_count" -eq 0 ] && [ "$overall_status" = "pass" ]; then
      echo "> All phases passed. No issues to report."
      echo ""
    fi

    # ── Auto-fix Summary table ───────────────────────────────────────────
    if [ ${#AUTOFIX_PHASE_NAMES[@]} -gt 0 ]; then
      echo "## Auto-fix Summary"
      echo ""
      echo "| Phase | Attempt | Outcome | Tokens | Cost | Duration |"
      echo "|-------|---------|---------|--------|------|----------|"
      for af in "${!AUTOFIX_PHASE_NAMES[@]}"; do
        local tokens="${AUTOFIX_INPUT_TOKENS[$af]}/${AUTOFIX_OUTPUT_TOKENS[$af]}"
        printf "| %s | %s | %s | %s | \$%s | %ss |\n" \
          "${AUTOFIX_PHASE_NAMES[$af]}" \
          "${AUTOFIX_ATTEMPT_NUMS[$af]}" \
          "${AUTOFIX_OUTCOMES[$af]}" \
          "$tokens" \
          "${AUTOFIX_COSTS[$af]}" \
          "${AUTOFIX_DURATIONS[$af]}"
      done
      echo ""
    fi

    # ── Phase Summary table ──────────────────────────────────────────────
    echo "## Phase Summary"
    echo ""
    echo "| # | Phase | Status | Duration | Notes |"
    echo "|---|-------|--------|----------|-------|"
    local phase_num=0
    for i in "${!PHASE_NAMES[@]}"; do
      phase_num=$((phase_num + 1))
      local status="${PHASE_STATUSES[$i]}"
      local status_upper
      status_upper=$(echo "$status" | tr '[:lower:]' '[:upper:]')
      local notes=""
      if [ "${PHASE_DETAILS[$i]:-}" = "auto-fixed" ]; then
        notes="auto-fixed"
      elif [ "$status" = "fail" ] && [ -n "${PHASE_ERRORS[$i]:-}" ]; then
        notes="${PHASE_ERRORS[$i]}"
      fi
      printf "| %s | %s | %s | %ss | %s |\n" \
        "$phase_num" \
        "${PHASE_NAMES[$i]}" \
        "$status_upper" \
        "${PHASE_DURATIONS[$i]}" \
        "$notes"
    done
    echo ""
  } > "$md_file"

  chown nano-prod:nano-prod "$md_file" 2>/dev/null || true
}

# ── Print summary table ─────────────────────────────────────────────────────

print_summary() {
  echo ""
  echo -e "${BOLD}──────────────────────────────────────────────────────${NC}"
  echo -e "${BOLD}  Pipeline Summary${NC}"
  echo -e "${BOLD}──────────────────────────────────────────────────────${NC}"

  local num_scenarios=${#SCENARIO_NAMES[@]}
  local first_scenario_idx=0
  if [ "$num_scenarios" -gt 0 ]; then
    first_scenario_idx=${SCENARIO_START_INDICES[0]}
  else
    first_scenario_idx=${#PHASE_NAMES[@]}
  fi

  # Setup phases
  if [ "$first_scenario_idx" -gt 0 ]; then
    echo -e "  ${BOLD}Setup${NC}"
    for i in $(seq 0 $((first_scenario_idx - 1))); do
      local status_color
      case "${PHASE_STATUSES[$i]}" in
        pass) status_color="${GREEN}" ;;
        skip) status_color="${YELLOW}" ;;
        *)    status_color="${RED}" ;;
      esac

      printf "    %-25s %b%-4s%b  %3ss" \
        "${PHASE_NAMES[$i]}" \
        "$status_color" "${PHASE_STATUSES[$i]}" "$NC" \
        "${PHASE_DURATIONS[$i]}"

      if [ -n "${PHASE_ERRORS[$i]}" ]; then
        printf "  %b%s%b" "$RED" "${PHASE_ERRORS[$i]}" "$NC"
      fi
      echo ""
    done
  fi

  # Scenario phases
  for s in $(seq 0 $((num_scenarios - 1))); do
    local start_idx=${SCENARIO_START_INDICES[$s]}
    local end_idx
    if [ $((s + 1)) -lt "$num_scenarios" ]; then
      end_idx=${SCENARIO_START_INDICES[$((s + 1))]}
    else
      end_idx=${#PHASE_NAMES[@]}
    fi

    echo -e "  ${BOLD}Scenario $((s + 1)): ${SCENARIO_NAMES[$s]}${NC}"
    for i in $(seq "$start_idx" $((end_idx - 1))); do
      local status_color
      case "${PHASE_STATUSES[$i]}" in
        pass) status_color="${GREEN}" ;;
        skip) status_color="${YELLOW}" ;;
        *)    status_color="${RED}" ;;
      esac

      printf "    %-25s %b%-4s%b  %3ss" \
        "${PHASE_NAMES[$i]}" \
        "$status_color" "${PHASE_STATUSES[$i]}" "$NC" \
        "${PHASE_DURATIONS[$i]}"

      if [ "${PHASE_DETAILS[$i]:-}" = "auto-fixed" ]; then
        printf "  %b%s%b" "$YELLOW" "auto-fixed" "$NC"
      elif [ -n "${PHASE_ERRORS[$i]}" ]; then
        printf "  %b%s%b" "$RED" "${PHASE_ERRORS[$i]}" "$NC"
      fi
      echo ""
    done
  done

  # Auto-fix summary if any attempts were made
  if [ ${#AUTOFIX_PHASE_NAMES[@]} -gt 0 ]; then
    echo ""
    echo -e "  ${BOLD}Auto-fix Attempts${NC}"
    for af in "${!AUTOFIX_PHASE_NAMES[@]}"; do
      local outcome_color
      case "${AUTOFIX_OUTCOMES[$af]}" in
        build_pass) outcome_color="${GREEN}" ;;
        *)          outcome_color="${RED}" ;;
      esac
      printf "    %-25s #%-2s %b%-10s%b  \$%-5s  %ss\n" \
        "${AUTOFIX_PHASE_NAMES[$af]}" \
        "${AUTOFIX_ATTEMPT_NUMS[$af]}" \
        "$outcome_color" "${AUTOFIX_OUTCOMES[$af]}" "$NC" \
        "${AUTOFIX_COSTS[$af]}" \
        "${AUTOFIX_DURATIONS[$af]}"
    done
  fi

  echo -e "${BOLD}──────────────────────────────────────────────────────${NC}"
}
