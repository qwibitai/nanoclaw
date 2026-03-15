#!/bin/bash
# Register the Assistant group in NanoClaw's database.
# Usage: ./scripts/register-assistant.sh <JID>
#
# The JID should be a WhatsApp group JID (ending in @g.us) or a solo chat JID (@s.whatsapp.net).
# To find it, send a message to the group/chat then run:
#   sqlite3 store/messages.db "SELECT jid, name FROM chats ORDER BY rowid DESC;"

set -euo pipefail

DB="store/messages.db"
JID="${1:?Usage: $0 <whatsapp-jid>}"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Calculate next 08:00 UK time
NEXT_8AM=$(python3 -c "
from datetime import datetime, timedelta
import zoneinfo
tz = zoneinfo.ZoneInfo('Europe/London')
now = datetime.now(tz)
target = now.replace(hour=8, minute=0, second=0, microsecond=0)
if target <= now:
    target += timedelta(days=1)
print(target.astimezone(zoneinfo.ZoneInfo('UTC')).strftime('%Y-%m-%dT%H:%M:%S.000Z'))
")

echo "Registering assistant group..."
echo "  JID: $JID"
echo "  Next 08:00 digest: $NEXT_8AM"

# Container config: mount data/slack, data/email, data/calendar as read-only
CONTAINER_CONFIG=$(cat <<'CEOF'
{"assistantName":"Assistant","additionalMounts":[{"hostPath":"~/agents/nanoclaw-repo/data/slack","containerPath":"slack","readonly":true},{"hostPath":"~/agents/nanoclaw-repo/data/email","containerPath":"email","readonly":true},{"hostPath":"~/agents/nanoclaw-repo/data/calendar","containerPath":"calendar","readonly":true}]}
CEOF
)

# Register the group
sqlite3 "$DB" "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, container_config) VALUES ('$JID', 'Assistant', 'assistant', '^@Brain\b', '$NOW', 0, '$CONTAINER_CONFIG');"

echo "  Group registered."

# Register the morning digest scheduled task
DIGEST_PROMPT='You are generating Tom'\''s morning briefing. Read the data files and compose a concise digest.

1. Read /workspace/extra/calendar/today.json for today'\''s calendar
2. Read /workspace/extra/slack/latest.json for Slack messages since yesterday
3. Read /workspace/extra/email/latest.json for recent emails
4. If Granola MCP is available, check for meeting action items from yesterday

Classify each item:
- Critical: Direct messages/DMs with questions, mentions requiring response, key stakeholders
- Important: Channel messages needing response, meeting-related, deadlines
- Normal: FYI, general discussion

Format as WhatsApp message (NO markdown headings, use *bold* for sections):

*CALENDAR TODAY*
• HH:MM Event name (Location/Link)

*REQUIRES YOUR ATTENTION (N)*
1. [Source] Summary of what needs action

*FOR YOUR AWARENESS (N)*
• [Source] Brief summary

If a section is empty, omit it. If everything is empty, send:
"All clear this morning — nothing requiring your attention."

Use send_message to deliver the digest.'

sqlite3 "$DB" "INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES ('task-morning-digest', 'assistant', '$JID', '$DIGEST_PROMPT', 'cron', '0 8 * * *', 'isolated', '$NEXT_8AM', 'active', '$NOW');"

echo "  Morning digest task registered (cron: 0 8 * * *)"
echo ""
echo "Done. Restart NanoClaw to pick up the new group:"
echo "  launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
