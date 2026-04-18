# OneCLI Calendar Endpoint Specification

## Endpoint

`GET /calendar/events?from={epochMs}&to={epochMs}`

## Response Format

```json
{
  "events": [
    {
      "id": "google-event-id",
      "title": "Team Standup",
      "summary": "Team Standup",
      "start": "2026-04-16T09:00:00-07:00",
      "end": "2026-04-16T09:30:00-07:00",
      "attendees": [
        { "email": "alice@example.com" },
        { "email": "bob@example.com" }
      ],
      "location": "https://meet.google.com/xyz",
      "source_account": "jonathan@attaxion.com"
    }
  ]
}
```

## Implementation Notes

1. **Google Calendar API scope:** `https://www.googleapis.com/auth/calendar.readonly`
2. **OAuth:** Reuse the existing Google OAuth flow in OneCLI (same token store used for Gmail)
3. **Multi-account:** Query all configured Google accounts, merge results, tag each event with `source_account`
4. **Time filter:** Convert `from`/`to` epoch ms to RFC 3339 for the Google API `timeMin`/`timeMax` params
5. **API call:** `calendar.events.list({ calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime' })`
6. **Error handling:** Return `{ events: [] }` on auth failures rather than 500, so the poller continues gracefully

## NanoClaw Integration

The NanoClaw calendar poller (`src/calendar-poller.ts`) already:
- Calls this endpoint every 5 minutes
- Handles 404 gracefully (logs debug, returns)
- Parses `summary` OR `title` fields
- Handles `{dateTime: string}` or ISO string or epoch for start/end
- Extracts attendees from `string[]` or `{email: string}[]`
- Stores events in the `calendar_events` SQLite table
- Emits `calendar.synced` event
- Meeting briefings check for events starting within 15 minutes
