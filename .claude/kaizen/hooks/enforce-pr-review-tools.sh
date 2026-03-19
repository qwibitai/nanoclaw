#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# enforce-pr-review-tools.sh — Level 3 kaizen enforcement (Issue #46)
# PreToolUse gate for non-Bash tools: blocks Edit, Write, and Agent tools
# until the agent completes the mandatory PR self-review.
#
# Companion to enforce-pr-review.sh (which handles Bash commands with
# an allowlist for review commands like gh pr diff). This hook is simpler:
# during an active review, these tools are generally blocked because the agent
# should be reviewing, not editing or spawning subagents.
#
# Exceptions:
#   - Agent(kaizen-bg, background=true): parallel kaizen reflection (kaizen #151)
#
# Read-only tools (Read, Glob, Grep) are NOT blocked because they're useful
# for reviewing code during the review process.

source "$(dirname "$0")/lib/state-utils.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

# Uses shared find_needs_review_state from state-utils.sh
REVIEW_INFO=$(find_needs_review_state)
if [ $? -ne 0 ] || [ -z "$REVIEW_INFO" ]; then
  # No active review — allow everything
  exit 0
fi

PR_URL=$(echo "$REVIEW_INFO" | cut -d'|' -f1)
ROUND=$(echo "$REVIEW_INFO" | cut -d'|' -f2)

# Allow Agent tool with kaizen-bg subagent (kaizen #151)
# Background kaizen reflection should not be blocked by the review gate
if [ "$TOOL_NAME" = "Agent" ]; then
  SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')
  if [ "$SUBAGENT_TYPE" = "kaizen-bg" ]; then
    exit 0
  fi
fi

# Block the tool — agent must review first
jq -n \
  --arg tool "$TOOL_NAME" \
  --arg pr_url "$PR_URL" \
  --arg round "$ROUND" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("BLOCKED: " + $tool + " is not allowed during PR review.\n\nYou have an active PR review that must be completed first:\n  PR: " + $pr_url + " (round " + $round + ")\n\nRun `gh pr diff " + $pr_url + "` to review the diff, then work through the\nself-review checklist. Only after reviewing can you proceed with other work.")
    }
  }'

exit 0
