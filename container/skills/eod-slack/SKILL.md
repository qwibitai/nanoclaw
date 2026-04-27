# EOD Slack Briefing

End-of-day wrap-up sent to every Slack channel the bot is currently a member of. Runs at 5:15pm PT daily.

## Steps

### 1. Discover connected Slack channels

Run this bash command to get all channels the bot is a member of:

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

If the output is empty, the bot is not in any channels yet. Stop and send a Telegram message to Gabe explaining that (no Slack post needed).

### 2. Gather EOD data

Run the COO decision filter from `/workspace/project/nanoclawrules.md` against Outlook and Gmail items received since 12:30pm today. Use mcp__outlook__* and mcp__gmail__* tools to pull today's emails since 12:30pm local time.

Also run this SQL for stalled follow-ups:
```bash
sqlite3 /workspace/project/store/messages.db "SELECT id, title, owner, source_ref, context, datetime(created_at) as sent_at, ROUND((julianday('now') - julianday(created_at)) * 24, 1) as hours_stalled FROM open_items WHERE source = 'sent_email' AND status = 'waiting' AND datetime(due_date) < datetime('now') ORDER BY due_date ASC" 2>/dev/null || echo "no_open_items_table"
```

### 3. Compose the briefing

Write one Slack message using mrkdwn formatting (see `/workspace/project/container/skills/slack-formatting/SKILL.md`). The message covers:

- *New since midday* — action items from Outlook/Gmail since 12:30pm that clear the COO decision filter (decisions needed, urgent ops, guest escalations, revenue flags). Skip routine FYIs.
- *Waiting for reply* — any stalled sent-email follow-ups from the query above. For each: item title, recipient, hours since sent, one-line context.
- *Top 3 for tomorrow morning* — the highest-priority items Gabe should tackle first thing.

Keep it tight. If there is genuinely nothing actionable since midday, skip that section entirely. If nothing at all, send a brief "All clear — nothing actionable since midday" message.

Use this structure:
```
*EOD Wrap — [Day, Month Date]*

*New since midday*
• ...

*Waiting for reply*
• ...

*Top 3 for tomorrow*
• 1. ...
• 2. ...
• 3. ...
```

### 4. Post to each Slack channel

For each channel ID discovered in step 1, post the message via:

```bash
curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"CHANNEL_ID\", \"text\": \"MESSAGE\", \"mrkdwn\": true}"
```

Replace CHANNEL_ID and MESSAGE with the actual values. Escape the message JSON properly. If a post fails (ok=false in the response), log the error but continue to the next channel.

### 5. Report to ops

After posting to all channels, send a brief Telegram confirmation: "EOD Slack briefing sent to N channel(s): #channel1, #channel2." If no channels were found, send "EOD Slack: bot not in any channels yet — nothing sent."

## Hard rules

- HARD RULE: Do NOT send any emails.
- HARD RULE: Do NOT send Telegram messages to Gabe's main chat (this task routes to ops).
- Use mrkdwn formatting — no Markdown headers, no **double asterisks**, no [text](url) links.
- Friendly, succinct, direct. This is not a report — it's a quick end-of-day handoff.
