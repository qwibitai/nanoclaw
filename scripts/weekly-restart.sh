#!/bin/bash
# Weekly NanoClaw restart — runs Sunday 3am via com.nanoclaw.weekly-restart LaunchAgent

echo "$(date): Weekly restart starting"

launchctl stop gui/$(id -u)/com.nanoclaw
sleep 5
launchctl start gui/$(id -u)/com.nanoclaw
launchctl stop gui/$(id -u)/com.nanoclaw-dashboard
sleep 3
launchctl start gui/$(id -u)/com.nanoclaw-dashboard

# Wait for services to come back up before pruning
sleep 15

/usr/local/bin/docker container prune -f
/usr/local/bin/docker image prune -f

# Purge conversation transcripts older than 7 days (reduces workspace mount size)
find /Users/gabrielratner/projects/nanoclaw/groups/telegram_main/conversations -name "*.md" -mtime +7 -delete 2>/dev/null
echo "$(date): Old conversation transcripts purged"

# Keep only last 3 days of COO prefetch data
PREFETCH_DIR=/Users/gabrielratner/projects/nanoclaw/groups/telegram_main/coo-prefetch
DIRS=($(ls -d "${PREFETCH_DIR}"/2*/ 2>/dev/null | sort))
COUNT=${#DIRS[@]}
if [ $COUNT -gt 3 ]; then
  for i in $(seq 0 $((COUNT-4))); do
    rm -rf "${DIRS[$i]}"
  done
  echo "$(date): Old prefetch data purged"
fi

echo "$(date): Weekly restart complete"
