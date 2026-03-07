## Why

Fleeting notes — quick captures from Things inbox, Telegram capture group, and daily observations — accumulate faster than they get processed. The current pipeline ingests them but doesn't structure, route, or action them. Processing happens manually in Obsidian, following a method that hasn't been documented or automated. By recording the manual workflow first, we can identify the stages, key documents, and decision points, then progressively automate them.

This is a "record first, automate later" change: today's session captures the method; future work implements it.

## What Changes

- Record the complete fleeting notes processing workflow as it happens (stages, decisions, artifacts produced)
- Document the two key objects: Things status and Obsidian daily note status
- Identify processing stages and the transformations between them (capture → triage → route → integrate)
- Produce a workflow specification that can drive future automation
- The plan itself evolves during the session — both "what we record" and "how we record it" are living concerns

## Capabilities

### New Capabilities
- `fleeting-notes-workflow`: Documents the manual fleeting notes processing method — stages, inputs, outputs, decision points, and key documents produced
- `session-recording`: Method for recording an interactive workflow session — what to capture, where to store observations, how to update the plan as understanding evolves

### Modified Capabilities
- `things-sync`: Will eventually be modified to support the automated workflow (not changed today, but informed by today's recording)
- `obsidian-sync`: Will eventually be modified to support automated note routing (not changed today, but informed by today's recording)

## Constraint Format

Constraints use **Gherkin format** (Given/When/Then) where appropriate. This applies across OpenSpec, not just this change.

**When to use Gherkin:** Behavioral rules that describe scenarios — ingestion, processing, routing, lifecycle transitions. Anything that has an input state, an action, and an expected outcome.

**When plain prose is fine:** Simple declarations (e.g. "daily notes are append-only") that don't benefit from scenario decomposition.

**Rationale:** Gherkin is the dominant standard for behavioral specifications (since Cucumber ~2008). It's human-readable, unambiguous, and directly testable — a future routing agent can be verified against these scenarios. Nothing better has replaced it for this purpose.

## Constraints

- **Daily notes are append-only** — never rewrite or modify existing content in a daily note. Only append to the end, and always note when and what was appended.
- Append blocks should include a timestamp and source identifier so the user can tell what added them and when.
- Processing stages (triage, route, integrate) may reference daily note content but must not alter it.
- **No items may be missed** — completeness is mandatory. Every item from a source must be represented. If an item is missing, investigate why before proceeding. Partial snapshots are failures.
- **Full representation** — notes, descriptions, and metadata must be shown in full. Never truncate content. If an item has notes attached, the full notes text must appear.
- **Things Today is the sole input source** — going forward, ingestion pulls only from Things Today. Inbox is not a processing source for the automation pipeline (items reach Today via Things' own scheduling).
- **One-way links only** — link from the referencing note (e.g. daily note) to the target (e.g. fleeting note). Do NOT manually create reverse links. Obsidian's backlinks panel handles the reverse direction automatically. (Decision: 2026-03-07)
- **Route by linking** — routing a note means creating an Obsidian `[[wiki link]]` from the note to its destination (project, area, etc.). The original note with its link is the source of truth — content may be duplicated at the destination for readability, but the original always remains.
- **Short link symbols** — when linking from daily notes or summaries to fleeting notes, use `[[path|*]]` syntax so the link renders as a minimal `*` rather than the full filename. Keeps the daily note readable.
- **Source of truth is the original note file** — the fleeting note file (e.g. `Fleeting/2026/03/07/pedro-reply.md`) is always the ground truth. Text duplicated elsewhere (daily notes, project pages, summaries) is for readability only. Before acting on a note — routing, editing, processing — always read the original file, never rely on downstream copies. Downstream representations may be stale, truncated, or reformatted.

## Fleeting Notes Storage

- **Path pattern:** `Fleeting/{year}/{month}/{day}/{slug}.md` (e.g. `Fleeting/2026/03/07/pedro-reply.md`)
- **Frontmatter:** `source`, `created`, `things_uuid`, `status` (raw → triaged → routed → processed)
- Old flat structure (`Fleeting/2026-03-03-001-*.md`) is legacy; new notes use the nested year/month/day structure.

## Project Registry

The project registry lives at `~/Documents/vvault/1. Projects/registry.md`. It is the source of truth for:
- What projects exist and are active
- Aliases (alternative names a project may be referred to by)
- Vault paths and evergreen file locations
- GitHub repos associated with each project
- Routing rules (which tags/keywords map to which projects)

Registered projects: Networking, NanoClaw, Venus Mars, AI Finance, AI Business and Society, Workshop, Innovation.

## Append Format (universal)

All appends — to daily notes, evergreen notes, or any other file — use the same structure:

```markdown
---

## {Section Title} (appended {YYYY-MM-DD} ~{HH:MM} {TZ})

- **{Item title}** ({YYYY-MM-DD}) [[Fleeting/{year}/{month}/{day}/{slug}|*]]
  **Notes:** {full notes text, if any}
  **Proposed:** {routing proposal, if applicable}
```

Rules:
- Start with `---` separator
- Section header includes a timestamp of when the append happened
- Each item shows title, date, and a `[[...|*]]` link to the source note
- Full notes text below the item (never truncated)
- If updating an existing append block, add a new timestamp to the header (e.g. `updated ~{HH:MM} {TZ}`) rather than removing the original
- This format is the same whether appending to daily notes, evergreen notes, or any other document — consistency enables downstream processing

## Evergreen Notes Format

Evergreen notes use date headers (`# YYYY_MM_DD_DayName`) with freeform content appended underneath. This format is suitable for both humans and AI:
- Date headers allow subsetting by date range
- Freeform content under each date is natural language (LLM-friendly)
- New content is always appended under a new date header — never modifies existing entries
- No additional markup needed for AI use; the date-structured format is already parseable

## Key Objects for Fleeting Notes Processing

| Object | Location | Role |
|--------|----------|------|
| Project Registry | `~/Documents/vvault/1. Projects/registry.md` | Source of truth for project names, aliases, vault paths, evergreen files, GitHub repos, and routing rules. Must be consulted before routing any note. |
| Daily Note | `~/Documents/vvault/0a. Daily Notes/{year}/{month}/{date}.md` | Append-only summary surface. Links to fleeting notes via `[[...\|*]]`. |
| Fleeting Notes | `~/Documents/vvault/Fleeting/{year}/{month}/{day}/{slug}.md` | Ground truth for captured items. Frontmatter tracks lifecycle status. |
| Evergreen Notes | Per-project (see registry) | Long-lived project notes. Append under date headers, never modify existing content. |

## Active Objects (session continuity)

These are the live objects and their last known states, so context survives across session clears:

| Object | Location | Last Known State |
|--------|----------|-----------------|
| Things Today | `things today` | 119 items total (sole input source) |
| Exocortex Inbox | `~/Documents/ai_assistant/inbox.md` | 2 unrouted items (@ei, @consulting) |
| Fleeting Notes (exocortex) | `~/Documents/ai_assistant/fleeting/` | 9 files, all retired/incorporated |
| Fleeting Notes (vault) | `~/Documents/vvault/Fleeting/2026/03/07/` | 5 new notes created from Things Today |
| Daily Note | `~/Documents/vvault/0a. Daily Notes/2026/03-March/2026-03-07-Saturday.md` | Morning check-in + snapshot with [[*]] links to fleeting notes |
| Session Log | `openspec/changes/fleeting-notes-automation/session-log.md` | Stage 1 complete, Stage 2 in progress |
| Claude Code Session | `4850cbd1-dd77-4eb8-9150-42bc1a8952d2` (Session 3, continuation) | Active |

## To-Do Architecture (Zettelkasten-aligned)

### Note Type Mapping

| Ahrens Category | System Category | Location |
|-----------------|----------------|----------|
| Fleeting note | Fleeting note | `Fleeting/{year}/{month}/{day}/{slug}.md` |
| Permanent note | Permanent note (insight) | `1. Projects/{project}/{slug}.md` |
| Project note | To-do / project-scoped note | `1. Projects/{project}/notes/{year}/{month}/{day}/{slug}.md` |
| Literature note | Literature note (source material) | `1. Projects/{project}/literature/{author-slug}.md` |

### Project-Level Objects

Beyond notes, each project can have several operational files that serve different purposes:

| Object | File | Purpose | Content |
|--------|------|---------|---------|
| To-dos | `todos.md` | Actionable tasks | Tasks plugin query block + `#task` items |
| Notes index | `notes.md` | Index of project notes | Links to notes in `notes/` directory |
| Ideas | `ideas.md` | Raw ideas not yet actionable | Date-grouped entries with source links |
| Drafts | `drafts/{year}/{month}/{date}-{slug}/` | Multi-file creative artifacts | `draft.md` (main text) + supporting files |

**Relationship between objects:**
- **Project notes** (`notes/`) are the primary unit — one note per fleeting note routed to the project. They can contain `#task` items (collected by `todos.md`).
- **Ideas** (`ideas.md`) are lighter than project notes — single-line entries for captures that aren't actionable yet. Ideas can be promoted to project notes (when developed) or todos (when actionable).
- **Drafts** (`drafts/`) are for long-form creative work (articles, papers). Each draft gets its own directory. A project note references the draft and serves as the metadata/context layer.
- **Notes index** (`notes.md`) provides a human-curated view of what's in the project — not auto-generated, but maintained as notes are added.

Not every project needs all of these. Create them as needed:
- `todos.md` — created when the first `#task` is routed to the project
- `ideas.md` — created when the first idea is captured
- `drafts/` — created when the first creative artifact needs its own directory
- `notes.md` — created when the project has enough notes to benefit from an index

### Conversion Paths

Fleeting notes convert via these paths (or combinations, or discard):

1. **Fleeting -> permanent note** (insight worth keeping) — rewrite in own words, link to slip-box
   - **Constraint:** AI cannot create permanent notes alone. User must provide brain dump or confirm AI's proposed rewrite.
   - Permanent notes live in `1. Projects/{project}/` — organized by project. All project content consolidated under `1. Projects/`.
2. **Fleeting -> permanent note + literature note** (insight from a source) — both are created:
   - Literature note: selective paraphrase at top (your reading), full source text below (preservation against link rot). Lives in `1. Projects/{project}/literature/`.
   - Permanent note: your atomic insight, links to the literature note. Lives in `1. Projects/{project}/`.
   - Fleeting note frontmatter gets both `converted_to:` and `literature_note:` links.
3. **Fleeting -> project note / to-do** (action item) — create project note in `{project}/notes/{year}/{month}/{day}/{slug}.md`, add `#task` to the project note (collected by `todos.md` query block)
4. **Fleeting -> idea log entry** (not yet actionable) — add entry to `{project}/ideas.md` with date and source link
5. **Fleeting -> draft** (creative artifact) — create draft directory in `{project}/drafts/{year}/{month}/{date}-{slug}/`, create project note referencing the draft, reference in `notes.md`
6. **Fleeting -> retired** (no action needed) — mark `status: retired`, no destination created

Paths 1-5 mark the fleeting note as `status: completed` and add `converted_to:` frontmatter linking to the destination.

### Processing Constraint

AI **proposes** routing decisions but does not execute them automatically. The user reviews and confirms before any note is created, moved, or marked completed. This is a hard constraint until explicitly relaxed.

### Things Ingestion (future change)

- **Long-term:** Things Today is the sole ingestion source. No other Things views or project headings are used.
- **One-time cleanup (2026-03-07):** ALL items across ALL projects/areas in the Things "Ingested" heading were processed through the fleeting notes pipeline as a one-time cleanup. This covered @nanoclaw, @mary, @today, @ei, @consulting, @systems, and @class tags. Going forward, only Things Today feeds the pipeline — no more batch processing from project headings or Ingested lists.
- **Completion model:** When a note is ingested as a fleeting note in Obsidian, the Things item MUST be marked as **completed in Things** (not moved to an "ingested" list). The fleeting note file becomes the source of truth; the Things item is just an origin record. This replaces the current NanoClaw ingestion setup that moves notes to an ingested state.
- **Three places:** Things (capture source) → Obsidian fleeting note (ground truth) → Obsidian daily note (summary surface). Completion in Things happens at ingestion time, not at routing time.
- **Auth requirement:** `things update --id <UUID> --completed` requires a Things auth token. Set `THINGS_AUTH_TOKEN` or run `things auth`.
- Current `things-sync.ts` will need to be updated to use this model.

### Literature Notes

Literature notes preserve the original source material. Structure:
- **Body:** The actual full text of the source — not a paraphrase, not a summary. The real text, preserved against link rot.
- **Frontmatter:** `author`, `date`, `url`, `type: literature-note`
- **Constraint:** Literature notes must contain the verbatim source text. AI summarization is not acceptable — the point is preservation.
- **Constraint:** When WebFetch is used (which AI-summarizes content), the note must clearly state that the text is a WebFetch summary, not verbatim. E.g. `> Note: This text was retrieved via WebFetch and may be AI-summarized, not verbatim.`
- Future: an agent fetches the raw article text (not AI-processed) and creates the literature note automatically

### Permanent Notes

Permanent notes capture YOUR insight — atomic, in your own words, standing alone without context. They:
- Live in `1. Projects/{project}/` (consolidated under projects — all project content in one place)
- Body is **only your text** — no source links, no references, no citations in the body
- Connection to literature notes lives in frontmatter (`literature:` field) — machine-readable, body stays clean
- Link to other permanent notes (future: agent proposes connections based on semantic similarity)
- Are never tied to a completion state — they're part of the growing slip-box

### `#task` Global Filter

The Obsidian Tasks plugin's global filter is set to `#task`. Only `- [ ] #task ...` checkboxes are tracked as tasks. All legacy open checkboxes have been mass-completed (2026-03-07).

- Tasks plugin queries collect `#task` items across the vault
- Completing a task in a query view auto-updates the source file
- Config: `.obsidian/plugins/obsidian-tasks-plugin/data.json`

### Per-Project `todos.md`

Each active project gets a `todos.md` with:
- A Tasks plugin query block (auto-collects `#task` items from the project directory)
- Manually appended to-do items using the standard append format
- Links to project notes via `[[...|*]]`

### AI Pre-Processing (future)

When converting fleeting notes into project notes, an AI pre-processing step should:
- Check the relevant repo for what's already implemented
- Assess scope and feasibility
- Surface related existing work, specs, or proposals
- Turn raw captures into grounded, actionable project notes rather than aspirational to-dos
- For URL-bearing fleeting notes: fetch article text, draft a literature note with "My reading" section for user confirmation

### Routing Agent (future)

A dedicated agent that handles fleeting note routing. It:
- Has its own explicit goals file (what routing decisions to optimize for, how to prioritize)
- Proposes routing decisions (project note, permanent note, literature note, retire) — does not execute without user confirmation
- Reads the project registry, existing project notes, and permanent notes to inform proposals
- Could incorporate the AI pre-processing step (check repos, assess feasibility) as part of its routing proposal
- Operates on its own cadence (e.g. when new fleeting notes arrive)

### Image Ingestion (future)

Fleeting notes may include images (screenshots, photos, scanned documents). The pipeline should support:
- **Capture:** Images attached to Things items or pasted into fleeting notes
- **Storage:** Images stored alongside the fleeting note file (same directory or a shared attachments directory)
- **Obsidian rendering:** Use `![[image-name.png]]` embed syntax in the fleeting note body
- **Processing:** When routing a fleeting note with images, images travel with the note to the destination (project note, permanent note)
- **Obsidian settings:** Configure attachment folder in Obsidian settings (Settings > Files & Links > Default location for new attachments). Options: vault root, same folder as current file, or specified folder.

This was requested during routing session 006 (2026-03-07) when a Telegram discussion screenshot needed to be part of a literature note.

### Connection Agent (future)

An agent that monitors the slip-box and proposes connections between permanent notes. This is the core value engine of Zettelkasten — without connections, permanent notes are just files.

**Responsibilities:**
1. **Monitor** — watch for new/updated permanent notes across all `1. Projects/` directories
2. **Propose links** — scan existing permanent notes for semantic similarity, shared tags, or thematic overlap, and propose `[[links]]` between them (via `related:` frontmatter)
3. **Communicate proposals** — surface proposed connections to the user through a dedicated channel (daily note section, Telegram notification, or Obsidian sidebar). The user must see what's being proposed and why.
4. **Track state** — maintain a record of which notes have been analyzed, which proposals were accepted/rejected, and which connections exist. Avoid re-proposing rejected links.

**Communication system:**
- Proposals should show: source note, target note, reason for connection (shared theme, overlapping tags, semantic similarity score)
- The user needs a single place to review and accept/reject proposed links (similar to how routing decisions work in the daily note)
- Accepted links get written to both notes' `related:` frontmatter
- Rejected links get recorded so they're not re-proposed

**Triggers:**
- New permanent note created → scan for connections to existing notes
- Periodic sweep (e.g., weekly) → re-scan all notes for missed connections
- User requests → "what connects to this note?"

**Implementation notes:**
- Could use embeddings for semantic search across permanent notes
- Tag registry (`2. Areas/tags.md`) provides a structured signal for grouping (vault-level, not project-specific)
- The agent proposes; the user confirms. No automatic link creation.

### Reconciliation (future)

When a `#task` is checked complete in a downstream file, periodically confirm with the user whether the source should also be updated.

### Daily Note Structure

The daily note's Fleeting Notes section shows movement:
- **Unprocessed** — items from Things Today still awaiting triage
- **Routed** — items that have been converted (project note, retired, etc.)

Items move from Unprocessed to Routed as they're processed, giving a visual sense of flow.

## Impact

- Mass-completed ~2,700 stale open checkboxes across the vault (2026-03-07)
- Configured Obsidian Tasks plugin with `#task` global filter
- Created Networking `todos.md` and project note structure
- End-to-end test: Pedro Reply fleeting note -> Networking project note -> todos.md
- Future impact: changes to things-sync.ts, obsidian-sync.ts for automated fleeting note conversion
- Tools used: `things` CLI, `obsidian-cli`, direct file reads of Obsidian vault and Things DB
