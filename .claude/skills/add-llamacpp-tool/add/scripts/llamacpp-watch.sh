#!/bin/bash
# Watch NanoClaw IPC for llama.cpp activity and show macOS notifications
# Usage: ./scripts/llamacpp-watch.sh

cd "$(dirname "$0")/.." || exit 1

echo "Watching for llama.cpp activity..."
echo "Press Ctrl+C to stop"
echo ""

LAST_TIMESTAMP=""

while true; do
  # Check all group IPC dirs for llamacpp_status.json
  for status_file in data/ipc/*/llamacpp_status.json; do
    [ -f "$status_file" ] || continue

    TIMESTAMP=$(python3 -c "import json; print(json.load(open('$status_file'))['timestamp'])" 2>/dev/null)
    [ -z "$TIMESTAMP" ] && continue
    [ "$TIMESTAMP" = "$LAST_TIMESTAMP" ] && continue

    LAST_TIMESTAMP="$TIMESTAMP"
    STATUS=$(python3 -c "import json; d=json.load(open('$status_file')); print(d['status'])" 2>/dev/null)
    DETAIL=$(python3 -c "import json; d=json.load(open('$status_file')); print(d.get('detail',''))" 2>/dev/null)

    case "$STATUS" in
      generating)
        osascript -e "display notification \"$DETAIL\" with title \"NanoClaw → llama.cpp\" sound name \"Submarine\"" 2>/dev/null
        echo "$(date +%H:%M:%S) 🔄 $DETAIL"
        ;;
      done)
        osascript -e "display notification \"$DETAIL\" with title \"NanoClaw ← llama.cpp ✓\" sound name \"Glass\"" 2>/dev/null
        echo "$(date +%H:%M:%S) ✅ $DETAIL"
        ;;
      listing)
        echo "$(date +%H:%M:%S) 📋 Listing model..."
        ;;
    esac
  done
  sleep 0.5
done
