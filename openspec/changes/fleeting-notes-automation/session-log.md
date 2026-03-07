# Fleeting Notes Processing Session Log

Session: 2026-03-07
Plan: [plan-2026-03-07T0912-recording-architecture.md](plans/plan-2026-03-07T0912-recording-architecture.md)
Raw transcripts:
- Session 1a: `~/.claude/projects/-Users-nanoclaw-Documents-nanoclaw/a4bb68de-bf1d-4e8f-b990-7003398142e6.jsonl` (09:18 — initial snapshot)
- Session 1b: `~/.claude/projects/-Users-nanoclaw-Documents-nanoclaw/5c6866ca-8e7b-49ee-bd7c-cc272bd60ace.jsonl` (09:25 — recording plan execution)
- Session 1c: `~/.claude/projects/-Users-nanoclaw-Documents-nanoclaw/8820d29e-9f5d-46fa-bc65-3455eaedc865.jsonl` (10:32 — skills test + daily note append + constraints)
- Session 2: `~/.claude/projects/-Users-nanoclaw-Documents-nanoclaw/4850cbd1-dd77-4eb8-9150-42bc1a8952d2.jsonl` (afternoon — to-do architecture, routing, Chat feature)
- Session 3 (continuation of 2): same transcript file as Session 2 (context overflow → new conversation)

---

## Stage 1: Snapshot (2026-03-07 ~09:15 EST)

### Things Inbox
- **1 item** — empty title (UUID: 3XqjHcg7yzN7cjjFGgXdFa), status: incomplete
- `things_inbox.json`: empty array `[]` (sync pipeline has already consumed or nothing new)

### Things Today
- Large list of items (many tasks across projects)
- Not individually enumerated — focus is on inbox processing

### Exocortex Inbox (`~/Documents/ai_assistant/inbox.md`)
- **2 unrouted items** in "Unrouted — No project exists for these tags":
  1. `@ei` — "Need to reply to Adam" (from Things, 2026-03-04)
  2. `@consulting` — "AI in Europe" with LinkedIn link (from Things, 2026-03-04)
- **1 processed section** from 2026-03-06 (archived, read-only reference)

### Fleeting Notes (`~/Documents/ai_assistant/fleeting/`)
- **9 files**, all from 2026-03-03 to 2026-03-05
- All have been previously processed (status: `retired` or `incorporated` in frontmatter)
- Breakdown:
  | File | Status | Project | Content |
  |------|--------|---------|---------|
  | `2026-03-03-001-today-exam-ud-onto-claw.md` | retired | nanoclaw | Cryptic fragment |
  | `2026-03-03-002-nanoclaw-notes-in-context-of-what.md` | incorporated | nanoclaw | Agent needs context notes |
  | `2026-03-03-003-nanoclaw-is-should-have-an-agent.md` | incorporated | nanoclaw | Agent prepares prompts for projects |
  | `2026-03-03-004-nanoclaw-ingest-from-email-too-goal.md` | incorporated | nanoclaw | Email ingestion goal |
  | `2026-03-04-001-onto-test.md` | retired | onto | Test message |
  | `2026-03-05-001-test-capture-ingestion.md` | retired | general | Test message |
  | `2026-03-05-002-test-from-things-2026-02-23.md` | retired | general | Test message |
  | `2026-03-05-003-prepend-test-nanoclaw.md` | retired | nanoclaw | Test message |
  | `2026-03-05-004-nanoclaw-not.md` | retired | nanoclaw | Unclear fragment |

### Daily Note (`~/Documents/vvault/0a. Daily Notes/2026/03-March/2026-03-07-Saturday.md`)
- Exists with morning check-in filled in
- Main focus: therapy with Casey, F1 qualifying, nanoclaw work, systems thinking homework
- Other sections (constraint, how Index can help, methods, success criteria, notes) are empty

### Snapshot Summary

