---
name: auto-evo
description: Group strategy memory (auto-evo). How to read and update AUTO_EVO.md so behaviour improves across sessions.
---

# Auto-evo (group strategy memory)

NanoClaw injects `AUTO_EVO.md` at **session start** (new chat, resume, or after `/compact`) via a SessionStart hook — so you always see distilled lessons early in context.

## Where

- Path: `/workspace/group/AUTO_EVO.md` (one file per group; not shared across groups).
- Optional disable on host: set env `NANOCLAW_AUTO_EVO_DISABLE=1` for the container (disables injection only).

## When to read

- Before multi-step or ambiguous tasks, skim the **Working strategies** and **Avoid** sections.

## When to update

After you complete non-trivial work (or hit a failure worth remembering):

1. Open `AUTO_EVO.md`.
2. Add short, **actionable** bullets — not a transcript. Prefer:
   - What worked (tools, order of operations, channel-specific formatting).
   - What did **not** work (dead ends, misleading assumptions).
   - Stable preferences the user stated (if durable for this group).
3. Merge duplicates; delete stale bullets so the file stays under ~400 lines.
4. Keep secrets out of this file.

## Sections (keep these headings)

Use the template structure in the file. Typical sections:

- **Working strategies** — repeatable wins.
- **Avoid (anti-patterns)** — mistakes not to repeat.
- **Tooling & channel notes** — e.g. MCP quirks, formatting for this channel’s `CLAUDE.md` rules.
- **Open questions** — unresolved items the next session should address.

## Relation to `CLAUDE.md`

- `CLAUDE.md` = persona + long-lived instructions from the user.
- `AUTO_EVO.md` = **assistant-maintained** distilled runtime lessons that compound across sessions.

Do not replace `CLAUDE.md` with `AUTO_EVO.md`; they complement each other.

## Periodic merge into this Skill (optional)

Runtime **injection** only loads `AUTO_EVO.md`. Updating **this** `SKILL.md` is not automatic: there is no built-in cron inside NanoClaw that rewrites skill files.

To **periodically** consolidate lessons into the discoverable Skill doc (so `Skill` search stays useful):

1. Path inside the container: **`/home/node/.claude/skills/auto-evo/SKILL.md`** (synced from the host per group).
2. In the **main** channel, create a **scheduled task** whose prompt instructs you to:
   - Read `/workspace/group/AUTO_EVO.md`
   - Merge **stable, general** rules into `SKILL.md` under a `## Learned heuristics (auto)` section (short bullets; remove duplicates)
   - Keep YAML frontmatter valid; do not delete the core protocol sections above.
3. Use a weekly or monthly schedule so `AUTO_EVO` (fast scratchpad) can differ from `SKILL.md` (curated, tool-discoverable).

See also `docs/AUTO_EVO.md` in the repo for what is implemented vs. optional scheduling.
