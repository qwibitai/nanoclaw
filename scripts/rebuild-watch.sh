#!/bin/bash
# rebuild-watch.sh — Called by launchd when rebuild-trigger.json appears.
# Reads the trigger, launches Claude Code to handle the rebuild safely.
set -euo pipefail

NANOCLAW_DIR="$HOME/nanoclaw-unic"
TRIGGER_FILE="$NANOCLAW_DIR/groups/unic-shared-memory/rebuild-trigger.json"
RESULT_FILE="$NANOCLAW_DIR/groups/unic-shared-memory/rebuild-result.json"
LOG_FILE="$NANOCLAW_DIR/logs/rebuild.log"
PROMPT_FILE="$NANOCLAW_DIR/scripts/rebuild-prompt.md"

# Exit if trigger doesn't exist (launchd may fire on directory changes)
if [ ! -f "$TRIGGER_FILE" ]; then
  exit 0
fi

echo "$(date -Iseconds) Rebuild triggered" >> "$LOG_FILE"

# Read trigger context
TRIGGER_CONTENT=$(cat "$TRIGGER_FILE")
echo "Trigger: $TRIGGER_CONTENT" >> "$LOG_FILE"

# Remove trigger immediately to prevent re-firing
mv "$TRIGGER_FILE" "$TRIGGER_FILE.processing"

# Build the prompt with trigger context
PROMPT=$(cat "$PROMPT_FILE")
PROMPT="$PROMPT

## Trigger Context
\`\`\`json
$TRIGGER_CONTENT
\`\`\`"

# Run Claude Code in non-interactive mode
# -p: print mode (non-interactive)
# --dangerously-skip-permissions: auto-approve tool calls (trusted rebuild prompt)
# --model sonnet: use Sonnet for cost efficiency
cd "$NANOCLAW_DIR"
claude -p --dangerously-skip-permissions --model opus "$PROMPT" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "$(date -Iseconds) Claude Code exited with code $EXIT_CODE" >> "$LOG_FILE"
fi

# Clean up processing file
rm -f "$TRIGGER_FILE.processing"

echo "$(date -Iseconds) Rebuild watch completed" >> "$LOG_FILE"
