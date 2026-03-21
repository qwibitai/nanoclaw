#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# pr-kaizen-clear.sh — Level 3 kaizen enforcement (Issue #57, #113, #140, #162, #205, #213)
# PostToolUse hook: clears the PR creation kaizen gate when the agent
# submits a valid KAIZEN_IMPEDIMENTS JSON declaration covering all
# identified impediments with proper dispositions.
#
# Triggers on:
#   1. Bash: echo "KAIZEN_IMPEDIMENTS: [...]" (structured impediment declaration)
#   2. Bash: echo "KAIZEN_NO_ACTION [category]: <reason>" (restricted — kaizen #140)
#
# Validation (kaizen #113, #162, #213, #280):
#   - JSON must be a valid array
#   - Each entry must have "impediment" or "finding" (non-empty string) and "disposition"
#   - disposition "filed" or "incident" requires "ref" field
#   - disposition "waived" or "no-action" requires "reason" field
#   - type "meta" findings: disposition must be "filed" or "waived" (not "no-action")
#   - type "positive" findings: also allows "no-action" (with reason)
#   - no type / other: standard dispositions (filed|incident|fixed-in-pr|waived)
#   - Empty array [] requires a "reason" string after it (kaizen #140)
#
# Waiver quality enforcement (kaizen #280, #258, #198):
#   - Waiver reasons are checked against a blocklist of known-bad rationalizations
#   - Meta-findings (type "meta") waived must include "impact_minutes" estimate
#   - Meta-findings with impact_minutes >= 5 cannot be waived (must file instead)
#   - All waivers are logged to audit/waiver.log
#
# Advisory nudge (kaizen #205):
#   - When ALL findings are waived/no-action, prints advisory before clearing
#
# KAIZEN_NO_ACTION validation (kaizen #140):
#   - Must include a category: docs-only|formatting|typo|config-only|test-only|trivial-refactor
#   - All no-action declarations are logged to .claude/kaizen/audit/no-action.log
#
# Always exits 0 — this is state management, not a gate.

source "$(dirname "$0")/lib/parse-command.sh"
source "$(dirname "$0")/lib/state-utils.sh"

# Audit log for no-action declarations (kaizen #140)
# Finds the repo root relative to this hook's location (.claude/kaizen/hooks/)
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
AUDIT_LOG="${HOOK_DIR}/../audit/no-action.log"

log_no_action() {
  local category="$1"
  local reason="$2"
  local pr_url="${3:-unknown}"
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Ensure audit directory exists
  mkdir -p "$(dirname "$AUDIT_LOG")" 2>/dev/null

  # Append to audit log
  printf '%s | branch=%s | category=%s | pr=%s | reason=%s\n' \
    "$timestamp" "$branch" "$category" "$pr_url" "$reason" >> "$AUDIT_LOG" 2>/dev/null || true
}

# Waiver audit log (kaizen #280)
WAIVER_LOG="${HOOK_DIR}/../audit/waiver.log"

log_waiver() {
  local desc="$1"
  local reason="$2"
  local finding_type="${3:-impediment}"
  local pr_url="${4:-unknown}"
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  mkdir -p "$(dirname "$WAIVER_LOG")" 2>/dev/null
  printf '%s | branch=%s | type=%s | pr=%s | desc=%s | reason=%s\n' \
    "$timestamp" "$branch" "$finding_type" "$pr_url" "$desc" "$reason" >> "$WAIVER_LOG" 2>/dev/null || true
}

# Waiver reason blocklist (kaizen #280, #258)
# These rationalizations sound reasonable but are category errors:
# - "Low frequency" ignores impact-per-occurrence
# - "Overengineering" confuses filing with implementing
# - "Self-correcting" assumes future agents will do better without evidence
WAIVER_BLOCKLIST_PATTERNS=(
  "low frequency"
  "rare enough"
  "rarely happens"
  "infrequent"
  "overengineering"
  "over-engineering"
  "not worth"
  "too much work"
  "too much effort"
  "self-correct"
  "self correct"
  "acceptable tradeoff"
  "acceptable trade-off"
  "minor enough"
  "not important enough"
  "won.t happen again"
  "unlikely to recur"
  "edge case"
)

check_waiver_blocklist() {
  local reason_lower
  reason_lower=$(echo "$1" | tr '[:upper:]' '[:lower:]')
  for pattern in "${WAIVER_BLOCKLIST_PATTERNS[@]}"; do
    if echo "$reason_lower" | grep -qi "$pattern"; then
      echo "$pattern"
      return 0
    fi
  done
  return 1
}

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"')

