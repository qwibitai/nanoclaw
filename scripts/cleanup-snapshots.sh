#!/bin/bash
# Clean up old Apple Container snapshots
# Keeps only the newest 2 snapshots to save disk space
#
# Apple Container accumulates snapshot images after each build,
# consuming significant disk space over time. This script removes
# all but the 2 most recent snapshots.
#
# Usage:
#   ./scripts/cleanup-snapshots.sh          # interactive
#   KEEP=5 ./scripts/cleanup-snapshots.sh   # keep 5 instead of 2

KEEP="${KEEP:-2}"
SNAPSHOTS_DIR="$HOME/Library/Application Support/com.apple.container/snapshots"

if [ ! -d "$SNAPSHOTS_DIR" ]; then
  echo "Snapshots directory not found: $SNAPSHOTS_DIR"
  exit 0
fi

cd "$SNAPSHOTS_DIR" || exit 1

# Count snapshots (excluding ingest directory)
SNAPSHOT_COUNT=$(ls -t | grep -v ingest | wc -l | tr -d ' ')

if [ "$SNAPSHOT_COUNT" -le "$KEEP" ]; then
  echo "Only $SNAPSHOT_COUNT snapshot(s) found, nothing to clean up"
  exit 0
fi

TO_DELETE=$((SNAPSHOT_COUNT - KEEP))
echo "Found $SNAPSHOT_COUNT snapshots, deleting oldest $TO_DELETE..."

ls -t | grep -v ingest | tail -n +"$((KEEP + 1))" | while read -r snapshot; do
  echo "  Deleting: $snapshot"
  rm -rf "$snapshot"
done

NEW_SIZE=$(du -sh "$SNAPSHOTS_DIR" | cut -f1)
echo ""
echo "Cleanup complete! Current size: $NEW_SIZE"
