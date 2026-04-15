#!/usr/bin/env bash
set -euo pipefail
THIS_DIR="$(cd "$(dirname "$0")" && pwd)"
CS="$THIS_DIR/../bin/codex-state"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

STATE_DIR="$TMP/work"
mkdir -p "$STATE_DIR"

# init writes a minimal valid state.json
"$CS" init "$STATE_DIR" \
  --plan-path /tmp/plan.md --plan-sha abc123 \
  --base-ref origin/main --base-sha deadbeef \
  --waves '[{"wave":1,"tasks":[1,2]}]' \
  --tasks '[{"num":1,"slug":"a"},{"num":2,"slug":"b"}]'
test -r "$STATE_DIR/state.json"
jq -e '.plan_sha == "abc123"' "$STATE_DIR/state.json" > /dev/null
jq -e '.waves[0].tasks | length == 2' "$STATE_DIR/state.json" > /dev/null
jq -e '.waves[0].tasks[0].status == "pending"' "$STATE_DIR/state.json" > /dev/null

# set-status changes a task's status
"$CS" set-status "$STATE_DIR" --wave 1 --task 1 --status dispatched
jq -e '.waves[0].tasks[0].status == "dispatched"' "$STATE_DIR/state.json" > /dev/null

# append-attempt appends to attempt history
"$CS" append-attempt "$STATE_DIR" --wave 1 --task 1 \
  --impl codex-high --session-id s1 --result done
jq -e '.waves[0].tasks[0].attempts | length == 1' "$STATE_DIR/state.json" > /dev/null
jq -e '.waves[0].tasks[0].attempts[0].attempt == 1' "$STATE_DIR/state.json" > /dev/null

# get-status reads back
got="$("$CS" get-status "$STATE_DIR" --wave 1 --task 1)"
[ "$got" = "dispatched" ] || { echo "FAIL: get-status=$got"; exit 1; }

# concurrent writes don't corrupt (lightweight stress)
for i in 1 2 3 4 5; do
  "$CS" set-status "$STATE_DIR" --wave 1 --task 2 --status "dispatched" &
done
wait
jq . "$STATE_DIR/state.json" > /dev/null  # must still be valid JSON

echo "PASS: test-state"
