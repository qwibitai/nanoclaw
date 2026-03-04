#!/bin/bash
# auto-fix.sh — Invoke Claude Opus to auto-fix code errors during pipeline runs.
#
# When a phase fails with a code error (TS compilation, runtime, test, module),
# this module gathers context, asks Claude for a unified diff fix, applies it,
# and re-runs the failing step. Infrastructure errors are not attempted.
#
# Budget: $1.00 per invocation, max 2 attempts per phase.

# ── Configuration ────────────────────────────────────────────────────────────

AUTOFIX_MAX_ATTEMPTS=2
AUTOFIX_MAX_BUDGET_USD="1.00"
AUTOFIX_MODEL="opus"
AUTOFIX_CLAUDE_BIN="/home/nanoclaw/.local/bin/claude"
AUTOFIX_CLAUDE_USER="nanoclaw"

# ── Tracking arrays (parallel) ──────────────────────────────────────────────

AUTOFIX_PHASE_NAMES=()
AUTOFIX_ATTEMPT_NUMS=()
AUTOFIX_ERRORS_IN=()
AUTOFIX_FIX_TEXT=()
AUTOFIX_OUTCOMES=()        # build_pass | build_fail | patch_fail | parse_fail | claude_fail
AUTOFIX_INPUT_TOKENS=()
AUTOFIX_OUTPUT_TOKENS=()
AUTOFIX_COSTS=()
AUTOFIX_DURATIONS=()

# ── is_fixable_error ─────────────────────────────────────────────────────────
#
# Returns 0 (true) for code errors that Claude might fix.
# Returns 1 (false) for infrastructure errors.
#
# Usage: is_fixable_error <phase_name> <error_detail>

is_fixable_error() {
  local phase="$1"
  local detail="${2:-}"

  # Infrastructure phases — never fixable
  case "$phase" in
    user_create|clone|environment|container_build|mounts|teardown)
      return 1
      ;;
  esac

  # Credential / E2E phases — not code-fixable
  if [[ "$phase" == *_credentials ]]; then
    return 1
  fi
  if [[ "$phase" == *_e2e_* ]]; then
    return 1
  fi

  # Service-only errors (systemd, not code) — check detail
  if [[ "$phase" == *_service ]]; then
    # Service phase failures are typically infra, but if the detail
    # contains code errors (e.g. the service crashed due to TS error),
    # we treat it as fixable
    if echo "$detail" | grep -qiE 'error TS|Cannot find module|TypeError|ReferenceError|SyntaxError'; then
      return 0
    fi
    return 1
  fi

  # Check if the error detail contains code-related patterns
  if [ -n "$detail" ]; then
    if echo "$detail" | grep -qiE 'error TS|Cannot find module|TypeError|ReferenceError|SyntaxError|error:|test.*fail|FAIL.*src/|expect.*received|AssertionError'; then
      return 0
    fi
  fi

  # Install/uninstall/register phases with build steps — likely fixable
  if [[ "$phase" == *_install ]] || [[ "$phase" == *_uninstall ]] || [[ "$phase" == *_register ]]; then
    return 0
  fi

  # Default: not fixable
  return 1
}

# ── gather_fix_context ───────────────────────────────────────────────────────
#
# Extracts file paths from error output, reads their content + tsconfig.json.
#
# Usage: gather_fix_context <clone_dir> <error_output>
# Prints gathered context to stdout.

gather_fix_context() {
  local clone_dir="$1"
  local error_output="$2"
  local context=""

  # Extract .ts/.js file paths from error output
  local file_paths
  file_paths=$(echo "$error_output" | grep -oE '[a-zA-Z0-9_./-]+\.(ts|js|tsx|jsx)' | sort -u | head -10)

  # Read tsconfig.json if it exists
  if [ -f "${clone_dir}/tsconfig.json" ]; then
    context+="=== tsconfig.json ===
$(cat "${clone_dir}/tsconfig.json")

"
  fi

  # Read each referenced source file
  for fpath in $file_paths; do
    local full_path

    # Handle paths that may or may not start with src/
    if [ -f "${clone_dir}/${fpath}" ]; then
      full_path="${clone_dir}/${fpath}"
    elif [ -f "${clone_dir}/src/${fpath}" ]; then
      full_path="${clone_dir}/src/${fpath}"
    else
      continue
    fi

    # Relativize path for the diff
    local rel_path="${full_path#${clone_dir}/}"
    context+="=== ${rel_path} ===
$(cat "$full_path")

"
  done

  # If no files found from error output, try to grab recent service logs
  if [ -z "$file_paths" ]; then
    local uid
    uid=$(id -u "$TEST_USER" 2>/dev/null) || true
    if [ -n "$uid" ]; then
      local service_log
      service_log=$(sudo -u "$TEST_USER" XDG_RUNTIME_DIR="/run/user/${uid}" \
        journalctl --user -u nanoclaw --no-pager -n 50 2>/dev/null) || true
      if [ -n "$service_log" ]; then
        context+="=== Recent service logs ===
${service_log}

"
      fi
    fi
  fi

  echo "$context"
}

