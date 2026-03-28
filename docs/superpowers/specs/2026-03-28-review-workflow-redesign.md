# Review Workflow Redesign

Redesign of the document review pipeline and dashboard UI. Replaces the current raw-extraction-and-approve flow with an agent-processed, chat-assisted review experience.

## Problem

The current pipeline dumps raw docling extraction into `vault/drafts/` with null metadata and no structure. The review page shows a JSON blob of empty frontmatter and garbled text (especially for diagram-heavy content). The only actions are approve or reject — there's no way to fix metadata, improve content, or communicate with the agent about what a document actually is.

This is unusable for bulk imports of historic course material.

## Design

### Pipeline Change: Agent-First Draft Generation

The ingestion pipeline currently goes: upload → docling extraction → raw draft in review queue. The redesign replaces docling as a mandatory step and puts the agent in charge of document processing.

**New flow:**

1. File lands in `upload/` (via dashboard or filesystem), with or without folder structure.
2. The path parser infers whatever metadata it can from the folder hierarchy (course code, semester, type).
3. The original source file is copied to `vault/attachments/{course}/` (or `_unsorted/`).
4. A fresh NanoClaw agent container is spawned for this single document. It receives:
   - The original source file path (mounted into the container) for multimodal reading
   - Path-parser metadata (course, semester, type — may be partial or null)
   - The vault's existing course structure (list of known courses and categories)
   - The note schema specification (expected frontmatter fields, format)
   - Access to a docling extraction tool — the agent can call it if needed (e.g., to extract embedded figures as separate image files), but it is not mandatory
5. The agent reads the document directly (multimodal), generates proper study notes with structured markdown, summaries, key concepts, and fully populated metadata. If the document contains important diagrams or figures, the agent can invoke docling to extract them as standalone image files for the vault.
6. The agent's output lands in `vault/drafts/{id}.md` as a well-formed draft.
7. The draft appears in the review queue, already classified and readable.

**Docling as a tool, not a pipeline step:** Docling is no longer in the critical path. The agent reads the original file multimodally, which produces better results than docling for most content (especially diagrams, tables, and slides). Docling is available as an agent tool for figure extraction — when the agent encounters important embedded images, it can call docling to extract them as separate files for the vault's attachments folder. This preserves token usage by only invoking extraction when the agent determines it's worthwhile.

Each document gets its own agent invocation — no shared context between documents. This prevents context rot when processing large batches. Documents queue and process sequentially; parallelism is not needed.

The original source file is linked in the draft via wikilink (`source: "[[filename.pdf]]"`).

### Web Channel

A new NanoClaw channel called "web" enables direct communication between the dashboard and NanoClaw without routing through Telegram.

- The dashboard sends messages to a `/api/chat` endpoint.
- NanoClaw stores them in the DB like any channel message.
- A dedicated "review-agent" group handles all review conversations, with its own CLAUDE.md containing instructions about vault structure, metadata schema, note generation, and review behavior.
- Each draft gets its own conversation thread (keyed by draft ID) so chat history is preserved per-draft.
- The agent has the vault mounted read/write, plus access to the original source file, so it can update drafts directly.
- When a chat message arrives for a draft, the prompt includes the current draft content and a reference to the original source file path, so the agent has full context without needing conversation history replay.
- Responses stream back to the dashboard via SSE (Server-Sent Events) for real-time display.

### Review Detail Page (Three-Panel Layout)

When a draft is opened from the queue, the review page shows three panels:

**Left panel — Original Source:**
- Embedded PDF viewer (browser-native `<object>` or `<iframe>`) for PDFs.
- For PPTX/DOCX: rendered preview where possible, download link as fallback.
- Collapsible to give more space to other panels.

**Center panel — Draft Note:**
- Rendered markdown (not raw text).
- Editable frontmatter fields as a form: dropdowns for course, semester, type; text inputs for title and tags.
- Extracted figures displayed inline as actual images.
- Each figure has a remove button.
- A "save" action for manual metadata edits (separate from approve).
- Approve / reject buttons at the bottom.

**Right panel — Chat:**
- Simple message list with text input at the bottom.
- Shows conversation history for this specific draft.
- Agent responses stream in via SSE.
- When the agent updates the draft file, the center panel refreshes automatically to show changes.

On narrow screens, panels stack or use tabs instead of side-by-side layout.

### Overview / Queue Page

