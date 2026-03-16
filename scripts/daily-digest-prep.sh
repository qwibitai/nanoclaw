#!/bin/bash
# Captures host-side info that the container agent can't access.
# Runs ~5 min before the daily digest scheduled task.
# Output goes to groups/telegram_main/ which is mounted at /workspace/group in the container.

set -euo pipefail

# Ensure Homebrew binaries are on PATH (launchd has minimal PATH)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_ROOT/groups/telegram_main/daily-digest-data"

mkdir -p "$OUTPUT_DIR"

# Capture tmux sessions
TMUX_FILE="$OUTPUT_DIR/tmux-status.txt"
if command -v tmux &>/dev/null; then
  {
    echo "Captured at: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo ""
    echo "=== Active Sessions ==="
    tmux list-sessions -F '#{session_name}: #{session_windows} windows (created #{session_created_string}) #{?session_attached,[attached],[detached]}' 2>/dev/null || echo "No active sessions"
    echo ""
    echo "=== Windows & Panes ==="
    tmux list-windows -a -F '#{session_name}:#{window_index} #{window_name} (#{pane_current_path}) #{?window_active,[active],}' 2>/dev/null || echo "No windows"
    echo ""
    echo "=== Running Commands ==="
    tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} in #{pane_current_path}' 2>/dev/null || echo "No panes"
  } > "$TMUX_FILE"
else
  {
    echo "Captured at: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo ""
    echo "tmux is not installed on this machine."
  } > "$TMUX_FILE"
fi

# Capture Simpsons session state (NanoClaw's tmux-based task runner)
SIMPSONS_STATE="$PROJECT_ROOT/data/simpsons/sessions.json"
SIMPSONS_FILE="$OUTPUT_DIR/simpsons-status.txt"
if [ -f "$SIMPSONS_STATE" ] && [ -s "$SIMPSONS_STATE" ]; then
  {
    echo "Captured at: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo ""
    echo "=== Simpsons Sessions (NanoClaw task runner) ==="
    # Parse sessions.json: each entry has sessionName, project, command, startedAt
    python3 -c "
import json, sys
from datetime import datetime
sessions = json.load(open('$SIMPSONS_STATE'))
if not sessions:
    print('No active Simpsons sessions')
    sys.exit(0)
for s in sessions:
    started = datetime.fromisoformat(s['startedAt'].replace('Z', '+00:00'))
    elapsed = datetime.now(started.tzinfo) - started if started.tzinfo else 'unknown'
    print(f\"• {s['project']} ({s['command']}) — session: {s['sessionName']}\")
    print(f\"  Started: {s['startedAt']}, Elapsed: {elapsed}\")
" 2>/dev/null || echo "Could not parse Simpsons state"
  } > "$SIMPSONS_FILE"
else
  {
    echo "Captured at: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo ""
    echo "No active Simpsons sessions"
  } > "$SIMPSONS_FILE"
fi

echo "Daily digest prep complete: $OUTPUT_DIR"
