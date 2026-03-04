#!/bin/bash
# playbook.sh — Parse YAML playbook and run scenarios sequentially.
#
# Uses Python 3 + PyYAML to parse the playbook into JSON, then jq to
# extract fields in bash. Each scenario modifies the running install
# (install/uninstall skills, update credentials, register groups) and
# runs E2E verification.

PLAYBOOK_JSON=""        # Parsed playbook as JSON (set by parse_playbook)
SCENARIO_COUNT=0        # Number of scenarios in the playbook
CURRENT_SCENARIO=""     # Name of the currently running scenario

# ── Parse playbook YAML into JSON ────────────────────────────────────────────
#
# Usage: parse_playbook <path>
# Sets PLAYBOOK_JSON and SCENARIO_COUNT globals.

parse_playbook() {
  local playbook_path="$1"

  if [ ! -f "$playbook_path" ]; then
    log_error "Playbook not found: ${playbook_path}"
    return 1
  fi

  log_info "Parsing playbook: ${playbook_path}"

  PLAYBOOK_JSON=$(python3 -c "import yaml, json, sys; print(json.dumps(yaml.safe_load(sys.stdin)))" < "$playbook_path")
  if [ $? -ne 0 ] || [ -z "$PLAYBOOK_JSON" ]; then
    log_error "Failed to parse playbook YAML"
    return 1
  fi

  SCENARIO_COUNT=$(echo "$PLAYBOOK_JSON" | jq '.scenarios | length')
  if [ "$SCENARIO_COUNT" -eq 0 ]; then
    log_error "Playbook has no scenarios"
    return 1
  fi

  log_ok "Playbook loaded: ${SCENARIO_COUNT} scenario(s)"
}

# ── Get a field from a scenario ──────────────────────────────────────────────
#
# Usage: scenario_field <index> <jq_expression>
# Example: scenario_field 0 '.name'

scenario_field() {
  local idx="$1"
  local expr="$2"
  echo "$PLAYBOOK_JSON" | jq -r ".scenarios[${idx}]${expr}"
}

# ── Get an array field as space-separated list ───────────────────────────────
#
# Usage: scenario_array <index> <field>
# Returns empty string if field is null.

scenario_array() {
  local idx="$1"
  local field="$2"
  local result
  result=$(echo "$PLAYBOOK_JSON" | jq -r ".scenarios[${idx}].${field} // [] | .[]" 2>/dev/null)
  echo "$result"
}

# ── Run a single scenario ────────────────────────────────────────────────────
#
# Executes one scenario from the playbook:
#   1. Uninstall channels listed in uninstall:
#   2. Install channel skills listed in install:
#   3. Rebuild (npm run build)
#   4. Write credentials for channels in credentials:
#   5. Register groups from register: entries
#   6. Start or restart service
#   7. Run E2E for each channel in e2e:

