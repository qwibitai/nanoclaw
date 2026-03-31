#!/usr/bin/env bash
# tool-log.sh — view and tail the agent tool call log (data/tool-calls.jsonl)
#
# Usage:
#   ./scripts/tool-log.sh              # tail live (all groups)
#   ./scripts/tool-log.sh -g discord-general  # filter by group
#   ./scripts/tool-log.sh -t message          # filter by tool type
#   ./scripts/tool-log.sh -e                  # errors only
#   ./scripts/tool-log.sh -n 50               # last 50 entries (no tail)
#   ./scripts/tool-log.sh -s                  # summary: counts by type

set -euo pipefail

LOG="${DATA_DIR:-data}/tool-calls.jsonl"

if [ ! -f "$LOG" ]; then
  echo "No tool call log found at $LOG" >&2
  exit 1
fi

GROUP=""
TYPE=""
ERRORS_ONLY=false
LAST_N=""
SUMMARY=false

while getopts "g:t:en:s" opt; do
  case $opt in
    g) GROUP="$OPTARG" ;;
    t) TYPE="$OPTARG" ;;
    e) ERRORS_ONLY=true ;;
    n) LAST_N="$OPTARG" ;;
    s) SUMMARY=true ;;
    *) echo "Usage: $0 [-g group] [-t type] [-e] [-n N] [-s]" >&2; exit 1 ;;
  esac
done

# Build jq filter
FILTER="."
if [ -n "$GROUP" ]; then
  FILTER="$FILTER | select(.group == \"$GROUP\")"
fi
if [ -n "$TYPE" ]; then
  FILTER="$FILTER | select(.type == \"$TYPE\")"
fi
if [ "$ERRORS_ONLY" = true ]; then
  FILTER="$FILTER | select(.ok == false)"
fi

# Pretty format per line
FORMAT='"\(.ts) [\(.group)\(if .thread then "/"+.thread else "" end)] \(.type) \(if .ok then "✓" else "✗" end) \(.durationMs)ms\(if .error then " ERROR: "+.error else "" end)"'

if [ "$SUMMARY" = true ]; then
  echo "=== Tool call summary ==="
  < "$LOG" jq -r "$FILTER | .type" 2>/dev/null | sort | uniq -c | sort -rn
  echo ""
  echo "=== Errors ==="
  < "$LOG" jq -r ". | select(.ok == false) | \"\(.ts) [\(.group)] \(.type) \(.error // \"unknown\")\"" 2>/dev/null | tail -20
  exit 0
fi

if [ -n "$LAST_N" ]; then
  < "$LOG" jq -r "$FILTER | $FORMAT" 2>/dev/null | tail -"$LAST_N"
else
  # Live tail
  echo "Tailing $LOG (Ctrl+C to stop)..."
  tail -f "$LOG" | jq -r --unbuffered "$FILTER | $FORMAT" 2>/dev/null
fi