# Only process Bash tool calls
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Only process successful commands
if [ "$EXIT_CODE" != "0" ]; then
  exit 0
fi

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Check if there's an active PR kaizen gate to clear (kaizen #239)
# Use cross-branch lookup — the agent may submit the declaration from a
# different worktree than where the PR was created.
STATE_INFO=$(find_state_with_status_any_branch "needs_pr_kaizen")
if [ $? -ne 0 ] || [ -z "$STATE_INFO" ]; then
  exit 0
fi

# Extract PR URL for audit logging
GATE_PR_URL=$(echo "$STATE_INFO" | cut -d'|' -f1)

SHOULD_CLEAR=false
CLEAR_REASON=""
ALL_PASSIVE=false

# Trigger 1: KAIZEN_IMPEDIMENTS structured declaration (kaizen #113)
if echo "$CMD_LINE" | grep -qE 'KAIZEN_IMPEDIMENTS:'; then
  # Extract JSON from command or stdout
  # The agent runs: echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS' ... IMPEDIMENTS
  # Or inline: echo 'KAIZEN_IMPEDIMENTS: [...]'
  JSON=""

  # Try extracting from stdout first (the echo output)
  # For "KAIZEN_IMPEDIMENTS: [] reason text", we need to extract just the JSON part
  RAW_AFTER_PREFIX=""
  if [ -n "$STDOUT" ]; then
    RAW_AFTER_PREFIX=$(echo "$STDOUT" | sed -n '/KAIZEN_IMPEDIMENTS:/,$ p' | sed '1s/.*KAIZEN_IMPEDIMENTS:[[:space:]]*//' | tr '\n' ' ')
  fi

  # Fallback 1: STDOUT may contain just the JSON without the prefix (kaizen #313)
  # This happens when echo and cat outputs are captured separately or prefix is missing
  if [ -z "$RAW_AFTER_PREFIX" ] && [ -n "$STDOUT" ]; then
    # Try parsing STDOUT directly as JSON array
    TRIMMED_STDOUT=$(echo "$STDOUT" | tr '\n' ' ' | sed 's/^[[:space:]]*//')
    if echo "$TRIMMED_STDOUT" | jq 'type == "array"' 2>/dev/null | grep -q true; then
      RAW_AFTER_PREFIX="$TRIMMED_STDOUT"
    fi
  fi

  # Fallback 2: extract heredoc body from the FULL command (kaizen #313)
  # CMD_LINE has heredoc stripped; COMMAND still has it. Extract the heredoc body
  # (everything between the delimiter lines) and try to parse as JSON.
  if [ -z "$RAW_AFTER_PREFIX" ]; then
    # Extract text between heredoc delimiters, collapse to one line, try as JSON
    HEREDOC_BODY=$(echo "$COMMAND" | sed -n '/<<.*IMPEDIMENTS/,/^IMPEDIMENTS/{ /<<.*IMPEDIMENTS/d; /^IMPEDIMENTS/d; p; }' | tr '\n' ' ')
    if [ -n "$HEREDOC_BODY" ] && echo "$HEREDOC_BODY" | jq 'type == "array"' 2>/dev/null | grep -q true; then
      RAW_AFTER_PREFIX="$HEREDOC_BODY"
    fi
  fi

  # Fallback 3: extract from CMD_LINE (inline echo, no heredoc)
  if [ -z "$RAW_AFTER_PREFIX" ]; then
    RAW_AFTER_PREFIX=$(echo "$CMD_LINE" | sed -n 's/.*KAIZEN_IMPEDIMENTS:[[:space:]]*//p' | tr '\n' ' ')
  fi

  # Extract JSON array from the raw text — handle "[] reason" by extracting just the array
  if [ -n "$RAW_AFTER_PREFIX" ]; then
    # Try parsing the whole thing as JSON first
    if echo "$RAW_AFTER_PREFIX" | jq empty 2>/dev/null; then
      JSON="$RAW_AFTER_PREFIX"
    else
      # Check for empty array with trailing reason text: "[] some reason"
      TRIMMED=$(echo "$RAW_AFTER_PREFIX" | sed 's/^[[:space:]]*//')
      if echo "$TRIMMED" | grep -qE '^\[\]'; then
        JSON="[]"
      else
        JSON=""
      fi
    fi
  fi

  # Validate the JSON
  if [ -z "$JSON" ] || ! echo "$JSON" | jq empty 2>/dev/null; then
    cat <<'EOF'