The landing page for review, showing all pending drafts with batch management.

**List view:**
- Drafts grouped by course (from path parser or agent classification). Unclassified drafts go under "Unsorted".
- Each entry shows: title, source filename, course, type, figure count, creation date.
- Visual indicator for drafts with active chat history (showing which ones have been worked on).

**Batch actions:**
- Select multiple drafts via checkboxes.
- "Set course" — pick from dropdown, applies to all selected.
- "Set semester" — same.
- "Set type" — lecture, reading, exam-prep, etc.
- "Approve all" — for batches that are ready.
- These write directly to draft frontmatter; no agent involved.

**Navigation:**
- Click a draft to open the three-panel detail view.
- After approving, auto-advance to the next draft in the queue.
- Back button returns to the overview with scroll position preserved.

### Agent Behavior

The review agent group has a CLAUDE.md with specific instructions for review interactions.

**In the chat (follow-up corrections):**

The agent-generated draft is already in the review queue. The chat is for refinements, not initial processing. When the user sends a message:

- The agent reads the current draft state and can access the original source file (multimodal) if needed.
- It makes the requested changes — structural edits, additional detail, metadata corrections.
- It writes the updated draft in-place.
- The center panel refreshes to show changes.

**Metadata inference from conversation:**
If the user mentions context ("this is relevant for the exam", "this connects to BI-2081"), the agent adds appropriate tags and wikilinks to the frontmatter.

**Boundaries:**
- The agent never approves or rejects drafts — that's always the user's action.
- The agent does not move files in the vault — that happens on approve.

### Draft Lifecycle

Complete flow from upload to vault:

1. **Upload** — file lands in `upload/`, with or without folder structure.
2. **Path parsing** — metadata inferred from folder hierarchy. Original copied to `vault/attachments/`.
3. **Agent processing** — fresh container reads original file (multimodal) + path metadata, generates structured study notes with filled metadata. Calls docling tool for figure extraction if needed.
4. **Draft created** — agent output in `vault/drafts/{id}.md`, original already in `vault/attachments/`.
5. **Review queue** — appears in overview, grouped by course.
6. **User opens draft** — three-panel view: original source, processed draft, chat.
7. **User iterates** — fixes metadata manually, asks agent for changes via chat, removes bad figures.
8. **User approves** — draft moves to target path in vault, status set to approved, original linked.
9. **Auto-advance** — next draft in queue opens.

### Approved Note Format

```yaml
---
title: "Nettverk og datakommunikasjon"
type: lecture
course: IS-1500
course_name: Digital Samhandling
semester: 3
year: 2
language: "no"
status: approved
tags: [tcp, osi-model, networking]
source: "[[03_-_Nettverk_og_datakommunikasjon.pdf]]"
created: 2026-03-28
reviewed: 2026-03-28
figures: [figure-01-tcp-header.png]
---

## Summary
...structured study notes...

## Figures
![[figure-01-tcp-header.png]]
**TCP Header Structure** — Shows the 32-bit header layout...
```

## What This Changes

### Modified files
- `src/ingestion/index.ts` — replace docling-first pipeline with agent-first processing; docling becomes an optional tool
- `src/ingestion/file-watcher.ts` — already fixed: ignore `.processed/` subfolder
- `src/index.ts` — register web channel, start review agent group
- `src/config.ts` — web channel config (port, etc.)

### New files
- `src/channels/web.ts` — web channel implementation (HTTP + SSE)
- `dashboard/src/app/review/[id]/page.tsx` — redesigned three-panel detail view (replaces current)
- `dashboard/src/app/review/page.tsx` — redesigned overview with grouping and batch actions (replaces current)
- `dashboard/src/app/api/chat/route.ts` — chat endpoint (forwards to NanoClaw web channel)
- `dashboard/src/app/api/chat/[draftId]/stream/route.ts` — SSE endpoint for streaming agent responses
- `groups/review_agent/CLAUDE.md` — review agent instructions

### Repurposed files
- `src/ingestion/docling-client.ts` — remains as-is but is no longer called by the pipeline directly; exposed as a tool the agent can invoke for figure extraction

### Not in scope
- Rich text editing of draft content (markdown source editing is sufficient for now)
- Real-time notifications when new drafts arrive (manual refresh is fine)
- Multiple simultaneous reviewers (single-user system)
- The other follow-up sessions (deep review/hallucination detection, study plans, collaboration platform, deployment)
