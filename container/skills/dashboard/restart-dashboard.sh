#!/bin/sh
# Rebuild and restart the dashboard via host IPC.
# Writes a request file, polls for the response, prints build output.

set -e

IPC_DIR="/workspace/ipc"
TASKS_DIR="$IPC_DIR/tasks"
RESPONSES_DIR="$IPC_DIR/responses"
TIMEOUT=120
POLL_INTERVAL=1

# Generate unique request ID
REQUEST_ID="dashboard-$(date +%s)-$$"

# Write IPC request
echo "{\"type\":\"rebuild_dashboard\",\"requestId\":\"$REQUEST_ID\"}" > "$TASKS_DIR/$REQUEST_ID.json"
echo "Submitted dashboard rebuild request ($REQUEST_ID)"

# Poll for response
elapsed=0
while [ $elapsed -lt $TIMEOUT ]; do
  if [ -f "$RESPONSES_DIR/$REQUEST_ID.json" ]; then
    # Parse response with node (guaranteed available in container)
    result=$(node -e "
      const r = JSON.parse(require('fs').readFileSync('$RESPONSES_DIR/$REQUEST_ID.json', 'utf-8'));
      console.log(r.success ? 'SUCCESS' : 'FAILURE');
      if (r.output) console.log(r.output);
    ")

    # Clean up response file
    rm -f "$RESPONSES_DIR/$REQUEST_ID.json"

    # Check result
    status=$(echo "$result" | head -1)
    output=$(echo "$result" | tail -n +2)

    if [ "$status" = "SUCCESS" ]; then
      echo "Dashboard rebuilt and restarted successfully."
      [ -n "$output" ] && echo "$output"
      exit 0
    else
      echo "Dashboard rebuild failed:"
      [ -n "$output" ] && echo "$output"
      exit 1
    fi
  fi

  sleep $POLL_INTERVAL
  elapsed=$((elapsed + POLL_INTERVAL))
done

echo "Timeout waiting for dashboard rebuild response after ${TIMEOUT}s"
exit 1
