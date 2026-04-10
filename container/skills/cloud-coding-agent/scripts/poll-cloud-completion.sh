#!/bin/bash
# poll-cloud-completion.sh - Poll Codex cloud task until completion
#
# Usage:
#   poll-cloud-completion.sh <task-id> [--auto-apply]
#
# Options:
#   --auto-apply  Automatically apply changes when task completes
#
# Environment variables:
#   POLL_INTERVAL - Seconds between checks (default: 30)

set -euo pipefail

TASK_ID="${1:-}"
AUTO_APPLY=false
POLL_INTERVAL="${POLL_INTERVAL:-30}"

if [ -z "$TASK_ID" ]; then
    echo "Usage: $0 <task-id> [--auto-apply]"
    exit 1
fi

if [ "${2:-}" = "--auto-apply" ]; then
    AUTO_APPLY=true
fi

echo "Polling task: $TASK_ID"
echo "Interval: ${POLL_INTERVAL}s"
echo "Auto-apply: $AUTO_APPLY"
echo ""

while true; do
    # Get task status (assumes codex cloud status supports JSON output)
    STATUS=$(codex cloud status --task-id "$TASK_ID" --format json 2>/dev/null | jq -r '.status' 2>/dev/null || echo "unknown")
    TIMESTAMP=$(date '+%H:%M:%S')

    case "$STATUS" in
        completed)
            echo "[$TIMESTAMP] Task completed successfully!"
            if [ "$AUTO_APPLY" = true ]; then
                echo "Applying changes..."
                codex cloud apply --task-id "$TASK_ID"
                echo "Changes applied."
            else
                echo "Run 'codex cloud apply --task-id $TASK_ID' to apply changes."
            fi
            exit 0
            ;;
        failed)
            echo "[$TIMESTAMP] Task failed!"
            echo "Check logs with: codex cloud logs --task-id $TASK_ID"
            exit 1
            ;;
        running|pending|queued)
            echo "[$TIMESTAMP] Status: $STATUS - waiting..."
            ;;
        unknown)
            echo "[$TIMESTAMP] Could not determine status - retrying..."
            ;;
        *)
            echo "[$TIMESTAMP] Unknown status: $STATUS"
            ;;
    esac

    sleep "$POLL_INTERVAL"
done