| Container | Count | State |
|-----------|-------|-------|
| Things Inbox | 1 item (empty title) | needs triage |
| Exocortex Inbox | 2 unrouted items | needs routing |
| Fleeting Notes | 9 files (all previously processed) | clean — no new work |
| Daily Note | partially filled | morning check-in done |

**Key observation:** The fleeting notes directory contains only previously-processed notes (all retired/incorporated from 2026-03-05). No new fleeting notes have arrived since then. The active work is in the exocortex inbox (2 unrouted items) and the Things inbox (1 empty item).

---

## Stage 2: Triage (2026-03-07 ~09:30 EST)

### Action 2a: Append Things snapshot to daily note (first attempt)

- **What:** Appended 5 latest Today items and 1 inbox item to the daily note
- **Issue 1 — Missing item:** "Pedro reply" (created 2026-03-07 08:13) was in Things Today but not in the first snapshot. Root cause: the `things today --json` call returned data sorted by `today_index`, and the python sort by `created` descending showed items from 2026-03-03 first because "Pedro reply" had just been added and the CLI data was stale or the sort missed it due to empty-title items being interleaved.
- **Issue 2 — Truncated notes:** "Nanoclaw describe evergreen notes" had a long notes field that was cut off at 60 chars. Full notes must always be shown.
- **Constraint discovered:** Daily notes must be append-only — never rewrite existing content, always include timestamp of append

### Action 2b: Fix daily note append (correction)

- **What:** Replaced the appended section with corrected data — full notes, Pedro reply included, inbox removed (Today is the sole source)
- **Constraints documented in proposal:**
  1. Daily notes are append-only
  2. No items may be missed — completeness is mandatory
  3. Full representation — never truncate notes or metadata
  4. Things Today is the sole input source (not inbox)
- **Objects changed:**
  - Daily note: corrected append block (Pedro reply added, full notes shown, inbox section removed)
  - Proposal: 3 new constraints added, Active Objects table updated (inbox removed as source)
- **Decision:** Going forward, ingestion only pulls from Things Today. Inbox items are not part of the automation pipeline.

### Action 2c: Research Obsidian linking best practices (~09:40 EST)

- **Question 1:** Should we create manual two-way links (A→B and B→A)?
  - **Answer: No.** Obsidian's backlinks panel automatically tracks reverse links. When daily note links to a fleeting note, the fleeting note's backlinks panel shows the daily note. Manual reverse links are redundant and create maintenance burden.
  - **Decision:** One-way links only. Link from referencing note to target. (Recorded in proposal)

- **Question 2:** Can wiki links show a short symbol instead of the filename?
  - **Answer: Yes.** `[[path/to/note|*]]` renders as clickable `*` in reading mode. Standard Obsidian pipe alias syntax.
  - **Decision:** Use `[[path|*]]` for fleeting note links in daily notes. (Recorded in proposal)

### Action 2d: Create fleeting notes and link from daily note (~09:45 EST)

- **What:** Created 5 fleeting note files in `Fleeting/2026/03/07/` (new year/month/day directory structure), then updated the daily note append block with `[[...|*]]` links to each.
- **Fleeting notes created:**
  | File | Things UUID | Source Title |
  |------|-------------|-------------|
  | `pedro-reply.md` | YSS1cKQnHBZuGHEdJYTmZm | Pedro reply |
  | `apply.md` | 2aWtQbFZ6R2Kdo25E7ffhT | Apply? |
  | `nanoclaw-describe-evergreen-notes.md` | BEs4SYMXqu4yvtfa6qyTw5 | Nanoclaw describe evergreen notes |
  | `venus-mars.md` | 6oiuuvnynQVTRQeWENhij3 | Venus mars |
  | `hannibal-on-ai.md` | LWB8gDYZhpWUB6u75NvFmG | Hannibal on Ai |
