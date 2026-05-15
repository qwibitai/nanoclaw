#!/bin/bash
# Daily retention cron for Pod's local MP3 cache.
#
# Pod publishes every episode to Cloudflare R2 with HTTP 200 verification, so
# the local copy in podcast/output/ is a redundant cache. This script deletes
# MP3s (and other binary audio artifacts) older than 7 days. Transcripts and
# briefing scripts live elsewhere (podcast/library/transcripts/ and
# podcast/scripts/<feed>/) — neither is touched.
#
# Wired via ~/Library/LaunchAgents/com.nanoclaw.podcast-prune-output.plist
# Runs daily at 03:00 Europe/London (before Pod's 05:00 publish run).

set -euo pipefail

OUT_DIR="/Users/ilansolot/nanoclaw-v2/groups/thedius_pod/podcast/output"
LOG_DIR="/Users/ilansolot/nanoclaw-v2/logs"
LOG_FILE="$LOG_DIR/podcast-prune-output.log"
RETENTION_DAYS=7

mkdir -p "$LOG_DIR"
echo "===== $(date '+%Y-%m-%d %H:%M:%S %Z') ====="  >> "$LOG_FILE"

if [ ! -d "$OUT_DIR" ]; then
  echo "Output dir not found: $OUT_DIR — exiting clean" >> "$LOG_FILE"
  exit 0
fi

# Audit before
BEFORE_COUNT=$(find "$OUT_DIR" -type f \( -name "*.mp3" -o -name "*.wav" -o -name "*.m4a" -o -name "*.aac" -o -name "*.opus" \) | wc -l | tr -d ' ')
BEFORE_BYTES=$(find "$OUT_DIR" -type f \( -name "*.mp3" -o -name "*.wav" -o -name "*.m4a" -o -name "*.aac" -o -name "*.opus" \) -exec stat -f "%z" {} + 2>/dev/null | awk '{s+=$1} END {print s+0}')

# List what's about to go (above retention age)
TO_DELETE=$(find "$OUT_DIR" -type f \( -name "*.mp3" -o -name "*.wav" -o -name "*.m4a" -o -name "*.aac" -o -name "*.opus" \) -mtime "+$RETENTION_DAYS" | wc -l | tr -d ' ')

if [ "$TO_DELETE" = "0" ]; then
  echo "Nothing to prune (count=$BEFORE_COUNT, bytes=$BEFORE_BYTES, retention=${RETENTION_DAYS}d)" >> "$LOG_FILE"
  exit 0
fi

# Delete
find "$OUT_DIR" -type f \( -name "*.mp3" -o -name "*.wav" -o -name "*.m4a" -o -name "*.aac" -o -name "*.opus" \) -mtime "+$RETENTION_DAYS" -delete

# Audit after
AFTER_COUNT=$(find "$OUT_DIR" -type f \( -name "*.mp3" -o -name "*.wav" -o -name "*.m4a" -o -name "*.aac" -o -name "*.opus" \) | wc -l | tr -d ' ')
AFTER_BYTES=$(find "$OUT_DIR" -type f \( -name "*.mp3" -o -name "*.wav" -o -name "*.m4a" -o -name "*.aac" -o -name "*.opus" \) -exec stat -f "%z" {} + 2>/dev/null | awk '{s+=$1} END {print s+0}')

PRUNED=$((BEFORE_COUNT - AFTER_COUNT))
FREED=$((BEFORE_BYTES - AFTER_BYTES))
FREED_MB=$((FREED / 1048576))

echo "Pruned ${PRUNED} audio file(s) older than ${RETENTION_DAYS}d, freed ${FREED_MB} MB (count $BEFORE_COUNT -> $AFTER_COUNT)" >> "$LOG_FILE"
