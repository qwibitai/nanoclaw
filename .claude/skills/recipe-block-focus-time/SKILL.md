---
name: recipe-block-focus-time
description: "Create recurring focus time blocks on Google Calendar to protect deep work hours."
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

# Block Focus Time on Google Calendar

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-calendar`

Create recurring focus time blocks on Google Calendar to protect deep work hours.

## Steps

1. Create recurring focus block: `gws calendar events insert --params '{"calendarId": "primary"}' --json '{"summary": "Focus Time", "description": "Protected deep work block", "start": {"dateTime": "2025-01-20T09:00:00", "timeZone": "America/New_York"}, "end": {"dateTime": "2025-01-20T11:00:00", "timeZone": "America/New_York"}, "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"], "transparency": "opaque"}'`
2. Verify it shows as busy: `gws calendar +agenda`

