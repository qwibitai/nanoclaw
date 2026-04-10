# Meeting Prep

Generate a preparation packet before a scheduled meeting.

## Trigger

Runs as a one-time scheduled task, 15 minutes before calendar events with 2+ attendees.
The morning briefing schedules these dynamically by checking today's calendar.

## What to Include

### 1. Attendee Context
For each attendee:
- Search KB: `search_kb(query=attendee_name, tags="contact:email")`
- Check contact memory: `get_contact_memory(email)`
- Note relationship status and last interaction

### 2. Open Items
- Search commitments involving attendees
- Check for pending action items from previous meetings

### 3. Recent Communication
- Last emails with each attendee (via get_triaged_emails or KB search)
- Any Discord messages from attendees in the past week

### 4. Topic Context
- Search KB for the meeting topic/title
- Check relevant project docs if a Known Project is involved

## Format

Send via send_message. Keep under 30 lines:

```
Prep — [Meeting Name] (in 15 min):
• Attendees: [names]
• Last email with [name]: [topic] ([N days ago])
• Open items: [list]
• KB context: [relevant notes]
• Commitments: [any involving attendees]
```

## Graceful Degradation

- If KB search returns nothing, skip that attendee's context
- If superpilot is unreachable, note "[Email context unavailable]"
- Never delay or fail — a partial prep is better than no prep
