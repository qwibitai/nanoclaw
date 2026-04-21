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

echo "$(date): Weekly restart complete"
