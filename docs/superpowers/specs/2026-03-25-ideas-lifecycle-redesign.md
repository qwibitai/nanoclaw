# Ideas Lifecycle Redesign

## Problem

The current ideas system in the Obsidian vault over-structures notes at capture time. Every idea gets rich frontmatter (domain, potential, connected_projects) and a rigid template with 6-8 headings. This creates friction at capture, makes sparks look identical to deeply explored ideas, and produces notes that are expensive for agents to scan. The `_registry.md` index duplicates information already in the notes themselves.

## Design

### Lifecycle

Ideas flow through four stages:

```
capture → spark → explored → archived OR upgraded to project
```

The scratch note (`ideas/scratch.md`) serves as the active index. Ideas enter it, get backlinked to their own notes, and leave it when archived or upgraded. The scratch stays lean because ideas flow through rather than accumulate.

### Data Model

**Scratch note** (`ideas/scratch.md`):

```markdown
---
type: idea-scratch
---

- [[2026-03-25-adversarial-deliberation]] — what if you pit two models against each other in deliberation and measure opinion drift
- [[2026-03-23-platform-governance-legitimacy]] — democratic legitimacy frameworks applied to content moderation appeals
```

Newest entries at the top. No other structure.

**Idea note** (`ideas/YYYY-MM-DD-slug.md`):

```markdown
---
created: 'YYYY-MM-DD'
status: spark
---

Raw idea in freeform prose...
```

Frontmatter: `created` and `status` only. Status values: `spark`, `explored`, `archived`, `upgraded`. No domain, potential, or connected_projects -- agents derive these at runtime.

After exploration, two minimal anchors get added:

```markdown
## What we found

Freeform prose synthesizing literature, methodology, and framing findings...

## What to do next

Freeform prose on actionable directions...
```

Explored notes also get `explored: 'YYYY-MM-DD'` in frontmatter.

**Archived idea**: moved to `ideas/archive/`, status set to `archived`.

**Upgraded idea**: moved to `projects/{slug}/ORIGIN.md`, status set to `upgraded`. A new `PROJECT.md` and GitHub repo are created alongside it.

### Skills

Four skills replace the current `idea-capture` and `research-investigation`:

#### 1. `idea-capture` (reworked)

Triggers when the user shares something that sounds like a research idea via WhatsApp, or adds one manually.

Steps:
1. Read `_meta/researcher-profile.md` and `_meta/top-of-mind.md` for context
2. Create minimal idea note at `ideas/YYYY-MM-DD-slug.md` with `created`/`status: spark` frontmatter and raw prose
3. Append backlinked one-liner to `ideas/scratch.md`
4. Confirm to user: "Captured [[slug]] in scratch"

Does NOT: update any registry, add structured sections, prompt for investigation.

#### 2. `idea-explore` (new)

Triggers manually only. User says "explore [[slug]]" or "explore the ideas in scratch."

Steps:
1. Read the idea note(s)
2. Dispatch parallel Opus agents with focused briefs:
   - **Literature agent**: what exists in this space, key papers, gaps
   - **Methodology agent**: how to study this, feasibility of data/methods
   - **Framing agent**: theoretical contribution, connection to researcher's work (reads `_meta/researcher-profile.md`)
3. Synthesize findings into freeform prose under `## What we found` and `## What to do next`
4. Update frontmatter: `status: explored`, add `explored: 'YYYY-MM-DD'`
5. Confirm with brief summary

Design constraints:
- Agents run in parallel (the swarm payoff)
- Synthesis produces a single coherent narrative, not three dumped sections
- Multiple ideas can be explored in parallel, capped at 2-3 concurrent explorations to manage Opus quota
- When processing "explore ideas in scratch," each idea gets its own separate exploration
- If a sub-agent fails (timeout, search unavailable), the synthesis proceeds with partial results and notes which perspective is missing

Implementation notes:
- Single container invocation per exploration. The parent agent runs on Opus with `enableAgentTeams: true` and dispatches Literature/Methodology/Framing agents via `TeamCreate`.
- For batch exploration ("explore ideas in scratch"), the parent agent processes ideas sequentially within one container invocation, running each idea's 3-agent swarm in parallel. The agent limits itself to exploring 2-3 ideas per invocation to cap Opus quota. If more ideas are pending, it reports what it explored and notes the remainder.
- Slugs: lowercase, hyphen-separated, max ~60 chars, derived from the agent's summary of the core concept (not raw user words verbatim).

#### 3. `idea-triage` (new)

