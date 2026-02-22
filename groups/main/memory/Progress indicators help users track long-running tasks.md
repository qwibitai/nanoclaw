---
description: User preference for progress updates on multi-step or long-running operations
topics: [communication-style, user-experience]
created: 2026-02-21
---

# Progress indicators help users track long-running tasks

When working on tasks that take more than a few seconds, provide progress updates to keep the user informed.

## Why This Matters

Long-running tasks without updates create uncertainty:
- User doesn't know if the system is working or stuck
- No visibility into what's happening
- Unclear when to expect completion

Progress indicators solve this by:
- Confirming work has started
- Showing current step/milestone
- Building confidence that progress is being made
- Setting expectations for completion

## Implementation

Use `send_message` tool to send non-blocking progress updates:

**Pattern:**
1. Initial acknowledgment (⏳ Starting...)
2. Milestone updates (→ Step X: description ✓)
3. Final completion message (✓ Complete!)

**Visual indicators:**
- ⏳ In progress
- ✓ Completed
- → Working on
- ⚠️ Warning
- ❌ Failed

**Timing:**
- Tasks >3 steps: Show each major milestone
- Tasks >10 seconds: Send update every 30-60 seconds
- Complex operations: Show what's currently being worked on

## Examples

**Good:**
```
⏳ Building personality profiling system...

→ Creating interview skill ✓
→ Building user profiles ✓
→ Updating memory index ✓

✓ Complete! Personality system ready.
```

**Bad:**
```
[5 minutes of silence]
Done! Created the personality system.
```

## Related Notes

- [[User prefers concise explanations over detailed verbose ones]]
- [[Admin profile (14195613622)]]

---

*Topics: [[communication-style]] · [[user-experience]]*