# ── build_fix_prompt ─────────────────────────────────────────────────────────
#
# Constructs the prompt for Claude to fix the error.
#
# Usage: build_fix_prompt <error_output> <context> <attempt_num>

build_fix_prompt() {
  local error_output="$1"
  local context="$2"
  local attempt="$3"

  local prompt="You are fixing a build/test error in a TypeScript Node.js project (NanoClaw).

Project conventions:
- Strict TypeScript with NodeNext module resolution
- ES modules (import/export)
- Target: ES2022

"

  if [ "$attempt" -gt 1 ]; then
    prompt+="IMPORTANT: This is attempt ${attempt}. The previous fix did not resolve the error. Try a different approach.

"
  fi

  prompt+="Error output:
\`\`\`
${error_output}
\`\`\`

Source files and context:
${context}

Fix this error. Output ONLY a unified diff (patch -p1 format). No explanation, no markdown fences, just the diff."

  echo "$prompt"
}

# ── invoke_claude_fix ────────────────────────────────────────────────────────
#
# Calls Claude CLI and returns raw JSON response.
#
# Usage: invoke_claude_fix <prompt>
# Output: JSON response on stdout, exit code from claude CLI.

invoke_claude_fix() {
  local prompt="$1"

  sudo -u "$AUTOFIX_CLAUDE_USER" \
    "$AUTOFIX_CLAUDE_BIN" \
    --print \
    --output-format json \
    --model "$AUTOFIX_MODEL" \
    --max-tokens 4096 \
    --budget-tokens 0 \
    "$prompt" 2>/dev/null
}

# ── parse_claude_response ────────────────────────────────────────────────────
#
# Parses JSON from claude CLI. Sets globals:
#   _PARSED_RESULT, _PARSED_INPUT_TOKENS, _PARSED_OUTPUT_TOKENS, _PARSED_COST
#
# Usage: parse_claude_response <json>
# Returns 0 on success, 1 if parsing failed.

_PARSED_RESULT=""
_PARSED_INPUT_TOKENS=0
_PARSED_OUTPUT_TOKENS=0
_PARSED_COST="0.00"

parse_claude_response() {
  local json="$1"

  if [ -z "$json" ]; then
    return 1
  fi

  _PARSED_RESULT=$(echo "$json" | jq -r '.result // empty' 2>/dev/null)
  if [ -z "$_PARSED_RESULT" ]; then
    return 1
  fi

  _PARSED_INPUT_TOKENS=$(echo "$json" | jq -r '.usage.input_tokens // 0' 2>/dev/null)
  _PARSED_OUTPUT_TOKENS=$(echo "$json" | jq -r '.usage.output_tokens // 0' 2>/dev/null)
  _PARSED_COST=$(echo "$json" | jq -r '.total_cost_usd // "0.00"' 2>/dev/null)

  return 0
}

# ── apply_fix ────────────────────────────────────────────────────────────────
#
# Applies a unified diff to the clone directory.
# Does a dry-run first, then applies.
#
# Usage: apply_fix <clone_dir> <diff_text>
# Returns 0 on success, 1 on failure.

apply_fix() {
  local clone_dir="$1"
  local diff_text="$2"

  # Strip markdown fences if Claude included them despite instructions
  diff_text=$(echo "$diff_text" | sed '/^```\(diff\)\?$/d')

  # Dry run first
  if ! echo "$diff_text" | patch -d "$clone_dir" --dry-run -p1 --force --silent 2>/dev/null; then
    log_warn "Auto-fix: patch dry-run failed"
    return 1
  fi

  # Apply for real
  if ! echo "$diff_text" | patch -d "$clone_dir" -p1 --force 2>/dev/null; then
    log_warn "Auto-fix: patch apply failed"
    return 1
  fi

  # Fix ownership
  chown -R "$TEST_USER:$TEST_USER" "$clone_dir"

  return 0
}

