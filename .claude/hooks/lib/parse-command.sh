#!/bin/bash
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
