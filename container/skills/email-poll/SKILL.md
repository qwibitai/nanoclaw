---
name: email-poll
description: Poll superpilot for newly triaged emails and process them. Runs every 5 minutes via cron.
---

# Email Poll

Poll superpilot for newly triaged emails and process them.

## When to Run

Every 5 minutes via cron: `*/5 * * * *`

## What to Do

1. Determine the "since" timestamp:
   - Check the last processed email timestamp from processed_items table:
     ```bash
     sqlite3 /workspace/project/store/messages.db "SELECT MAX(processed_at) FROM processed_items WHERE source = 'superpilot';"
     ```
   - If no results, use 1 hour ago as the default window

2. Call `get_triaged_emails(since=timestamp)` from superpilot MCP

3. For each email returned:
   - Skip if already in processed_items (idempotency check)
   - Follow the Email Intelligence processing flow from CLAUDE.md
   - Classify as AUTO / PROPOSE / ESCALATE
   - Act accordingly
   - Mark as processed

4. If superpilot is unreachable:
   - Log the failure
   - Do not crash — exit gracefully
   - The next poll in 5 minutes will retry

## Efficiency

- If no new emails, exit immediately (don't waste tokens)
- Batch multiple emails in one session
- Use the script field to pre-check: if superpilot returns 0 emails, don't wake the agent

## Script (Pre-check)

This script runs before the agent wakes. If superpilot returns 0 new emails, the agent doesn't start:

```bash
#!/bin/bash
# Pre-check: are there new triaged emails?
SINCE=$(sqlite3 /workspace/project/store/messages.db "SELECT COALESCE(MAX(processed_at), datetime('now', '-1 hour')) FROM processed_items WHERE source = 'superpilot';" 2>/dev/null || echo "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)")
TOKEN="${NANOCLAW_SERVICE_TOKEN:-}"
URL="${SUPERPILOT_API_URL:-https://app.inboxsuperpilot.com/api}"

RESULT=$(curl -sf -H "x-service-token: $TOKEN" "$URL/nanoclaw/triaged-emails?since=$SINCE" 2>/dev/null)
COUNT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null || echo "0")

if [ "$COUNT" -gt "0" ]; then
  echo "{\"wakeAgent\": true, \"data\": {\"count\": $COUNT, \"since\": \"$SINCE\"}}"
else
  echo "{\"wakeAgent\": false}"
fi
```