- **Frontmatter schema:** `source`, `created`, `things_uuid`, `status` (lifecycle: raw → triaged → routed → processed)
- **Storage convention:** `Fleeting/{year}/{month}/{day}/{slug}.md` — replaces old flat naming
- **Daily note updated:** each item now has `[[Fleeting/2026/03/07/slug|*]]` link after the title
- **Proposal updated:** Added Fleeting Notes Storage section, Project Registry section, 3 new linking constraints, updated Active Objects table

### Constraints and decisions documented in proposal (cumulative):
1. Daily notes are append-only
2. No items may be missed
3. Full representation (no truncation)
4. Things Today is the sole input source
5. One-way links only (backlinks panel handles reverse)
6. Route by linking (original note is source of truth)
7. Short link symbols (`[[path|*]]`)
8. Fleeting notes stored in `Fleeting/{year}/{month}/{day}/`
9. Project registry for routing rules
10. Original note file is always ground truth — never act on downstream copies without checking the source first

### Action 2e: Create project registry (~09:55 EST)

- **What:** Surveyed the full Obsidian vault structure (`1. Projects/`, `2. Areas/`) and existing evergreen files, then created `Projects/registry.md` as the machine+human readable project registry.
- **Vault survey findings:**
  | Project | Vault Location | Has Evergreen | GitHub |
  |---------|---------------|---------------|--------|
  | Networking | `1. Projects/Networking/` | no | none |
  | NanoClaw | `1. Projects/AI Assistant/` | yes | `index-engine/nanoclaw`, `index-engine/ai_assistant` |
  | Venus Mars | `1. Projects/Venus and Mars/` | yes | `vmeursault/venus_mars` |
  | AI Finance | `1. Projects/AI Finance/` | per-subdirectory | `vmeursault/intentional_ai_measurement` |
  | AI Business & Society | `2. Areas/02. Teaching/AI, Business, and Society/` | yes (directory of topic files) | `vmeursault/ai_business_society` |
  | Workshop | *(not yet created)* | no | `sam-braun/new-work-order-workshop-2026` |
  | Innovation | `1. Projects/Innovation/` | yes | `vmeursault/inno` |
- **Registry format:** each project is an `##` section with `**key:**` fields (aliases, vault, evergreen, github, status, routing). Trivially parseable by both humans and machines.
- **Evergreen format decision:** existing date-header format (`# YYYY_MM_DD_DayName`) is already suitable for AI — no changes needed. Date headers allow subsetting; freeform content is LLM-friendly. Always append, never modify existing entries.
- **Proposal updated:** Project Registry and Evergreen Notes Format sections rewritten.

---

## Stage 3: To-Do Architecture + Clean Slate (2026-03-07 ~afternoon)

### Session context
Continuing from Stage 2 (same change, new Claude Code session). Plan: implement to-do architecture with Zettelkasten alignment, mass-complete stale checkboxes, and process "Pedro Reply" as end-to-end test.

### Action 3a: Zettelkasten alignment analysis

Mapped the system's note types to Ahrens' categories:
- Fleeting notes = temporary captures (process within 1-2 days)
- Permanent notes = insights rewritten in user's own words (AI can propose, user must confirm)
- Project notes = action items / to-dos (live in project directory, die with the project)
- Key insight: to-dos are project notes, not permanent notes. "Reply to Pedro" belongs in `Networking/notes/`, not the slip-box.

### Action 3b: Mass-complete stale checkboxes

- Replaced `- [ ]` with `- [x]` across entire vault (excluding `Templates/`)
- ~2,700 checkboxes across 355 files completed
- Result: only Templates/ retains open checkboxes (54 in 2 template files — intentional)

### Action 3c: Configure Obsidian Tasks plugin

- Created `.obsidian/plugins/obsidian-tasks-plugin/data.json` with `globalFilter: "#task"`
- Only `#task`-tagged checkboxes are now tracked as tasks
- Clean separation: casual checkboxes vs. real tasks

### Action 3d: Process "Pedro Reply" (end-to-end test)