run_scenario() {
  local idx="$1"
  local scenario_num=$((idx + 1))
  local name
  name=$(scenario_field "$idx" ".name")
  local description
  description=$(scenario_field "$idx" ".description")

  CURRENT_SCENARIO="$name"

  # Register scenario start in reporting (for grouped reports)
  begin_scenario "$name"

  echo ""
  echo -e "${BOLD}┌──────────────────────────────────────────────────────────┐${NC}"
  echo -e "${BOLD}│  Scenario ${scenario_num}: ${name}${NC}"
  echo -e "${BOLD}│  ${description}${NC}"
  echo -e "${BOLD}└──────────────────────────────────────────────────────────┘${NC}"

  local scenario_prefix="scenario_${scenario_num}"

  # ── 1. Uninstall channels ──────────────────────────────────────────────
  local uninstall_list
  uninstall_list=$(scenario_array "$idx" "uninstall")

  if [ -n "$uninstall_list" ]; then
    local phase_name="${scenario_prefix}_uninstall"
    log_phase "$scenario_num.1" "Uninstall channels"
    local start
    start=$(timer_start)
    LAST_ERROR_DETAIL=""
    LAST_BUILD_OUTPUT=""

    if phase_uninstall_channels $uninstall_list; then
      record_phase "$phase_name" "pass" "$(timer_elapsed "$start")"
    else
      # Attempt auto-fix for code errors
      local fix_output="${LAST_BUILD_OUTPUT:-$LAST_ERROR_DETAIL}"
      if is_fixable_error "$phase_name" "$fix_output" && \
         attempt_autofix "$phase_name" "$CLONE_DIR" "$fix_output" "npm run build"; then
        record_phase "$phase_name" "pass" "$(timer_elapsed "$start")" "" "auto-fixed"
      else
        record_phase "$phase_name" "fail" "$(timer_elapsed "$start")" "channel uninstall failed (auto-fix exhausted)" "$LAST_ERROR_DETAIL"
        FAILED_PHASE="$phase_name"
        return 1
      fi
    fi
  fi

  # ── 2. Install channels ───────────────────────────────────────────────
  local install_list
  install_list=$(scenario_array "$idx" "install")

  if [ -n "$install_list" ]; then
    local phase_name="${scenario_prefix}_install"
    log_phase "$scenario_num.2" "Install channels"
    local start
    start=$(timer_start)
    LAST_ERROR_DETAIL=""
    LAST_BUILD_OUTPUT=""

    if phase_install_channels $install_list; then
      record_phase "$phase_name" "pass" "$(timer_elapsed "$start")"
    else
      # Attempt auto-fix for code errors
      local fix_output="${LAST_BUILD_OUTPUT:-$LAST_ERROR_DETAIL}"
      if is_fixable_error "$phase_name" "$fix_output" && \
         attempt_autofix "$phase_name" "$CLONE_DIR" "$fix_output" "npm run build"; then
        record_phase "$phase_name" "pass" "$(timer_elapsed "$start")" "" "auto-fixed"
      else
        record_phase "$phase_name" "fail" "$(timer_elapsed "$start")" "channel install failed (auto-fix exhausted)" "$LAST_ERROR_DETAIL"
        FAILED_PHASE="$phase_name"
        return 1
      fi
    fi
  fi

  # ── 3. Write credentials ──────────────────────────────────────────────
  local cred_list
  cred_list=$(scenario_array "$idx" "credentials")

  if [ -n "$cred_list" ]; then
    local phase_name="${scenario_prefix}_credentials"
    log_phase "$scenario_num.3" "Write credentials"
    local start
    start=$(timer_start)

    if write_scenario_env $cred_list; then
      record_phase "$phase_name" "pass" "$(timer_elapsed "$start")"
    else
      record_phase "$phase_name" "fail" "$(timer_elapsed "$start")" "credential write failed"
      FAILED_PHASE="$phase_name"
      return 1
    fi
  fi

  # ── 4. Register groups ────────────────────────────────────────────────
  local reg_count
  reg_count=$(echo "$PLAYBOOK_JSON" | jq ".scenarios[${idx}].register // [] | length")

  if [ "$reg_count" -gt 0 ]; then
    local phase_name="${scenario_prefix}_register"
    log_phase "$scenario_num.4" "Register groups"
    local start
    start=$(timer_start)
    LAST_ERROR_DETAIL=""

    local reg_ok=true
    for r in $(seq 0 $((reg_count - 1))); do
      local jid_var
      jid_var=$(echo "$PLAYBOOK_JSON" | jq -r ".scenarios[${idx}].register[${r}].jid_var")
      local group_name
      group_name=$(echo "$PLAYBOOK_JSON" | jq -r ".scenarios[${idx}].register[${r}].name")
      local channel
      channel=$(echo "$PLAYBOOK_JSON" | jq -r ".scenarios[${idx}].register[${r}].channel")
      local is_main
      is_main=$(echo "$PLAYBOOK_JSON" | jq -r ".scenarios[${idx}].register[${r}].is_main // false")

      if [ "$is_main" = "true" ]; then
        if ! phase_register_group "$jid_var" "$group_name" "$channel" --is-main; then
          reg_ok=false
          break
        fi
      else
        if ! phase_register_group "$jid_var" "$group_name" "$channel"; then
          reg_ok=false
          break
        fi
      fi
    done

    if [ "$reg_ok" = true ]; then
      record_phase "$phase_name" "pass" "$(timer_elapsed "$start")"
    else
      # Attempt auto-fix for code errors in registration
      local fix_output="${LAST_BUILD_OUTPUT:-$LAST_ERROR_DETAIL}"
      if is_fixable_error "$phase_name" "$fix_output" && \
         attempt_autofix "$phase_name" "$CLONE_DIR" "$fix_output" "npm run build"; then
        record_phase "$phase_name" "pass" "$(timer_elapsed "$start")" "" "auto-fixed"
      else
        record_phase "$phase_name" "fail" "$(timer_elapsed "$start")" "group registration failed (auto-fix exhausted)" "$LAST_ERROR_DETAIL"
        FAILED_PHASE="$phase_name"
        return 1
      fi
    fi
  fi

  # ── 5. Start or restart service ────────────────────────────────────────
  local start_service
  start_service=$(scenario_field "$idx" ".start_service // false")

  local phase_name="${scenario_prefix}_service"
  log_phase "$scenario_num.5" "Service"
  local start
  start=$(timer_start)
  LAST_ERROR_DETAIL=""

  if [ "$start_service" = "true" ]; then
    if phase_service; then
      record_phase "$phase_name" "pass" "$(timer_elapsed "$start")"
    else
      # Attempt auto-fix only if it looks like a code error
      local fix_output="${LAST_BUILD_OUTPUT:-$LAST_ERROR_DETAIL}"
      if is_fixable_error "$phase_name" "$fix_output" && \
         attempt_autofix "$phase_name" "$CLONE_DIR" "$fix_output" "npm run build"; then
        record_phase "$phase_name" "pass" "$(timer_elapsed "$start")" "" "auto-fixed"
      else
        record_phase "$phase_name" "fail" "$(timer_elapsed "$start")" "service start failed" "$LAST_ERROR_DETAIL"
        FAILED_PHASE="$phase_name"
        return 1
      fi
    fi
  else
    if phase_restart_service; then
      record_phase "$phase_name" "pass" "$(timer_elapsed "$start")"
    else
      local fix_output="${LAST_BUILD_OUTPUT:-$LAST_ERROR_DETAIL}"
      if is_fixable_error "$phase_name" "$fix_output" && \
         attempt_autofix "$phase_name" "$CLONE_DIR" "$fix_output" "npm run build"; then
        record_phase "$phase_name" "pass" "$(timer_elapsed "$start")" "" "auto-fixed"
      else
        record_phase "$phase_name" "fail" "$(timer_elapsed "$start")" "service restart failed" "$LAST_ERROR_DETAIL"
        FAILED_PHASE="$phase_name"
        return 1
      fi
    fi
  fi

  # ── 6. E2E verification ───────────────────────────────────────────────
  local e2e_list
  e2e_list=$(scenario_array "$idx" "e2e")

  if [ -n "$e2e_list" ] && [ "$SKIP_E2E" != true ]; then
    for channel in $e2e_list; do
      local phase_name="${scenario_prefix}_e2e_${channel}"
      local display
      display=$(get_channel_config "$channel" "display")
      log_phase "$scenario_num.6" "E2E: ${display}"
      local start
      start=$(timer_start)

      if run_channel_e2e "$channel"; then
        record_phase "$phase_name" "pass" "$(timer_elapsed "$start")"
      else
        record_phase "$phase_name" "fail" "$(timer_elapsed "$start")" "${display} E2E round-trip failed"
        FAILED_PHASE="$phase_name"
        return 1
      fi
    done
  elif [ "$SKIP_E2E" = true ] && [ -n "$e2e_list" ]; then
    for channel in $e2e_list; do
      record_phase "${scenario_prefix}_e2e_${channel}" "skip" "0"
    done
  fi

  log_ok "Scenario ${scenario_num} complete: ${name}"
  return 0
}

# ── Run all scenarios in the playbook ────────────────────────────────────────
#
# Usage: run_playbook
# Requires PLAYBOOK_JSON to be set (call parse_playbook first).

run_playbook() {
  log_info "Running ${SCENARIO_COUNT} scenario(s) from playbook"

  for i in $(seq 0 $((SCENARIO_COUNT - 1))); do
    if ! run_scenario "$i"; then
      return 1
    fi
  done

  return 0
}
