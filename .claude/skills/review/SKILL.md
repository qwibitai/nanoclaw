# /review

Session-end review — capture state and prepare handoff for the next session.

## Process

### 1. Update Goals

Read `groups/main/self/goals.md` and update:
- Move completed work to "Recently Completed" with brief descriptions
- Update "Active Threads" to reflect current state
- Clear stale "Next Session" guidance and write fresh handoff notes
- Add any new learnings to "Learnings This Session"
- Update the "Last updated" timestamp

### 2. Process Knowledge Queue

Check `groups/main/ops/queue/` for entries with `status: pending`:

For each pending entry:
1. Read the diff summary and files changed
2. Determine what knowledge updates are needed:
   - New capabilities → update goals.md "Recently Completed"
   - New user-facing features → consider a memory note
   - Configuration changes → update relevant docs
   - New skills or tools → ensure they're documented
3. Make the updates
4. Mark the queue entry as `status: completed` by updating its YAML frontmatter

### 3. Check Index Freshness

Compare notes on disk with `groups/main/memory/index.md`:
- List all `.md` files in `groups/main/memory/` (excluding `index.md`)
- Verify each has an entry in `index.md`
- Report any missing entries and add them

### 4. Validate Note Schemas

For each note in `groups/main/memory/`:
- Check for YAML frontmatter with required fields: `description`, `topics`, `created`
- Check for topics footer line at the end
- Check for "Related Notes" section
- Report any notes missing required structure (but don't auto-fix — flag for manual review)

### 5. Capture Friction Observations

Review the session for friction points:
- Things that didn't work as expected
- Processes that were clunky or confusing
- Missing tools or capabilities
- Repeated patterns that could be automated

For each significant observation, create a file in `groups/main/ops/observations/`:
```
groups/main/ops/observations/YYYY-MM-DD-brief-description.md
```
With content:
```markdown
---
type: friction
severity: low|medium|high
created: YYYY-MM-DD
---

## What Happened
[Description]

## Why It Matters
[Impact]

## Potential Solutions
[Ideas]
```

### 6. Report

Summarize the review:
```
Session Review:
- Goals: [updated/no changes]
- Queue: [X entries processed / none pending]
- Index: [X notes, Y missing entries fixed]
- Schema: [X notes valid, Y need attention]
- Observations: [X friction points captured]
- Handoff: [brief summary of state for next session]
```

## Rules

- **Always update goals.md**: Even if nothing happened, update the timestamp and "Next Session" section
- **Process all queue entries**: Don't skip pending entries — they represent merged work that needs knowledge updates
- **Be conservative with observations**: Only capture genuine friction, not normal workflow steps
- **Don't create memory notes here**: Use `/remember` for that. This skill updates existing structures.
