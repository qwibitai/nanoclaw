#!/bin/bash
# Non-interactive calendar sync: Outlook → MJG-outlook + MJG-sync (deduplicated)
# Calls scheduleSync Python scripts directly, bypassing the interactive Node.js CLI.

SCHEDULE_SYNC_DIR="/Users/mgandal/Documents/claude/scheduleSync"
LOG_PREFIX="[calendar-sync]"

# Calculate date range: today → 3 months out
START_DATE=$(date +%Y-%m-%d)
END_DATE=$(date -v+3m +%Y-%m-%d)

echo "$LOG_PREFIX Syncing calendars from $START_DATE to $END_DATE"

# Step 1: Sync deduplicated events → MJG-sync
echo "$LOG_PREFIX Step 1/2: Syncing MJG-sync (deduplicated merge)..."
RESULT1=$(python3 "$SCHEDULE_SYNC_DIR/src/calendar/PythonCalendarWriter.py" sync-calendar "$START_DATE" "$END_DATE" 2>&1)
EC1=$?
if [ $EC1 -ne 0 ]; then
    echo "$LOG_PREFIX WARNING: MJG-sync failed (exit $EC1): $RESULT1"
elif [ -n "$RESULT1" ]; then
    echo "$LOG_PREFIX MJG-sync result: $RESULT1" | head -5
fi

# Step 2: One-way copy Outlook → MJG-outlook
echo "$LOG_PREFIX Step 2/2: Syncing MJG-outlook (Outlook copy)..."
RESULT2=$(python3 "$SCHEDULE_SYNC_DIR/src/calendar/OutlookSyncWriter.py" sync "$START_DATE" "$END_DATE" 2>&1)
EC2=$?
if [ $EC2 -ne 0 ]; then
    echo "$LOG_PREFIX WARNING: MJG-outlook sync failed (exit $EC2): $RESULT2"
elif [ -n "$RESULT2" ]; then
    echo "$LOG_PREFIX MJG-outlook result: $RESULT2" | head -5
fi

echo "$LOG_PREFIX Calendar sync complete"

# Exit with failure if either step failed
[ $EC1 -ne 0 ] || [ $EC2 -ne 0 ] && exit 1
exit 0
