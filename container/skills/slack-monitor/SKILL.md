# Slack Urgent Message Monitor

Checks all connected Slack channels for urgent messages that Gabriel has not yet responded to. Runs every 30 minutes, 7am–9pm PT. Sends a Telegram alert directly to Gabe's main chat when urgent + unresponded. Routine "nothing found" goes to ops only.

## Key IDs

- Gabriel's Slack user ID: `U0ASSTM1GLV`
- NanoClaw bot Slack user ID: `U0AVD9U1UUC`
- Gabriel's Telegram chat ID: `$TELEGRAM_MAIN_CHAT_ID` (injected as env var)
- Telegram bot token: `$TELEGRAM_BOT_TOKEN` (injected as env var)

## Step 1 — Discover connected channels

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for c in data.get('channels', []):
    if c.get('is_member'):
        print(c['id'] + '|' + c['name'])
"
```

If no channels returned, output "Slack monitor: bot not in any channels" and stop.

## Step 2 — Load the dedup log

```bash
cat /workspace/project/data/slack-monitor/alerted.json 2>/dev/null || echo "{}"
```

This is a JSON object mapping Slack message timestamps (ts strings) to the Unix epoch when we alerted. Ignore entries older than 2 hours.

## Step 3 — Fetch recent messages per channel

For each channel ID from step 1, fetch messages from the past 90 minutes:

```bash
OLDEST=$(python3 -c "import time; print(time.time() - 5400)")
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.history?channel=CHANNEL_ID&oldest=$OLDEST&limit=50" \
  | python3 -c "
import sys, json, time
data = json.load(sys.stdin)
now = time.time()
for m in data.get('messages', []):
    ts = float(m.get('ts', 0))
    age_min = (now - ts) / 60
    user = m.get('user', '')
    subtype = m.get('subtype', '')
    text = m.get('text', '')
    # Skip bot messages, Gabriel's own messages, messages under 20 min old (give him time to see it)
    if subtype or user in ('U0ASSTM1GLV', 'U0AVD9U1UUC') or age_min < 20:
        continue
    print(json.dumps({'ts': m['ts'], 'user': user, 'text': text, 'age_min': round(age_min,1), 'channel': 'CHANNEL_ID', 'channel_name': 'CHANNEL_NAME', 'reply_count': m.get('reply_count', 0), 'thread_ts': m.get('thread_ts', m['ts'])}))
"
```

Replace CHANNEL_ID and CHANNEL_NAME with actual values from step 1.

## Step 4 — Score each message for urgency

For each message collected, evaluate whether it meets the urgency bar using this filter (adapted from the COO decision filter in `/workspace/project/nanoclawrules.md`):

**Urgent — alert immediately if unresponded:**
- Guest escalation or complaint requiring management response
- Revenue emergency or booking cancellation of significance (>$5K or group)
- Staff emergency, safety issue, or HR matter
- Time-sensitive vendor or partner decision needed within hours
- Direct question or request addressed to leadership/management
- Something on fire: system outage, operational failure, regulatory issue

**Not urgent — skip:**
- FYIs, updates, announcements that need no action
- Routine status updates
- Jokes, casual chat, social messages
- Messages addressed to someone else specifically

## Step 5 — Check for Gabriel's reply

For each message deemed urgent, check if Gabriel (U0ASSTM1GLV) has replied in the thread:

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.replies?channel=CHANNEL_ID&ts=THREAD_TS" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = data.get('messages', [])
# Check if Gabriel replied (any message after the first one)
for m in msgs[1:]:
    if m.get('user') == 'U0ASSTM1GLV':
        print('responded')
        break
"
```

If the output is "responded", skip this message — Gabe already replied.

## Step 6 — Dedup against alerted log

For each urgent + unresponded message, check its `ts` against the alerted log from step 2. If already alerted within the last 2 hours, skip it (it was already flagged; don't spam).

## Step 7 — Alert Gabriel if needed

If there are urgent + unresponded + not-yet-alerted messages:

1. Compose a single concise Telegram message listing all of them:

```
Unresponded urgent Slack message(s):

#channel-name (Xm ago): "first 120 chars of message..."

#channel-name (Xm ago): "first 120 chars of message..."
```

2. Send it directly to Gabriel's main Telegram chat:

```bash
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"$TELEGRAM_MAIN_CHAT_ID\", \"text\": \"MESSAGE_HERE\", \"parse_mode\": \"HTML\"}"
```

Escape any special HTML characters in the message text (`<`, `>`, `&`) before sending.

3. Update the alerted log with the newly alerted message timestamps:

```bash
python3 -c "
import json, time
alerted = {}
try:
    alerted = json.load(open('/workspace/project/data/slack-monitor/alerted.json'))
except:
    pass
now = time.time()
# Prune entries older than 2 hours
alerted = {k: v for k, v in alerted.items() if now - v < 7200}
# Add new entries
for ts in NEW_TS_LIST:
    alerted[ts] = now
with open('/workspace/project/data/slack-monitor/alerted.json', 'w') as f:
    json.dump(alerted, f)
"
```

## Step 8 — Report to ops

Output a brief status for the ops Telegram (this is the task's normal output):
- If alerted: "Slack monitor: alerted Gabe — N urgent unresponded message(s) in #channel1, #channel2."
- If nothing urgent: "Slack monitor: checked N channel(s), nothing urgent."
- If no channels: "Slack monitor: bot not in any channels."

## Hard rules

- HARD RULE: Do NOT send any emails.
- HARD RULE: Only send to Gabe's main Telegram chat when there IS an urgent unresponded message. Never send "all clear" to main.
- HARD RULE: Do not alert for the same message more than once per 2 hours.
- Keep the Telegram alert brief — channel, age, and first 120 chars of the message. No filler.
