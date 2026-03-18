---
name: save-state
description: Save session state to STATE.md before ending. Captures recent work, pending items, active projects, and key decisions so the next session can pick up where this one left off.
---

# /save-state

Save the current session state to `/workspace/group/STATE.md` so the next session has full context.

## When to run

Run `/save-state` (or remind the user) at the end of any session that involved meaningful work — new tasks completed, decisions made, or context that would be lost.

## What to capture

Write or update `/workspace/group/STATE.md` with these sections:

```markdown
# State

**Last updated:** <ISO datetime>

---

## Active Projects
- Project name, repo path, current sprint/phase

## Recent Work (This Session)
- Bullet list of what was done, with enough detail to resume

## Pending / Carry Forward
- Items that still need attention, with deadlines if known

## Key Decisions
- Decisions made this session that affect future work

## Important References
- IDs, URLs, file paths that will be needed again

## Previous Sessions
- One-line summary per past session (roll off entries older than 2 weeks)
```

## Rules

- Merge with existing STATE.md content — don't overwrite previous sessions
- Move completed items out of "Pending" into "Recent Work"
- Keep it concise — this is a handoff doc, not a log
- Use absolute dates, never relative ("March 18" not "today")
