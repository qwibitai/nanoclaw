---
name: recipe-schedule-recurring-event
description: "Create a recurring Google Calendar event with attendees."
metadata:
  version: 0.22.0
  openclaw:
    category: "recipe"
    domain: "scheduling"
    requires:
      bins:
        - gws
      skills:
        - gws-calendar
---

# Schedule a Recurring Meeting

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-calendar`

Create a recurring Google Calendar event with attendees.

## Steps

1. Create recurring event: `gws calendar events insert --params '{"calendarId": "primary"}' --json '{"summary": "Weekly Standup", "start": {"dateTime": "2024-03-18T09:00:00", "timeZone": "America/New_York"}, "end": {"dateTime": "2024-03-18T09:30:00", "timeZone": "America/New_York"}, "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO"], "attendees": [{"email": "team@company.com"}]}'`
2. Verify it was created: `gws calendar +agenda --days 14 --format table`