KAIZEN_IMPEDIMENTS: Invalid JSON. Expected a JSON array, e.g.:
  echo 'KAIZEN_IMPEDIMENTS: []'
  or
  echo 'KAIZEN_IMPEDIMENTS:' && cat <<'IMPEDIMENTS'
  [{"impediment": "...", "disposition": "filed", "ref": "#NNN"}]
  IMPEDIMENTS
EOF
    exit 0
  fi

  # Validate it's an array
  IS_ARRAY=$(echo "$JSON" | jq 'type == "array"' 2>/dev/null)
  if [ "$IS_ARRAY" != "true" ]; then
    cat <<'EOF'

KAIZEN_IMPEDIMENTS: Expected a JSON array, got a different type.
  Use [] for no impediments, or [{"impediment": "...", ...}, ...] for a list.
EOF
    exit 0
  fi

  # Empty array requires a reason string (kaizen #140)
  # Format: KAIZEN_IMPEDIMENTS: [] reason-text
  # Or JSON: {"impediments": [], "reason": "..."}
  ITEM_COUNT=$(echo "$JSON" | jq 'length' 2>/dev/null)
  if [ "$ITEM_COUNT" = "0" ]; then
    # Extract reason: look for text after [] in RAW_AFTER_PREFIX
    EMPTY_REASON=$(echo "$RAW_AFTER_PREFIX" | sed 's/^[[:space:]]*\[\][[:space:]]*//' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
    # Filter out any stray characters (e.g. quote marks from echo commands)
    EMPTY_REASON=$(echo "$EMPTY_REASON" | sed "s/^['\"]//;s/['\"]$//")

    if [ -z "$EMPTY_REASON" ]; then
      cat <<'EOF'

KAIZEN_IMPEDIMENTS: Empty array requires a reason.
  Provide a brief justification after the empty array:
  echo 'KAIZEN_IMPEDIMENTS: [] straightforward bug fix, no process issues'

  If your reflection identified ANY concrete improvement, use the full
  structured format with dispositions instead of an empty array.
EOF
      exit 0
    fi

    # Log the no-action declaration (kaizen #140 — auditable bypass)
    log_no_action "empty-array" "$EMPTY_REASON" "$GATE_PR_URL"

    SHOULD_CLEAR=true
    CLEAR_REASON="no impediments identified ($EMPTY_REASON)"
  else
    # Validate each entry (type-aware validation — kaizen #162, #205, #213)
    # - "finding" accepted as alias for "impediment" (kaizen #162)
    # - type "meta": only filed (with ref) or waived (with reason)
    # - type "positive": also allows no-action (with reason)
    # - no type / other: standard dispositions (filed|incident|fixed-in-pr|waived)
    VALIDATION=$(echo "$JSON" | jq -r '
      [.[] | {
        desc: ((.impediment // .finding) // ""),
        type: (.type // ""),
        disposition: (.disposition // ""),
        ref: (.ref // ""),
        reason: (.reason // "")
      } |
      if .desc == "" then
        "missing \"impediment\" or \"finding\" field"
      elif .disposition == "" then
        "missing \"disposition\" for: \(.desc)"
      elif .type == "meta" and (.disposition | IN("filed", "fixed-in-pr", "waived") | not) then
        "meta-finding \"\(.desc)\" has disposition \"\(.disposition)\" — meta-findings must be \"filed\" (with ref), \"fixed-in-pr\", or \"waived\" (with reason). If it is truly not actionable, use \"waived\" and explain why."
      elif .type == "positive" and (.disposition | IN("filed", "incident", "fixed-in-pr", "waived", "no-action") | not) then
        "invalid disposition \"\(.disposition)\" for: \(.desc) (must be filed|incident|fixed-in-pr|waived|no-action)"
      elif (.type != "meta" and .type != "positive") and (.disposition | IN("filed", "incident", "fixed-in-pr", "waived") | not) then
        "invalid disposition \"\(.disposition)\" for: \(.desc) (must be filed|incident|fixed-in-pr|waived)"
      elif (.disposition == "filed" or .disposition == "incident") and .ref == "" then
        "disposition \"\(.disposition)\" requires \"ref\" field for: \(.desc)"
      elif (.disposition == "waived" or .disposition == "no-action") and .reason == "" then
        "disposition \"\(.disposition)\" requires \"reason\" field for: \(.desc)"
      else
        empty
      end
      ] | join("\n")
    ' 2>/dev/null)

    if [ -n "$VALIDATION" ]; then
      printf '\nKAIZEN_IMPEDIMENTS: Validation failed:\n%s\n\nFix the issues and resubmit.\n' "$VALIDATION"
      exit 0
    fi

    # Waiver quality enforcement (kaizen #280, #258, #198)
    # Check each waived finding for blocklisted reasons and meta-finding impact
    WAIVER_ERRORS=""
    WAIVER_COUNT=0
    while IFS='|' read -r w_desc w_type w_reason w_impact; do
      [ -z "$w_desc" ] && continue
      WAIVER_COUNT=$((WAIVER_COUNT + 1))

      # Check blocklist
      MATCHED_PATTERN=$(check_waiver_blocklist "$w_reason")
      if [ $? -eq 0 ]; then
        WAIVER_ERRORS="${WAIVER_ERRORS}waiver for \"${w_desc}\" uses blocklisted rationalization \"${MATCHED_PATTERN}\". Filing an issue is not implementing a fix — if the observation is true, file it. Reconsider: is this actually not worth a 2-minute issue?\n"
      fi

      # Meta-findings require impact_minutes (kaizen #280)
      if [ "$w_type" = "meta" ]; then
        if [ -z "$w_impact" ] || [ "$w_impact" = "null" ]; then
          WAIVER_ERRORS="${WAIVER_ERRORS}meta-finding \"${w_desc}\" waived without impact_minutes. Add \"impact_minutes\": N (estimated minutes of agent/human time wasted per occurrence). If impact >= 5, file instead of waiving.\n"
        elif [ "$w_impact" -ge 5 ] 2>/dev/null; then
          WAIVER_ERRORS="${WAIVER_ERRORS}meta-finding \"${w_desc}\" has impact_minutes=${w_impact} (>= 5 min/occurrence) — too high to waive. File it: \`gh issue create --repo Garsson-io/kaizen ...\`\n"
        fi
      fi

      # Log all waivers to audit trail
      log_waiver "$w_desc" "$w_reason" "$w_type" "$GATE_PR_URL"
    done < <(echo "$JSON" | jq -r '
      [.[] | select(.disposition == "waived")] |
      .[] | [
        ((.impediment // .finding) // ""),
        (.type // ""),
        (.reason // ""),
        (.impact_minutes // "null" | tostring)
      ] | join("|")
    ' 2>/dev/null)

    if [ -n "$WAIVER_ERRORS" ]; then
      printf '\nKAIZEN_IMPEDIMENTS: Waiver quality check failed (kaizen #280):\n%b\nKnown anti-patterns:\n- "Low frequency" ignores impact-per-occurrence. A 15-min blocker that happens once a week is worth filing.\n- "Overengineering" confuses filing with implementing. Filing takes 2 min; implementation is a separate decision.\n- "Self-correcting" assumes future agents improve without evidence. They don'"'"'t — that'"'"'s why this check exists.\n\nFix the issues and resubmit. To file: \`gh issue create --repo Garsson-io/kaizen --title "[LN] description" --label kaizen,level-N,area/...\`\n' "$WAIVER_ERRORS"
      exit 0
    fi

    # All-passive advisory (kaizen #205): nudge when every disposition is waived/no-action
    ALL_PASSIVE=$(echo "$JSON" | jq '[.[] | .disposition] | all(. == "waived" or . == "no-action")' 2>/dev/null)

    SHOULD_CLEAR=true
    CLEAR_REASON="$ITEM_COUNT finding(s) addressed"
  fi
fi

# Trigger 2: KAIZEN_NO_ACTION declaration (kaizen #140 — restricted categories)
# Format: echo "KAIZEN_NO_ACTION [category]: reason"
# Valid categories: docs-only, formatting, typo, config-only, test-only, trivial-refactor
VALID_NO_ACTION_CATEGORIES="docs-only|formatting|typo|config-only|test-only|trivial-refactor"

if [ "$SHOULD_CLEAR" != "true" ] && echo "$CMD_LINE" | grep -qE 'KAIZEN_NO_ACTION'; then
  # Extract category and reason from the declaration
  # Pattern: KAIZEN_NO_ACTION [category]: reason
  # Also check stdout for the output
  NO_ACTION_TEXT=""
  if [ -n "$STDOUT" ]; then
    NO_ACTION_TEXT=$(echo "$STDOUT" | grep -oP 'KAIZEN_NO_ACTION\s*\[?\K[^\]]*\]?:\s*.*' | head -1)
  fi
  if [ -z "$NO_ACTION_TEXT" ]; then
    NO_ACTION_TEXT=$(echo "$CMD_LINE" | grep -oP 'KAIZEN_NO_ACTION\s*\[?\K[^\]]*\]?:\s*.*' | head -1)
  fi

  # Extract category (text before ]:)
  NO_ACTION_CATEGORY=$(echo "$NO_ACTION_TEXT" | sed -n 's/^\s*\([a-z-]*\)\].*$/\1/p')
  # Also try without brackets: KAIZEN_NO_ACTION category: reason
  if [ -z "$NO_ACTION_CATEGORY" ]; then
    NO_ACTION_CATEGORY=$(echo "$CMD_LINE" | grep -oP 'KAIZEN_NO_ACTION\s+\[\K[a-z-]+(?=\])' | head -1)
  fi
  if [ -z "$NO_ACTION_CATEGORY" ]; then
    NO_ACTION_CATEGORY=$(echo "$CMD_LINE" | grep -oP 'KAIZEN_NO_ACTION\s*\[\K[a-z-]+' | head -1)
  fi

  # Extract reason (text after category]:)
  NO_ACTION_REASON=$(echo "$CMD_LINE" | grep -oP 'KAIZEN_NO_ACTION\s*\[[a-z-]+\]:\s*\K.*' | head -1)
  if [ -z "$NO_ACTION_REASON" ] && [ -n "$STDOUT" ]; then
    NO_ACTION_REASON=$(echo "$STDOUT" | grep -oP 'KAIZEN_NO_ACTION\s*\[[a-z-]+\]:\s*\K.*' | head -1)
  fi
  # Clean up: remove surrounding quotes and trailing whitespace from command wrapping
  NO_ACTION_REASON=$(echo "$NO_ACTION_REASON" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//;s/^['\"]//;s/['\"]$//;s/^[[:space:]]*//;s/[[:space:]]*$//")

  # Validate category exists
  if [ -z "$NO_ACTION_CATEGORY" ]; then
    cat <<EOF

KAIZEN_NO_ACTION: Missing category. Format: KAIZEN_NO_ACTION [category]: reason
  Valid categories: ${VALID_NO_ACTION_CATEGORIES//|/, }

  Example: echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'

  KAIZEN_NO_ACTION is for trivial changes only. If your reflection
  identified ANY concrete improvement, use KAIZEN_IMPEDIMENTS instead.
EOF
    exit 0
  fi

  # Validate category is in the allowed set
  if ! echo "$NO_ACTION_CATEGORY" | grep -qE "^($VALID_NO_ACTION_CATEGORIES)$"; then
    cat <<EOF

KAIZEN_NO_ACTION: Invalid category "$NO_ACTION_CATEGORY".
  Valid categories: ${VALID_NO_ACTION_CATEGORIES//|/, }

  Example: echo 'KAIZEN_NO_ACTION [docs-only]: updated README formatting'
EOF
    exit 0
  fi

  # Validate reason is non-empty
  if [ -z "$NO_ACTION_REASON" ]; then
    cat <<EOF

KAIZEN_NO_ACTION: Missing reason after category.
  Format: KAIZEN_NO_ACTION [$NO_ACTION_CATEGORY]: your reason here
EOF
    exit 0
  fi

  # Log the no-action declaration (kaizen #140 — auditable bypass)
  log_no_action "$NO_ACTION_CATEGORY" "$NO_ACTION_REASON" "$GATE_PR_URL"

  SHOULD_CLEAR=true
  CLEAR_REASON="no action needed [$NO_ACTION_CATEGORY]: $NO_ACTION_REASON"
fi

if [ "$SHOULD_CLEAR" = true ]; then
  # All-passive advisory (kaizen #205): print nudge before clearing
  if [ "$ALL_PASSIVE" = "true" ]; then
    cat <<'ADVISORY'

All findings waived — none filed or fixed-in-pr.
"Every failure is a gift — if you file the issue."
Are any of these actionable at L2+? If so, file them before proceeding.
ADVISORY
  fi

  clear_state_with_status_any_branch "needs_pr_kaizen" "$GATE_PR_URL"
  # Mark this PR as reflected so duplicate gates are prevented (kaizen #288)
  mark_reflection_done "$GATE_PR_URL"

  # Auto-close referenced kaizen issues if PR is merged (kaizen #283)
  auto_close_kaizen_issues "$GATE_PR_URL" 2>/dev/null || true
  cat <<EOF

PR kaizen gate cleared ($CLEAR_REASON). You may proceed with other work.
EOF
fi

exit 0
