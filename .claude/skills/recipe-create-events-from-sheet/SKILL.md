---
name: recipe-create-events-from-sheet
description: "Read event data from a Google Sheets spreadsheet and create Google Calendar entries for each row."
metadata:
  version: 0.22.0
  openclaw:
    category: "recipe"
    domain: "productivity"
    requires:
      bins:
        - gws
      skills:
        - gws-sheets
        - gws-calendar
---

# Create Google Calendar Events from a Sheet

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-sheets`, `gws-calendar`

Read event data from a Google Sheets spreadsheet and create Google Calendar entries for each row.

## Steps

1. Read event data: `gws sheets +read --spreadsheet SHEET_ID --range "Events!A2:D"`
2. For each row, create a calendar event: `gws calendar +insert --summary 'Team Standup' --start '2026-01-20T09:00:00' --end '2026-01-20T09:30:00' --attendee alice@company.com --attendee bob@company.com`