# ── attempt_autofix ──────────────────────────────────────────────────────────
#
# Full auto-fix loop: gather context, invoke Claude, parse, patch, re-run.
# Up to AUTOFIX_MAX_ATTEMPTS attempts.
#
# Usage: attempt_autofix <phase_name> <clone_dir> <error_output> <rerun_cmd>
# Returns 0 if the fix succeeded (rerun passes), 1 otherwise.
#
# Side effects: appends to AUTOFIX_* tracking arrays.

attempt_autofix() {
  local phase="$1"
  local clone_dir="$2"
  local error_output="$3"
  local rerun_cmd="$4"

  log_info "Auto-fix: attempting to fix ${phase} (max ${AUTOFIX_MAX_ATTEMPTS} attempts)"

  local attempt
  for attempt in $(seq 1 "$AUTOFIX_MAX_ATTEMPTS"); do
    log_info "Auto-fix: attempt ${attempt}/${AUTOFIX_MAX_ATTEMPTS} for ${phase}"
    local attempt_start
    attempt_start=$(timer_start)

    # Gather context
    local context
    context=$(gather_fix_context "$clone_dir" "$error_output")

    # Build prompt
    local prompt
    prompt=$(build_fix_prompt "$error_output" "$context" "$attempt")

    # Invoke Claude
    local claude_response
    claude_response=$(invoke_claude_fix "$prompt")
    local claude_exit=$?

    local duration
    duration=$(timer_elapsed "$attempt_start")

    if [ $claude_exit -ne 0 ] || [ -z "$claude_response" ]; then
      log_warn "Auto-fix: Claude invocation failed (attempt ${attempt})"
      _record_attempt "$phase" "$attempt" "$error_output" "" "claude_fail" 0 0 "0.00" "$duration"
      continue
    fi

    # Parse response
    if ! parse_claude_response "$claude_response"; then
      log_warn "Auto-fix: failed to parse Claude response (attempt ${attempt})"
      _record_attempt "$phase" "$attempt" "$error_output" "" "parse_fail" 0 0 "0.00" "$duration"
      continue
    fi

    local fix_text="$_PARSED_RESULT"
    local in_tokens="$_PARSED_INPUT_TOKENS"
    local out_tokens="$_PARSED_OUTPUT_TOKENS"
    local cost="$_PARSED_COST"

    # Apply the fix
    if ! apply_fix "$clone_dir" "$fix_text"; then
      _record_attempt "$phase" "$attempt" "$error_output" "$fix_text" "patch_fail" "$in_tokens" "$out_tokens" "$cost" "$duration"
      continue
    fi

    # Re-run the failing command
    log_info "Auto-fix: re-running: ${rerun_cmd}"
    local rerun_output
    rerun_output=$(run_as_user "cd ${clone_dir} && ${rerun_cmd}" 2>&1)
    local rerun_exit=$?

    duration=$(timer_elapsed "$attempt_start")

    if [ $rerun_exit -eq 0 ]; then
      log_ok "Auto-fix: ${phase} fixed on attempt ${attempt} (\$${cost}, ${in_tokens}/${out_tokens} tokens)"
      _record_attempt "$phase" "$attempt" "$error_output" "$fix_text" "build_pass" "$in_tokens" "$out_tokens" "$cost" "$duration"
      return 0
    else
      log_warn "Auto-fix: re-run still failed after attempt ${attempt}"
      # Update error_output for next attempt so Claude sees the new error
      error_output="$rerun_output"
      _record_attempt "$phase" "$attempt" "$error_output" "$fix_text" "build_fail" "$in_tokens" "$out_tokens" "$cost" "$duration"
    fi
  done

  log_error "Auto-fix: exhausted ${AUTOFIX_MAX_ATTEMPTS} attempts for ${phase}"
  return 1
}

# ── Internal: record an attempt ──────────────────────────────────────────────

_record_attempt() {
  local phase="$1"
  local attempt_num="$2"
  local error_in="$3"
  local fix_text="$4"
  local outcome="$5"
  local in_tokens="$6"
  local out_tokens="$7"
  local cost="$8"
  local duration="$9"

  AUTOFIX_PHASE_NAMES+=("$phase")
  AUTOFIX_ATTEMPT_NUMS+=("$attempt_num")
  AUTOFIX_ERRORS_IN+=("$error_in")
  AUTOFIX_FIX_TEXT+=("$fix_text")
  AUTOFIX_OUTCOMES+=("$outcome")
  AUTOFIX_INPUT_TOKENS+=("$in_tokens")
  AUTOFIX_OUTPUT_TOKENS+=("$out_tokens")
  AUTOFIX_COSTS+=("$cost")
  AUTOFIX_DURATIONS+=("$duration")
}
