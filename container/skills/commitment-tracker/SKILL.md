# Commitment Tracker

Detect and track commitments from emails and messages.

## Detection Patterns

**Your commitments (direction: mine):**
- "I'll send that over by Friday"
- "I will follow up on Monday"
- "Let me get back to you on that"
- "I'll review it this week"

**Their commitments (direction: theirs):**
- "Mike will have specs ready Monday"
- "She'll send the contract by EOW"
- "They promised to get back to us by Thursday"

## When to Detect

During email processing, scan for commitment language in:
- Emails you sent (your commitments)
- Emails received (their commitments)

## Actions

When a commitment is detected:
1. Create via IPC: write JSON to /workspace/ipc/tasks/ with type "create_commitment"
2. Extract: description, direction, person, due_date (if mentioned)

When checking for overdue commitments (during morning briefing):
- Mine: remind me before the deadline
- Theirs: if 1 day overdue, draft a gentle follow-up (PROPOSE tier)
