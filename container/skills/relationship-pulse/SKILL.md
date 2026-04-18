# Relationship Pulse

Weekly check on relationship health. Runs with the weekly review.

## What to Check

1. **Fading connections** — contacts with >3 past interactions whose last activity exceeds their typical cadence (or 21 days if no cadence set)
2. **Overdue replies** — contacts where last_inbound is more recent than last_outbound (you owe them)
3. **New frequent contacts** — people with 4+ interactions in the past 14 days not yet in the Known Projects registry

## How to Update contact_activity

During email processing, after handling each email:
- Call upsertContactActivity via IPC for sender (inbound) and recipients (outbound)
- The table accumulates automatically over time

## Output Format

```
Relationship check-in:
• Haven't heard from David in 3 weeks (usually bi-weekly)
• You owe Sarah a reply from April 2
• New frequent contact: Alex from Corp Y — 6 emails this month
```

Include in the weekly review, not as a separate message.
