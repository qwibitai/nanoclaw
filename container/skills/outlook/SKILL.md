---
name: outlook
description: Read and manage Outlook email and calendar via Microsoft Graph API. Use for inbox, search, send/reply, calendar events, and scheduling.
allowed-tools: Bash(outlook:*)
---

# Outlook Tool

## Confirmation Wall

**MANDATORY: Before sending or modifying anything, ask for explicit user confirmation.**

Actions requiring confirmation:
- Sending a new email (`outlook send`)
- Replying to an email (`outlook reply`, `outlook reply-all`)
- Forwarding an email (`outlook forward`)
- Creating, updating, or deleting calendar events

Tell the user exactly what you're about to do (recipient, subject, body summary) and wait for a clear "yes" / "go ahead" / "send it" before executing. If they say no or don't confirm, abort.

Read-only actions (listing emails, reading, searching, viewing calendar) do NOT require confirmation.

Use the `outlook` command to interact with Outlook email and calendar via Microsoft Graph.

## Email

```bash
# List inbox (most recent first)
outlook emails             # last 20
outlook emails 50          # last 50

# Read a specific email
outlook email <id>

# Search emails
outlook search-emails "quarterly review"
outlook search-emails "from:alice subject:meeting"

# List mail folders
outlook folders

# Emails from a folder (use ID from `outlook folders`)
outlook folder-emails <folder_id> 20

# Send a new email
outlook send alice@example.com "Subject here" "Body text here"

# Reply to an email
outlook reply <message_id> "Thanks, sounds good!"

# Reply all
outlook reply-all <message_id> "Noted, updating everyone."

# Forward
outlook forward <message_id> bob@example.com "FYI"

# Mark as read
outlook mark-read <message_id>
```

## Calendar

```bash
# Upcoming events (next 7 days by default)
outlook calendar        # next 7 days
outlook calendar 14     # next 14 days

# Specific date range (ISO 8601)
outlook calendar-range 2026-03-20T00:00:00Z 2026-03-27T00:00:00Z

# Get a specific event
outlook event <event_id>

# List available calendars
outlook calendars

# Create an event
outlook create-event "Team standup" 2026-03-21T09:00:00Z 2026-03-21T09:30:00Z "Conference Room A" "Weekly sync"

# Update an event (JSON patch)
outlook update-event <event_id> '{"subject":"Updated title"}'

# Delete an event
outlook delete-event <event_id>
```

## Account

```bash
outlook me    # Current user's display name, email, job title
```

## Tips

- All times are UTC in ISO 8601 format (e.g. `2026-03-21T09:00:00Z`)
- Email and event IDs are long base64 strings from listing commands
- `$search` supports OData syntax: `"from:alice"`, `"subject:budget"`, `"hasAttachments:true"`
- If you get a 401 error, tell the user to run: `npx tsx scripts/outlook-auth.ts`
