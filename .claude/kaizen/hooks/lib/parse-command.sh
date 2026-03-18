#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# parse-command.sh — Shared utilities for hook scripts.
# Source this file from hooks: source "$(dirname "$0")/lib/parse-command.sh"

# Extract the command line from hook input, stripping heredoc bodies.
# Heredocs (<<'EOF' ... EOF, <<EOF, <<-EOF) can contain arbitrary text
# that causes false positives when grepping for command patterns.
#
# Usage:
#   CMD_LINE=$(strip_heredoc_body "$COMMAND")
#
# Returns the command text before the first heredoc delimiter.
# If the command and heredoc are on the same line, returns that first line.
strip_heredoc_body() {
  local cmd="$1"
  local result
  # Match heredoc operators: <<EOF, <<'EOF', <<"EOF", <<-EOF, <<-'EOF', etc.
  # Requires at least one identifier char after << to avoid matching
  # bitshift operators (<<) or arithmetic (1 << 4).
  result=$(echo "$cmd" | sed '/<<[[:space:]]*-\{0,1\}[[:space:]]*['\''\"]\{0,1\}[A-Za-z_][A-Za-z_0-9]*['\''\"]\{0,1\}/,$d')
  if [ -z "$result" ]; then
    result=$(echo "$cmd" | head -1)
  fi
  echo "$result"
}

# Check if a command line contains an actual `gh pr <subcommand>` invocation,
# not just the text inside a string argument (e.g., echo '...gh pr create...').
# Splits by pipe/chain operators and checks if any segment starts with `gh pr`.
# Usage: is_gh_pr_command "$CMD_LINE" "create|merge"
is_gh_pr_command() {
  local cmd_line="$1"
  local subcommands="$2"
  # Split by |, &&, ||, ; then check if any segment starts with gh pr <sub>
  echo "$cmd_line" | sed 's/[|;&]\{1,\}/\n/g' | sed 's/^[[:space:]]*//' | \
    grep -qE "^gh[[:space:]]+pr[[:space:]]+($subcommands)"
}

# Check if a command line contains an actual `git <subcommand>` invocation.
# Same segment-splitting logic as is_gh_pr_command.
# Usage: is_git_command "$CMD_LINE" "push"
is_git_command() {
  local cmd_line="$1"
  local subcommand="$2"
  echo "$cmd_line" | sed 's/[|;&]\{1,\}/\n/g' | sed 's/^[[:space:]]*//' | \
    grep -qE "^git[[:space:]]+${subcommand}"
}

# Extract PR number from a gh pr <subcommand> invocation.
# Usage: PR_NUM=$(extract_pr_number "$CMD_LINE" "merge")
# Returns the number if present, empty string otherwise.
# Works with: "gh pr merge 42", "gh pr merge 42 --repo ...", "gh pr merge"
extract_pr_number() {
  local cmd_line="$1"
  local subcommand="$2"
  echo "$cmd_line" | sed -n "s/.*gh[[:space:]]\{1,\}pr[[:space:]]\{1,\}${subcommand}[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p" | head -1
}

# Detect the GitHub repo (owner/name) from the origin remote URL.
# Returns empty string if detection fails.
detect_gh_repo() {
  local url
  url=$(git remote get-url origin 2>/dev/null || true)
  echo "$url" | sed -n 's|.*github\.com[:/]\([^/]*/[^/.]*\).*|\1|p' | head -1
}

# Extract --repo flag value from a command line.
# Usage: REPO=$(extract_repo_flag "$CMD_LINE")
# Returns the repo (owner/name) if --repo is present, empty string otherwise.
extract_repo_flag() {
  local cmd_line="$1"
  echo "$cmd_line" | sed -n 's/.*--repo[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' | head -1
}

# Get changed file list for a PR command.
# For merge: uses gh pr diff (actual PR files on GitHub).
# For create: uses git diff (local branch vs base).
# Respects --repo flag in the command to avoid cross-repo false positives.
# Usage: CHANGED_FILES=$(get_pr_changed_files "$CMD_LINE" "$is_merge")
get_pr_changed_files() {
  local cmd_line="$1"
  local is_merge="$2"

  if [ "$is_merge" = true ]; then
    local pr_num repo_flag
    pr_num=$(extract_pr_number "$cmd_line" "merge")
    # Prefer --repo from the command itself, fall back to origin remote
    local repo
    repo=$(extract_repo_flag "$cmd_line")
    if [ -z "$repo" ]; then
      repo=$(detect_gh_repo)
    fi
    repo_flag=""
    if [ -n "$repo" ]; then
      repo_flag="--repo $repo"
    fi
    local result=""
    if [ -n "$pr_num" ]; then
      result=$(gh pr diff "$pr_num" --name-only $repo_flag 2>/dev/null || true)
    else
      result=$(gh pr diff --name-only $repo_flag 2>/dev/null || true)
    fi
    if [ -z "$result" ]; then
      echo "⚠️  Could not fetch PR diff from GitHub, falling back to local git diff" >&2
      result=$(git diff --name-only main...HEAD 2>/dev/null || true)
    fi
    echo "$result"
  else
    git diff --name-only main...HEAD 2>/dev/null || true
  fi
}
