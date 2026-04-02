---
name: daily-digest
description: Compose and send a morning digest for the family. Reads schedules, family facts, and any upcoming events to create a helpful daily summary. Triggers on "daily digest", "morning summary", "what's happening today".
---

# Daily Digest

Compose a morning summary for the family. This skill is designed to run as a scheduled task (7am weekdays) but can also be invoked manually.

## Steps

1. Read `/workspace/extra/family-vault/MOC.md` for family context (then drill into relevant nodes for birthdays, allergies, preferences)
2. Read `/workspace/extra/family-vault/school/MOC.md` for school context, `/workspace/extra/family-vault/health/MOC.md` for health reminders
3. Check today's date and day of week
4. Compose a warm, concise morning message that includes:
   - Day and date
   - Any birthdays today or this week
   - School/activity schedule for today
   - Any reminders or notes relevant to today
   - A brief encouraging or fun sign-off (vary it each day — joke, quote, fun fact, etc.)

## Formatting

Use Telegram formatting (not markdown):
- *bold* for section headers (single asterisks)
- • bullet points for lists
- Keep it scannable — families read this over breakfast

## Tone

Warm and helpful. This goes to the whole family including kids. Keep it brief — aim for a message that fits on one phone screen.
