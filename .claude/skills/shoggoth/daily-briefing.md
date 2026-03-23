---
name: daily-briefing
description: >
  Generate a daily research briefing on weekday mornings. Reads researcher
  context, project statuses, and recent vault activity to produce an
  actionable summary in briefings/.
---

# Daily Briefing

Produce a morning briefing that tells the researcher what matters today. Scheduled weekday mornings, but can also be triggered on demand.

## Process

1. **Read researcher context:**
   - `mcp__mcpvault__read_note` on `_meta/researcher-profile.md`, `_meta/top-of-mind.md`, `_meta/preferences.md`

2. **Scan all project statuses:**
   - `mcp__mcpvault__list_directory` on `projects/`
   - `mcp__mcpvault__read_multiple_notes` on each project's `PROJECT.md`
   - Read the `## Status` section of each for blockers, deadlines, and stalled items

3. **Check recent vault activity:**
   - `mcp__mcpvault__get_vault_stats` for recently modified files
   - `mcp__mcpvault__search_notes` for ideas captured in the last few days

4. **Write the briefing** — `mcp__mcpvault__write_note` to `briefings/YYYY-MM-DD-Weekday.md`:

   ```yaml
   ---
   date: 'YYYY-MM-DD'
   day: <Weekday>
   generated_by: Shoggoth PM
   projects_reviewed: <N>
   ---
   ```

   Body sections:
   - `# Daily Briefing — Weekday, Month DD, YYYY`
   - `## Most Urgent` — The single highest-priority item with specific context: what's blocked, why it matters now, what the immediate target is. Be concrete about time estimates and consequences of delay.
   - `## Active / Needs Attention` — Each active project with current status, blockers, and a specific ask for today. Skip projects with no updates or actions.
   - `## Recent Captures` — Ideas captured since the last briefing, with one-line summaries and whether any warrant investigation.
   - `## Suggested Focus` — A concrete recommendation for how to spend the day, given priorities and energy. Not "work on your projects" — something like "2 hours on pipeline wiring, then the diagnostic call."

## Quality bar

- Every item must have a *specific* action, not a vague reminder
- Reference actual file paths, data points, and project states — not summaries of summaries
- If a blocker has persisted across multiple briefings, call it out explicitly
- Prioritize by research impact and time-sensitivity, not recency
- Keep it under 800 words unless there's genuinely a lot happening

## What not to do

- Don't generate briefings on weekends unless asked
- Don't include projects with nothing to report
- Don't use vague language ("consider reviewing", "might want to look at")
- Don't pad with motivational filler
