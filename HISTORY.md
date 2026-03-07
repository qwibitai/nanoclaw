# History

Session log — what we worked on, what problems we solved, and how the system evolved.

---

## 2026-03-07 09:15–22:00 EST (Sessions 1–5)

Built and tested the full fleeting notes processing pipeline end-to-end across five sessions. Started with a snapshot of the vault state (9 processed fleeting notes, 2 unrouted inbox items, empty daily note), then iterated through increasingly complete versions of the pipeline.

**Session 1 (morning):** Defined the daily note format spec, created the project registry, established fleeting note storage conventions (`Fleeting/{year}/{month}/{day}/{slug}.md`), and ingested the first 5 Things Today items as fleeting notes. Documented 10 foundational constraints (append-only daily notes, one-way links, `[[path|*]]` short symbols, Things Today as sole source).

**Session 2 (afternoon):** Aligned the system with Ahrens' Zettelkasten framework — fleeting notes are temporary captures, permanent notes are user-rewritten insights, project notes are action items that die with the project. Mass-completed ~2,700 stale checkboxes across 355 vault files, configured Obsidian Tasks plugin with `#task` global filter. Processed "Pedro Reply" as the first end-to-end test (fleeting → project note → Networking todos.md). Created the first permanent + literature note pair (Hannibal AI safety article). Designed per-item action controls (Accept/Retire/Response/Chat) and tested the propose → respond → execute flow with 11 NanoClaw items.

**Session 3 (late afternoon):** Processed remaining cross-project items from Things Ingested (one-time cleanup). Created 4 new projects (K, Lab Journal, AI Productivity, Manager Engineer Workshop). Introduced idea logs and drafts as new project-level objects. First test of the Chat feature (user asks question → LLM responds → note stays unprocessed). Ingested 30 Things Today items in batch 1, processed all routing decisions (22 retired, 2 accepted, 3 responses, 3 chats).

**Sessions 4–5 (evening):** Consolidated vault structure — merged all registered project content from `2. Areas/` into `1. Projects/`, eliminating the separate Areas directory. Ingested all 51 remaining Things Today items, emptying the queue to zero. Processed all routing decisions (7 accepts, 6 responses, 37 retires). Created Workshop project directory. Ran pipeline integrity audit: found and fixed 8 orphan notes (completed but missing `converted_to:`), documented case-sensitivity risk, added Gherkin integrity check scenarios to the format spec as countermeasures.

Final state: 159 fleeting notes (49 completed, 101 retired, 0 raw), 13 projects with new content, Things Today empty, pipeline fully operational with integrity checks.

---

## 2026-03-01 17:58–18:21 EST

Set up the Telegram capture group — a dedicated channel where every message is automatically captured to the exocortex without needing a trigger word. Built the full pipeline: registered the group in the database with `requires_trigger=0`, wrote a minimal CLAUDE.md for the capture agent, and configured the exocortex mount with write access.

Tested project routing end-to-end: messages tagged `@onto` land in `projects/onto/inbox.md`, `@nanoclaw` in `projects/nanoclaw/inbox.md`, untagged in the general `inbox.md`. Hit the Telegram bot privacy mode wall — bots can't see group messages by default, had to guide through BotFather settings.

Wired up Things 3 ingestion for the NanoClaw project. The sync pipeline picks up new tasks, writes them to `things_inbox.json`, the agent processes them into the right project inbox, and completed items move under the "Ingested" heading in Things. Dropped the sync interval from 1 hour to 10 minutes.

Changed inbox write order from append to prepend — newest entries now appear at the top of inbox files instead of buried at the bottom. Tested by running the full Things sync pipeline and verifying file position.

Added testing policy to CLAUDE.md: when changing agent behavior, don't just update instructions — run the actual pipeline and verify the side effects.
