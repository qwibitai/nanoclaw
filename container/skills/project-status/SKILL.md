---
name: project-status
description: >
  Report on a specific project's status by reading its PROJECT.md,
  searching for recent vault mentions, and summarizing. Updates the
  Status section of PROJECT.md when the researcher provides new information.
---

# Project Status

When the researcher asks about a project — "how's community-sorting going?", "what's blocking OOPS?" — read the project's PROJECT.md and give a grounded answer.

## Reporting (when asked about status)

1. **Read project file:**
   - `mcp__mcpvault__read_note` on `projects/<project>/PROJECT.md`
   - This single file contains Status, Context, and Key Decisions sections
   - If it doesn't exist, note the gap

2. **Search for recent context:**
   - `mcp__mcpvault__search_notes` for the project name across the vault — recent ideas, briefing mentions, literature connections
   - Check `ideas/` for sparks connected to this project

3. **Summarize concisely:**
   - Current state (what's done, what's in progress) — from the `## Status` section
   - Blockers (specific, actionable)
   - Next milestone and what it requires
   - Any recent developments from vault search that aren't in PROJECT.md yet

Don't recite the PROJECT.md back — synthesize across sources and highlight what's changed or stuck.

## Updating (when researcher provides new information)

When the researcher shares a project update — "I finished the pipeline wiring", "Giuliano said the IRB is approved" — update the `## Status` section of PROJECT.md:

1. **Read current PROJECT.md** via `mcp__mcpvault__read_note`
2. **Append to the Status section** via `mcp__mcpvault__patch_note`:
   - Add new information to `## Status` (current focus, blockers resolved, milestones completed)
   - Never overwrite the whole file — update the Status section only
3. **Log decisions** — If the update involves a decision, append a new entry at the top of the `## Key Decisions` section
4. **Update frontmatter** — Set `last_updated` to today's date via `mcp__mcpvault__update_frontmatter`

5. **Confirm** — Tell the researcher what you updated.

## If the project doesn't exist in the vault

If asked about a project with no `projects/<name>/` directory:
- Search the vault for mentions to see if it's referenced elsewhere
- Ask the researcher if they want to create a project entry
- If yes, create `projects/<name>/PROJECT.md` with initial content from what the researcher provides, using this template:

  ```yaml
  ---
  phase: <current phase>
  priority: <high | medium | low>
  last_updated: <YYYY-MM-DD>
  ---
  ```

  With sections: description, `## Status`, `## Context`, `## Key Decisions`

## What not to do

- Don't overwrite PROJECT.md — update the Status section only
- Don't fabricate status information not found in the vault
- Don't update the `## Context` section — that's the researcher's document for background and design decisions
- Don't conflate "no information in vault" with "no progress" — ask the researcher
