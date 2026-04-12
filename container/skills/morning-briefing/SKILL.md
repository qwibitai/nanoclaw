# Morning Briefing

Generate a comprehensive morning briefing and send to the user via send_message.

## When to Run

Daily at 7:30 AM CST. Scheduled as a cron task: `30 7 * * *`

## Sections to Include

### 1. Calendar Today
- List all events from Google Calendar for today
- For meetings with 2+ attendees, note attendee names
- Flag meetings starting within 2 hours

### 2. Emails Needing Response
- Call `get_awaiting_reply()` from superpilot MCP
- Call `get_triaged_emails(since=yesterday)` for recent arrivals
- Show [account] tag, sender, subject, and age for each
- Highlight any marked as high priority or needs_reply

### 3. Commitments Due
- Check the commitments table for items due today or this week
- Separate "mine" (things I promised) from "theirs" (things owed to me)
- Flag overdue items

### 4. Discord Overnight
- Run the Discord digest to summarize overnight activity:
  ```bash
  python3 /workspace/project/scripts/discord-digest.py --output-only
  ```
- The `--output-only` flag tells the script to emit the digest on stdout
  only, WITHOUT posting a Discord DM (so the briefing doesn't accidentally
  double-send).
- **Capture both stdout and the exit code.** Do NOT redirect stderr to
  `/dev/null` — real errors must be surfaced, not swallowed.
- If the script exits non-zero, its stdout will start with `DIGEST-ERROR:`
  followed by the actual failure reason (e.g. "DISCORD_BOT_TOKEN
  environment variable is not set in the container"). In that case:
  - Report the literal error text in the briefing: "Discord digest failed
    — {verbatim DIGEST-ERROR message}"
  - NEVER invent a reason. If the error text says the token is missing,
    say that. If it says something else, say that. If you cannot read the
    error text, say "Discord digest failed — reason unknown (check logs)".
  - This is a Case 4 of the Evidence discipline rules in CLAUDE.md: quote
    literal evidence, never paraphrase or invent plausible explanations.
- If the script succeeds, its stdout is a pre-formatted markdown digest
  that can be embedded directly under the "DISCORD OVERNIGHT" section.

### 5. Meeting Prep (First Meeting)
- For the first meeting today with 2+ attendees:
  - Search KB for each attendee (search_kb with contact tag)
  - Check recent emails with attendees
  - List open commitments involving attendees
  - Note any pending action items

## Format

Keep the briefing scannable:
- Section headers with counts
- Bullet points, not paragraphs
- Most urgent items first within each section
- Total: aim for under 60 lines
- Use the channel's formatting conventions (check group folder prefix)

## Graceful Degradation

If any section fails (superpilot unreachable, calendar API error, etc.):
- Skip that section
- Note "[Section unavailable]" briefly
- Continue with remaining sections
- Never crash or send an empty briefing

## Example Output

```
Good morning — here's your Friday briefing:

CALENDAR (3 events)
• 10:00 — Product sync (5 attendees)
• 14:00 — 1:1 with Sarah
• 16:30 — Attaxion standup

EMAILS NEEDING RESPONSE (2)
• [whoisxml] Mike re: Q2 pricing — waiting 2 days
• [attaxion] Customer escalation — flagged urgent

COMMITMENTS DUE
• Mine: Send revised proposal to David (EOD today)
• Theirs: Mike owes specs (1 day overdue)

DISCORD OVERNIGHT
• #product: 12 messages, 1 mention (pricing thread)
• #engineering: deploy completed, no issues

MEETING PREP — Product sync (10:00)
• Recent with attendees: pricing discussion last week
• Open items: finalize roadmap slide
```