1. Read fleeting note `Fleeting/2026/03/07/pedro-reply.md` (ground truth)
2. Created project note: `1. Projects/Networking/notes/reply-to-pedro.md`
   - Frontmatter: `source: fleeting`, `created: 2026-03-07`, `project: networking`, `type: project-note`
   - Body: `- [ ] #task Reply to Pedro [[Fleeting/2026/03/07/pedro-reply|*]]`
3. Created `1. Projects/Networking/todos.md` with Tasks query block + manual task entry
4. Updated fleeting note: `status: completed`, `converted_to: [[1. Projects/Networking/notes/reply-to-pedro]]`, `project: networking`
5. Appended routing record to daily note

### Decisions documented in proposal (cumulative from Stage 2):
11. `#task` global filter for Obsidian Tasks plugin
12. Per-project `todos.md` with Tasks query blocks
13. Project notes live in `{project}/notes/{year}/{month}/{day}/` directory
14. AI cannot create permanent notes alone — user must confirm
15. Reconciliation (future): confirm source updates when downstream tasks complete

### Action 3e: Process remaining fleeting notes (continued session)

**Apply?** — retired (no action needed)

**Nanoclaw describe evergreen notes** → NanoClaw project note with 2 #task items:
- Define canonical agent setup structure (LADE + bounded context + work recording)
- Define project goals file format and governance model
- Future feature noted: AI pre-processing should check repo for existing implementation before creating project notes

**Venus mars** → Venus Mars project note (`review-revised-draft.md`) with #task to review revised draft on Overleaf. Includes co-author email with review instructions (focus on replicability). Created Venus Mars `todos.md`.

**Hannibal on Ai** → First permanent note + literature note pair:
- Literature note: `2. Areas/AI Safety/literature/honnibal-clownpocalypse.md`
  - "My reading" section (selective paraphrase) + full article text (preservation)
  - Article fetched via WebFetch tool
- Permanent note: `2. Areas/AI Safety/ai-race-undermines-security.md`
  - User's atomic insight: competitive pressure overrides security discipline
  - Links to literature note as source
- Created new `2. Areas/AI Safety/` area
- Fleeting note gets both `converted_to:` and `literature_note:` frontmatter

### Decisions (continued):
16. Networking moved from Areas to Projects (it has deliverables, not just ongoing interest)
17. Project notes use date-structured paths: `{project}/notes/{year}/{month}/{day}/{slug}.md`
18. `todos.md` uses only Tasks query block — no manual duplicate items
19. Daily note Fleeting Notes section: Unprocessed → Routed (shows movement)
20. Literature notes: full source text (preservation against link rot)
21. Permanent notes: only user's words in body, no references. Literature link in frontmatter + `*` link at bottom
22. Permanent notes live in `2. Areas/{topic}/` — organized by topic, outlive projects
23. Literature notes live in `2. Areas/{topic}/literature/`
24. Future: connection agent proposes links between permanent notes (semantic similarity)
25. Future: AI pre-processing fetches article text and drafts literature notes for user confirmation
26. Future: routing agent with its own goals file, proposes routing decisions
27. AI proposes routing but does not execute automatically — user confirms first (hard constraint)
28. Things Today is sole ingestion source; routed items marked completed in Things (not moved to ingested list)
29. WebFetch-sourced text must be labeled as AI-summarized, not verbatim
30. Daily note format spec created: `specs/daily-note-format.md`
31. Notes in daily note: short (2 lines or less) = **Notes:** verbatim; long = **Summary:** AI summary in 2 lines
32. **Proposed:** must include related project from project registry
33. Unprocessed items use numbered lists
34. Human **Response:** area after proposals, before Routed section
35. Unprocessed items carry forward to next day until routed

### Action 3f: Process NanoClaw project items from Things (batch 2)

Ingested 5 items from Things NanoClaw project into daily note with fleeting note files, AI proposals, and human response area. User responded:

1. **Nanoclaw describe evergreen notes** → retired (duplicate)
2. **Nanoclaw try slack** → retired (don't want Slack)
3. **@nanoclaw implement from bottom** → project note `creative-conveyor-belt.md` with #task (creative conveyor belt — connect notes to drafts, assembly line workflow)
4. **@nanoclaw ingest from email too** → retired (already in OpenSpec)
5. **@nanoclaw agent that prepares prompts** → retired (already in OpenSpec)

This was the first test of the propose → human response → execute flow.

---

### Action 3g: Fix Things CLI Full Disk Access

- Things CLI lost database access mid-session (macOS FDA restriction)
- Root cause: Claude Code process didn't have FDA; `ls` works (metadata) but `cp`/`open` fail (content)
- Fix: added `/bin/zsh` to Full Disk Access in System Settings, then restarted Claude Code
- Updated all 11 fleeting notes with correct Things UUIDs (previously set to "unknown")

### Action 3h: Per-item action controls

Updated daily note format spec with interactive controls per unprocessed item:
- `- [ ] Accept` — execute proposal as-is
- `- [ ] Retire` — retire the note
- `**Response:**` — per-item free-text override
- `**Bulk Response:**` — covers all items without individual actions
- Priority: Response > Accept > Retire > Bulk Response
- Spec rule: always use 4-space indentation for sub-content (prevents misalignment on items 10+)

### Action 3i: Process routing session 002

All 11 NanoClaw items accepted via checkboxes:
- 9 retired (already in todo.md or being implemented this session)
- 2 project notes created: `planning-suggestor-agent.md`, `things-today-daily-sync.md`
- Routing session 002 created with full decision table
- Tasks query block added to AI Assistant `todo.md`

### Action 3j: One-time cleanup of ALL Things Ingested items

Processing all items in Things "Ingested" heading — not just NanoClaw, but all @tags. This is a one-time cleanup establishing the new fleeting notes pipeline as the canonical process. Going forward, only Things Today feeds the pipeline.

New items found (14, beyond NanoClaw):
- @mary (2 items) — no project registered
- @today (3 items) — stale daily task lists
- @ei (3 items) — no project registered
- @consulting (1 item) — no project registered
- @systems (4 items) — no project registered
- @class (2 items) — maps to AI Business & Society

Plus 1 remaining @nanoclaw item (notes-in-context) and the already-created @mary touch note = 16 total unprocessed.

All 16 fleeting notes created, added to daily note with proposals and per-item controls. Awaiting user routing decisions.

### Decisions (continued):
36. One-time cleanup: ALL Things Ingested items go through fleeting notes pipeline, regardless of @tag
37. Going forward, only Things Today is the ingestion source (Ingested heading is legacy)
38. Unregistered @tags (@mary, @today, @ei, @consulting, @systems) flagged in proposals — user decides project/area
39. Fleeting note ingestion MUST preserve both Things title AND notes fields — use `--format json` to capture both (table view omits notes)
40. Constraints use Gherkin format (Given/When/Then) where appropriate for behavioral rules

### Action 3k: Process routing session 003

9 items routed from the cross-project Ingested cleanup:
- 2 new projects created: **K** (personal/relationship) and **Lab Journal** (writing/insights)
- 1 permanent note: "things that make me happy" in `2. Areas/K/` (from 2 @mary fleeting notes)
- 1 permanent note: "ai-code-production-illusion" in `2. Areas/Lab Journal/Economic Insights/`
- 1 project note + #task: agent-context-requirements in NanoClaw
- 1 project note + 2 #tasks: intimate-todos in K
- 4 retired: @today exam, @today notes capture, @ei reply to Adam, @ei aggregate AI impacts
- 7 items remain unprocessed: 1 @consulting, 4 @systems, 2 @class

### Decisions (continued):
41. New project "K" registered — routes @mary, @k tags
42. New project "Lab Journal" registered — routes @lab, @journal, @writing. Has "Economic Insights" subfolder
43. Multiple fleeting notes can combine into a single permanent note (e.g. items 2+3 → "things that make me happy")
44. New feature spec: **Chat field** — separate from Response, for when user wants LLM conversation before routing. Note stays unprocessed, conversation appended to fleeting note file. Spec written in Gherkin.

---

## Stage 4: Complete Processing (2026-03-07 ~afternoon, Session 3)

### Session context
Continuation of Session 2 (context overflow). Resumed processing the final 8 unprocessed items and completing the one-time cleanup.

### Action 4a: Routing session 004 — final 8 items

Processed the remaining unprocessed items from the one-time cleanup:

| Item | Action | Destination |
|------|--------|-------------|
| @ei Microsoft code output | Accept | Permanent note in Lab Journal/Economic Insights |
| @consulting AI in Europe | Response | AI Productivity: permanent note + literature note (ECB article via WebFetch) |
| @systems nvidia grounding mantra | Response | Manager Engineer Workshop: permanent note |
| @systems hypothesis completion | Response | Networking: #task (reach out to Sophia Kazinnik) |
| @systems grounding comparison | Retire | — |
| @systems target system hypothesis | Response | Manager Engineer Workshop: #task |
| @class final exam question | Retire | — |
| @class tell this to students | Retire | — |

New projects created and registered:
- **AI Productivity** — routes @consulting, @ai_productivity
- **Manager Engineer Workshop** — routes @systems, @workshop_me

### Action 4b: Things lifecycle spec + completion

- Added Things lifecycle constraint to `specs/daily-note-format.md` (Gherkin format): Things items MUST be marked completed when ingested as fleeting notes
- Updated `proposal.md` with three-place model: Things → fleeting note → daily note
- Marked all 29 previously-routed Things items as completed using `THINGS_AUTH_TOKEN` from `.env`

### Action 4c: NanoClaw Ingested cleanup

Discovered 6 more items under NanoClaw's "Ingested" heading in Things (plus 1 @onto test):
- 3 with content: @labjournal (long voice note on automated research), @test (sync test), @download (guides/roles)
- 3 empty "New To-Do" placeholders
- All 7 marked completed in Things
- 3 real items ingested as fleeting notes and added to daily note

### Action 4d: Routing session 005 — Chat interactions + retire

Item 2 (@test) retired. Items 1 and 3 used the **Chat** feature:

**@labjournal automated research constraints:**
- User asked for Lab Journal article draft directory structure
- LLM proposed `drafts/{year}/{month}/{date}-{slug}/` with `draft.md` per article
- User accepted via Response, asked for project note + reference in notes.md
- Created: draft directory, project note, `notes.md` index

**@download guides for role assignment:**
- User proposed **idea logs** (`ideas.md`) as a new object type for projects
- LLM proposed structure with date-grouped entries and promotion paths
- User accepted via Response, asked for idea log entry in NanoClaw
- Created: `1. Projects/AI Assistant/ideas.md` with first entry

### Action 4e: Document new object types

Updated proposal with **Project-Level Objects** section:

| Object | File | Purpose |
|--------|------|---------|
| To-dos | `todos.md` | Actionable tasks (Tasks plugin query) |
| Notes index | `notes.md` | Human-curated index of project notes |
| Ideas | `ideas.md` | Raw ideas not yet actionable |
| Drafts | `drafts/{year}/{month}/{date}-{slug}/` | Multi-file creative artifacts |

Two new conversion paths added:
- **Fleeting -> idea log entry** (path 4)
- **Fleeting -> draft** (path 5)

### Decisions (continued from Stage 3):
45. New project "AI Productivity" registered — routes @consulting, @ai_productivity
46. New project "Manager Engineer Workshop" registered — routes @systems, @workshop_me
47. Things items MUST be completed at ingestion time (not routing time) — fleeting note becomes source of truth
48. THINGS_AUTH_TOKEN in `.env` — required for `things update --completed`
49. **Idea logs** (`ideas.md`) — new project-level object for raw ideas not yet actionable
50. **Drafts** (`drafts/{year}/{month}/{date}-{slug}/`) — new project-level object for long-form creative work
51. **Notes index** (`notes.md`) — human-curated index of project notes
52. Project-level objects created on demand (not all projects need all objects)
53. Ideas can be promoted to project notes (when developed) or todos (when actionable)
54. Chat feature tested end-to-end: user chats → LLM responds in fleeting note → user gives routing decision → executed

### Action 4f: Things Today batch processing — batch 1 (30 items)

Ingested 30 items from Things Today as fleeting notes in `Fleeting/` and added to daily note with AI routing proposals. User processed all 30:

- **22 Retired** — stale items (old date plans, completed chores, expired networking tasks)
- **2 Accepted:**
  - Casey (2026-02-23) → permanent note `2. Areas/K/reconnection-communication.md`
  - Talk to Dubravka about Scott (2026-02-26) → Networking #task `1. Projects/Networking/notes/2026/02/26/talk-to-dubravka-about-scott.md`
- **3 Responses:**
  - Resubmit pro and pet insurance → created **Chores** project + project note with #task
  - Harness engineering → Lab Journal literature note + permanent note (Economic Insights). OpenAI URL 403'd — needs manual content.
  - Engineering harness → separate literature note (Telegram discussion). User requested image ingestion capability in specs.
- **3 Chats** (stay in Unprocessed, awaiting user follow-up):
  - Mary → LLM found "Things That Make Me Happy" note, proposed linking
  - CJ → LLM proposed self-expression permanent note + #self-expression tag + tag registry concept
  - C superbill → LLM confirmed project note → todo flow is documented, offered to route to Chores

Routing session 006 created. 27 items moved to Routed in daily note. 3 Chat items remain in Unprocessed.

### New objects created in batch 1:
- **Project: Chores** — registered in `registry.md`, `todos.md` created
- **Project note:** `1. Projects/Chores/notes/2026/02/17/resubmit-pro-pet-insurance.md`
- **Permanent note:** `2. Areas/K/reconnection-communication.md`
- **Permanent note:** `2. Areas/Lab Journal/Economic Insights/harness-engineering-spring-2026.md`
- **Literature note:** `2. Areas/Lab Journal/literature/openai-harness-engineering.md` (needs manual content — 403)
- **Literature note:** `2. Areas/Lab Journal/literature/telegram-engineering-harness-discussion.md` (needs manual content)
- **Project note:** `1. Projects/Networking/notes/2026/02/26/talk-to-dubravka-about-scott.md`
- **Updated:** `1. Projects/Lab Journal/notes.md` with Literature & Permanent Notes section

### Decisions (continued):
55. New project "Chores" registered — routes @chores, @personal, personal chores, insurance, pills, errands
56. Routing proposal generation is mandatory at ingestion time — never deferred. Spec added to `daily-note-format.md` with Gherkin scenarios.
57. Image ingestion capability requested — future feature for images in fleeting notes workflow. Added to proposal.
58. Tag registry concept introduced — vault-level `2. Areas/tags.md` similar to project registry (not yet implemented, awaiting user confirmation)
59. 22 fleeting notes bulk-retired via frontmatter update (`status: retired` + `routing_session:` link)

---

## Stage 5: Full Ingestion + Vault Restructure (2026-03-07, Sessions 4-5)

### Session context
Continuation across Sessions 4 and 5 (context overflows). Completed full Things Today ingestion, vault restructure, and pipeline integrity audit.

### Action 5a: Vault restructure — Areas → Projects merge

Consolidated all registered project content from `2. Areas/` into `1. Projects/`:
- K, Lab Journal, AI Productivity, AI Safety, Manager Engineer Workshop all moved
- Removed redundant `area:` fields from registry
- All `vault:` fields now point to `1. Projects/{project}/`
- Updated proposal.md note type mappings accordingly
- Deleted empty `2. Areas/` subdirectories after confirming content existed in `1. Projects/`

### Action 5b: Ingest remaining Things Today (51 items)

Ingested all remaining Things Today items as fleeting notes across `Fleeting/2026/02/14/` through `Fleeting/2026/03/03/`:
- All 51 created with frontmatter: `source: things`, `created: {date}`, `things_uuid: {uuid}`
- All 51 marked completed in Things using `THINGS_AUTH_TOKEN`
- Added to daily note with AI routing proposals following format spec

**Issues encountered and fixed:**
- Things CLI `status` field is integer (`0`) not string (`'incomplete'`) — filter adjusted
- Things DB dates are Unix timestamps, not Core Data epoch — removed `+ 978307200` offset
- Bold markdown rendering broken by trailing spaces (`**title **`) — fixed 35 instances via regex
- Daily note format non-compliance (twice): 3-space → 4-space indentation, `|*` → `|f-note` aliases, truncated Notes → Summary for >2 lines, bare proposals → "Project {name}. {path} — {description}"

### Action 5c: Process all routing decisions

User processed all 51 items:
- **7 Accepted** → project notes with #tasks
- **6 Responses** → custom routing (literature notes, idea log entries, permanent notes)
- **37 Retired** → stale items marked retired
- **1 Skipped** (item 25 — missing from numbering)

**New objects created:**
- 2 Chores #tasks (resubmit reimbursement, buy printer toner)
- 3 AI Productivity literature notes (AI fuck-ups, Shanselman, Fed productivity)
- 1 Innovation #task (start inno repo checks)
- 1 Lab Journal #task (visual intent)
- 1 Workshop #task (process Poldrack) + new Workshop directory
- 1 K #task (prostate massager)
- 3 Lab Journal idea entries, 2 NanoClaw idea entries
- Innovation `todos.md`, Workshop `todos.md`
- 2 permanent notes from prior batch remainders (AI bitter lesson, being mean)

### Action 5d: Pipeline integrity audit

**Statistics:**
- 159 total fleeting notes: 49 completed, 101 retired, 0 raw (9 from legacy)
- 13 projects with new content this session

**Issues found:**
- 8 orphan notes: `status: completed` but missing `converted_to:` — root cause: earlier sessions marked status without adding link field. Fixed retroactively.
- 1 case-sensitivity issue: Innovation `Notes/` (capital N) vs wiki link `notes/`. Works on macOS, would break on Linux.

**Countermeasures added to `specs/daily-note-format.md`:**
- Gherkin scenarios for orphan detection, raw-note-remaining check, case-consistent paths
- Known issue documented with date and root cause

### Action 5e: New project registered

- **AI Safety** — `1. Projects/AI Safety/`, routes @ai_safety, @safety

### Decisions (continued):
60. All registered projects consolidated under `1. Projects/` — no separate `2. Areas/` for project content
61. Permanent notes now at `1. Projects/{project}/{slug}.md` (not `2. Areas/`)
62. Literature notes now at `1. Projects/{project}/literature/{slug}.md`
63. Integrity checks: orphan detection, case-sensitivity, bidirectional links — run after every batch
64. Known issue tracking format: date, count, root cause, fix status in spec files

---

## Session Observations

- The vault had far fewer stale checkboxes than the initial 2,712 estimate (actual: ~2,700 across 355 files with some duplication in counting)
- Templates/ correctly excluded from mass-complete — preserves template checkboxes
- The `#task` filter elegantly solves the "checkbox overload" problem without requiring migration of existing content
- End-to-end test (Pedro Reply) validates the full fleeting -> project note -> todos.md pipeline
- All 5 of today's fleeting notes processed through all 4 conversion paths: #task (Pedro, Venus Mars), project note (NanoClaw), permanent+literature (Hannibal), retired (Apply?)
- Literature note structure: full source text preserved, permanent note is purely user's voice
- First successful propose → response → execute cycle with NanoClaw batch — the format works
- Daily note format spec pinned down: numbered items, Notes/Summary distinction, Proposed with project, Response area, carryover rule