Triggers manually. User says "archive [[slug]]" or "upgrade [[slug]] to project."

**Archive path:**
1. Move note via `mcp__mcpvault__move_note` to `ideas/archive/`
2. Update frontmatter via `mcp__mcpvault__update_frontmatter`: `status: archived`
3. Remove backlink line from `ideas/scratch.md` via `mcp__mcpvault__patch_note`
4. Confirm: "Archived [[slug]]"

**Upgrade path:**
1. Create `projects/{slug}/PROJECT.md` via `mcp__mcpvault__write_note` using existing project template:
   ```yaml
   ---
   phase: research
   priority: medium
   last_updated: YYYY-MM-DD
   ---
   ```
   Status/Context/Key Decisions sections seeded from exploration findings in ORIGIN.md
2. Move idea note via `mcp__mcpvault__move_note` to `projects/{slug}/ORIGIN.md`, update `status: upgraded` via `mcp__mcpvault__update_frontmatter`
3. Create private GitHub repo via Bash: `gh repo create {slug} --private --template research-project-template` (uses shell, not MCP -- the skill must instruct the agent to use Bash for this step)
4. Remove backlink line from `ideas/scratch.md` via `mcp__mcpvault__patch_note`
5. Confirm with project link and repo URL

#### 4. `idea-nudge` (new, scheduled)

Runs on Sonnet every 3 days via the task scheduler.

Scheduling config: `schedule_type: cron`, `schedule_value: "0 10 */3 * *"` (every 3 days at 10am). Runs in the main group with `context_mode: isolated`. The scheduled task prompt instructs the agent to invoke the `idea-nudge` skill.

Steps:
1. Scan `ideas/` frontmatter (via `mcp__mcpvault__get_frontmatter`) for:
   - `status: spark` (unexplored)
   - `status: explored` (explored but not triaged)
   - `status: investigated` (legacy status from old system, treated as equivalent to `explored`)
2. If any found, send a single WhatsApp message grouping ideas by staleness category
3. If nothing stale, do nothing (no "all clear" messages)

Example message:
> You have 3 unexplored ideas and 2 explored ideas waiting for a decision:
>
> **Unexplored:**
> - adversarial-deliberation (Mar 25)
> - platform-governance-legitimacy (Mar 23)
>
> **Explored, needs triage:**
> - feature-circuits-political-bias (Mar 20)
>
> Want me to explore or triage any of these?

Sonnet reads frontmatter only -- does not ingest note bodies.

### GitHub Template Repo

A `research-project-template` repo created under the user's GitHub account as a template repository. Must be created before `idea-triage` upgrade path can be used. Created via:

```bash
gh repo create research-project-template --private --template ''
# then populate with skeleton and mark as template via GitHub settings
```

Skeleton:

```
draft/          # writing artifacts
src/            # code
CLAUDE.md       # agent instructions
README.md       # project description
.gitignore      # filters large files (data, models, etc.)
```

Additional directories (`data/`, `test/`, `experiments/`) are created as needed per project, not in the template.

### Migration & Cleanup

**Deleted:**
- `ideas/_registry.md` -- replaced by scratch note

**Replaced:**
- `container/skills/idea-capture/SKILL.md` -- rewritten with minimal flow
- `container/skills/research-investigation/SKILL.md` -- replaced by `idea-explore`

**New artifacts:**
- `ideas/scratch.md`
- `ideas/archive/` directory
- `container/skills/idea-explore/SKILL.md`
- `container/skills/idea-triage/SKILL.md`
- `container/skills/idea-nudge/SKILL.md`
- `research-project-template` GitHub repo

**Unchanged:**
- `project-status` skill (already reads PROJECT.md, upgraded ideas appear naturally)
- `_meta/` files (researcher-profile, top-of-mind, preferences)
- Existing 27 idea notes remain in `ideas/` as-is; separate session to migrate later

**Minor update:**
- `daily-briefing` skill -- add count of ideas in scratch to morning briefing for visibility

### Group CLAUDE.md Update

The main group's CLAUDE.md (the group where idea capture is triggered) needs updating to:
- Reference the new capture flow (scratch + backlink) instead of the registry
- Remove any mention of `_registry.md` or structured templates
- Add instructions for the `idea-explore` and `idea-triage` trigger phrases

### Daily Briefing Update

Add a line to the briefing output showing idea pipeline status: count of sparks in scratch and explored ideas awaiting triage. This goes under the existing "Active / Needs Attention" section as a sub-item, not a new top-level section.
