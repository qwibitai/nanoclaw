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
   - Before classifying, check if the user already replied:
     - Call get_triaged_emails for the thread and check if any message has `from:me`
     - If `from:me` exists in the thread, skip this email (already handled)
     - If the email is no longer in inbox (archived), skip it
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

## Data Bridge (ARCH-5, TENSION-1)

This container skill writes raw SuperPilot labels and email metadata to the
`tracked_items` table in the shared SQLite DB. The orchestrator process owns
all classification decisions (push/digest/resolved).

When writing to tracked_items, include:
- source: 'gmail'
- source_id: the Gmail thread_id
- superpilot_label: the raw SuperPilot classification ('needs-attention', 'fyi', 'newsletter', 'transactional')
- title: "{sender_name} — {subject}"
- summary: first 200 chars of email body
- metadata: JSON with sender email, account label, thread_id

Do NOT make push/digest/resolved decisions. Write the raw data and let the orchestrator classify.
