#!/bin/bash
# Delete all NanoClaw session history and task state

set -e

BASE="$HOME/Documents/dev/claws/NanoClaw"

rm -rf "$BASE/data/sessions/"
rm -rf "$BASE/data/ipc/"
rm -rf "$BASE/groups/homie/mission-control/initiatives/"
rm -rf "$BASE/groups/homie/mission-control/tasks/"
rm -rf "$BASE/groups/homie/mission-control/outputs/"
rm -f  "$BASE/groups/homie/mission-control/activity.log.ndjson"
rm -f  "$BASE/groups/homie/mission-control/lock.json"
rm -rf "$BASE/groups/homie/briefings/"
rm -rf "$BASE/groups/homie/logs/"
rm -rf "$BASE/groups/worker/logs/"
rm -rf "/Users/vinchenkov/Documents/dev/claws/NanoClaw/data/sessions/homie/.claude/debug"
rm -rf "/Users/vinchenkov/Documents/dev/claws/NanoClaw/data/sessions/homie/.claude/projects/-workspace-group"
rm -rf "/Users/vinchenkov/Documents/dev/claws/NanoClaw/data/sessions/homie/.claude/session-env"

echo "NanoClaw history cleared."
