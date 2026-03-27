# universityClaw — Design Spec

Personal university teaching assistant built as a NanoClaw fork. Connects to Telegram, uses an Obsidian vault as primary knowledge store, and provides RAG-powered academic support for a Digital Transformation degree program.

## Goals

- Process and organize course materials (PDFs, slides, compendiums, notes) in Norwegian and English
- Provide grounded Q&A, quizzing, summarization, and writing assistance via Telegram
- Track learning progress and maintain a persistent student profile
- Semi-automatic document ingestion with human review before notes enter the vault
- Simple web dashboard for uploads, review queue, and vault browsing

## Non-Goals (Follow-Up Sessions)

1. **Personalized revision/teaching plan** — Auto-generated study plans with summaries, Q&A, quizzes based on current relevance (upcoming exams, weak areas, course progression). Needs its own design cycle for scheduling, spaced repetition, and adaptive difficulty.
2. **Deep review workflow** — Hallucination detection, confidence scoring, side-by-side source verification. The initial dashboard has basic approve/reject/edit; rigorous accuracy verification is a separate problem.
3. **Full collaboration platform** — Expanding the web dashboard into an interactive study environment with knowledge graph visualization and richer document management.
4. **Mac Mini deployment** — Self-hosting, remote access, security hardening, Docker-based service management.

---

## Architecture

Three layers: Input, Knowledge, and Agent.

```
┌─────────────────────────────────────────────────────────┐
│                     INPUT LAYER                         │
│                                                         │
│  Upload Folder ──┐     ┌── Web Dashboard                │
│  (file watcher)  ├─────┤   (upload, review, browse)     │
│                  │     │                                │
│                  ▼     ▼                                │
│          Document Ingestion Pipeline                    │
│          (Docling → Claude → Review Queue)              │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                   KNOWLEDGE LAYER                       │
│                                                         │
│  Obsidian Vault (primary knowledge store)               │
│  ├── courses/{course-code}/                             │
│  ├── resources/                                         │
│  ├── drafts/ (review queue)                             │
│  ├── attachments/ (original files)                      │
│  └── profile/ (student memory)                          │
│                                                         │
│  LightRAG Index                                         │
│  (vector embeddings + knowledge graph)                  │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                    AGENT LAYER                          │
│                                                         │
│  NanoClaw (Claude Agent SDK)                            │
│  ├── Vault Utility (read/write markdown)                │
│  ├── RAG Client (hybrid retrieval)                      │
│  └── Student Profile (progress tracking)                │
│                          │                              │
│                     Telegram                            │
└─────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. Document Ingestion Pipeline

Converts uploaded files into structured, reviewable Obsidian notes.

**Step 1 — File Detection**
- `chokidar` watches the upload folder for new files
- Supported formats: PDF, PPTX, DOCX, images (OCR), plain text, Markdown
- Files can also arrive via the web dashboard upload endpoint
- On detection, original file is copied to `vault/attachments/{course-code}/`

**Step 2 — Context Extraction from Folder Path**
- The upload folder mirrors Simon's existing iCloud folder structure:
  ```
  01 - Digital Forretningsutvikling/
    6. Semester/
      BI 2081 - Natur, miljø og bærekraft/
        Forelesninger/
        Pensum/
        Eksamenslesning/
        Tasks/
  ```
- A path parser extracts metadata from folder names:
  - Semester number: `/(\d+)\. Semester/` → `semester: 6`, `year: 3`
  - Course code and name: `/([A-Z]{2,4} \d{4}) - (.+)/` → `course: BI-2081`, `course_name: ...`
  - Material type: folder name mapped to generalized categories

**Generalized type categories** (matched via keyword/regex, with Claude as fallback):

| Type | Common folder names |
|---|---|
| `lecture` | Forelesninger, Lectures, Slides, Presentasjoner |
| `reading` | Pensum, Litteratur, Readings, Artikler |
| `exam-prep` | Eksamenslesning, Eksamen, Exam, Tidligere eksamener |
| `assignment` | Tasks, Oppgaver, Innleveringer, Øvinger |
| `compendium` | Kompendium, Summary, Sammendrag |
| `project` | Prosjekt, Project, Bacheloroppgave |
| `reference` | Ressurser, Resources, Vedlegg |

- When a folder name doesn't match any known pattern, Claude classifies it by name + sample content
- When Claude is uncertain, it asks the user via Telegram (batched for bulk imports)
- New folder-name-to-type mappings are saved to config so the same question isn't asked twice

**Step 3 — Text & Figure Extraction (Docling)**
- Docling converts documents to structured Markdown
- Preserves headings, tables, lists
- Handles Norwegian and English content
- OCR for images and scanned documents
- **Figure extraction:** Docling saves each figure/image as a separate PNG/JPG file to `vault/attachments/{course-code}/figures/{source-filename}/`. Figures are named descriptively when possible (e.g., `figure-03-digital-twin-architecture.png`), falling back to sequential numbering.

**Step 4 — Note Generation (Claude, multimodal)**
- Takes extracted Markdown + extracted figures (as multimodal input) + path-derived context
- Splits into atomic notes (one concept per note)
- Generates YAML frontmatter (see Note Schema below)
- Suggests wikilinks to existing vault notes by scanning current contents
- Suggests tags from an evolving taxonomy
- **For each figure:** embeds it in the note using Obsidian image syntax (`![[figure-name.png]]`) and generates a text description/analysis below it. This description makes figures searchable via RAG and provides context when the image can't be rendered.
- Figures that Claude deems decorative or low-information (e.g., generic stock photos, logos) are flagged but still included — the user decides during review whether to keep them.

**Step 5 — Review Queue**
- Draft notes land in `vault/drafts/` with `status: draft`
- Web dashboard shows drafts with suggested links/tags and a link to the original source
- **Figures render inline** in the review dashboard alongside Claude's descriptions
- User can **approve, edit, or reject** each draft note
- User can **remove individual figures** from a note during review (removes the embed + description from the note and optionally deletes the image file)
- On approval: note moves to appropriate course folder, status flips to `approved`, RAG index updates
- After processing, original file is moved out of the upload folder into `vault/attachments/`
- **Post-approval figure management:** Figures can also be removed from approved notes later via the vault browser in the web dashboard

**Bulk Import**
- Supports pointing at a root folder (e.g., `01 - Digital Forretningsutvikling/`) and recursively processing all files
- Batches classification questions via Telegram rather than interrupting per-file
- Preserves original folder structure within `vault/attachments/` for reference

### 2. Note Schema (YAML Frontmatter)

Every note in the vault uses this frontmatter structure:

```yaml
---
title: Digital Twin Strategy in Manufacturing
type: lecture                # lecture | reading | exam-prep | assignment | compendium | project | reference | personal | external
course: BI-2081
course_name: Natur, miljø og bærekraft
semester: 6
year: 3
week: 12                     # lecture week (when applicable)
lecturer: Dr. Hansen         # when known
source: lecture-slides-w12.pdf
language: nb                 # nb = Norwegian Bokmål, en = English
status: approved             # draft | approved
tags:
  - digital-twins
  - industry-4-0
figures:                     # extracted figures attached to this note
  - figure-03-digital-twin-architecture.png
  - figure-04-implementation-timeline.png
related:
  - "[[IoT in Manufacturing]]"
  - "[[Change Management Frameworks]]"
created: 2026-03-27
---
```

**Course index notes** (`type: course-index`) serve as landing pages per course:

```yaml
---
title: BI 2081 Natur, miljø og bærekraft
type: course-index
semester: 6
year: 3
ects: 10
status: active               # active | completed
exam_date: 2026-06-15
lecturer: Dr. Hansen
---
```

### 3. Obsidian Vault Structure

```
vault/
├── courses/
│   ├── BI-2081/              # one folder per course
│   │   ├── _index.md         # course index note
│   │   ├── lectures/
│   │   ├── readings/
│   │   └── exam-prep/
│   ├── DIFT-2900/
│   └── ...
├── resources/
│   ├── books/
│   ├── articles/
│   └── external/             # non-course material
├── drafts/                   # review queue
├── attachments/              # original uploaded files
│   ├── BI-2081/
│   └── ...
└── profile/
    ├── student-profile.md    # courses, program info, preferences
    ├── study-log.md          # auto-updated activity log
    └── knowledge-map.md      # topics with confidence levels
```

**Vault manipulation** is done via direct file I/O — no MCP, no running Obsidian instance required:
- `gray-matter` for YAML frontmatter read/write
- Regex for wikilink parsing: `/\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g`
- `node:fs/promises` for file operations
- Thin `VaultUtility` class (~200 lines) wrapping these with methods: `createNote()`, `readNote()`, `searchNotes()`, `getBacklinks()`, `updateFrontmatter()`, `moveNote()`

### 4. RAG Layer (LightRAG)

Indexes the Obsidian vault for hybrid retrieval.

- **Vector embeddings** for semantic similarity search
- **Knowledge graph** built from wikilinks and content relationships
- **Keyword search** (BM25) for exact term matching
- **Incremental indexing** — updates when vault changes, doesn't re-index everything
- **Query modes:**
  - Specific: "What are digital twins?" → vector similarity
  - Thematic: "What themes connect my digital strategy and change management courses?" → graph traversal
  - Filtered: "What did BI-2081 cover about sustainability?" → metadata filter + vector search

### 5. Agent Capabilities

The NanoClaw agent exposes these capabilities via Telegram:

| Capability | Description |
|---|---|
| **Q&A** | Answer questions grounded in vault content, with source references |
| **Quiz** | Generate questions from specified material, track right/wrong |
| **Summarize** | Structured summaries of lectures, chapters, courses |
| **Writing help** | Structure essays, review drafts, suggest improvements |
| **Study planning** | Suggest focus areas based on weak spots and upcoming exams |

**Language behavior:** Mirrors the user's language. Norwegian input gets Norwegian output, English gets English. Can translate between the two when source material differs from working language.

**Source attribution:** Every answer includes references to specific vault notes used, so the user can verify.

**Asking for clarification:** During document ingestion, the agent asks classification questions via Telegram when uncertain about folder types or document categorization. Batches questions for bulk imports.

### 6. Student Profile

Stored as Markdown in `vault/profile/`, updated automatically:

- **student-profile.md** — Active/completed courses, program info, study preferences
- **study-log.md** — What was studied, when, and how (Q&A, quiz, reading). Auto-appended after each interaction.
- **knowledge-map.md** — Topics with confidence levels. Updated after quizzes (right/wrong) and Q&A patterns (frequent questions on a topic suggest lower confidence).

### 7. Web Dashboard

Lightweight Next.js app served locally alongside NanoClaw.

**Views:**

| View | Purpose |
|---|---|
| **Upload** | Drag-and-drop files or specify folder for bulk import. Shows processing progress. |
| **Review Queue** | Draft notes pending approval. View generated note alongside link to original source. Approve, edit, reject. |
| **Vault Browser** | Browse vault by course/semester/type. Read-only (editing happens in Obsidian). |
| **Status** | Pipeline health, processing queue, RAG index stats, recent activity. |

**Tech:** Next.js (TypeScript), SQLite for dashboard state (shared with NanoClaw's existing DB). No authentication initially (local-only access). Auth added when deploying to Mac Mini.

---

## Tech Stack

| Component | Technology | Rationale |
|---|---|---|
| Core platform | NanoClaw fork (TypeScript, Node.js 20+) | Lightweight, Claude Agent SDK, container isolation |
| AI backbone | Claude via Agent SDK (Max subscription) | No API key needed, existing subscription |
| Messaging | Telegram | Simple bot API, cross-device |
| Knowledge store | Obsidian vault (direct file I/O) | Just Markdown, no runtime dependency |
| Vault manipulation | `gray-matter` + regex + `fs/promises` | Zero context window overhead, ~200 lines |
| Document conversion | Docling (Python) | Best-in-class PDF/PPTX/DOCX extraction |
| RAG index | LightRAG | Hybrid vector + graph, lightweight, incremental |
| File watching | chokidar | Standard Node.js file watcher |
| Web dashboard | Next.js (TypeScript) | Same language ecosystem, good DX |
| Database | SQLite (`better-sqlite3`) | Already used by NanoClaw |
| Containerization | Docker | Agent sandboxing, future Mac Mini deployment |

**Note on Docling:** It's Python-based, the only Python dependency. Runs as a subprocess or lightweight microservice alongside the Node.js stack.

---

## Key Design Decisions

1. **Obsidian vault as single source of truth** — Not just a note-taking tool, but the primary knowledge store that RAG indexes. Raw documents are processed into structured, linked Markdown notes.

2. **Direct file manipulation over MCP** — An Obsidian vault is just a folder of Markdown files. Direct I/O avoids MCP tool definition overhead in the LLM context window and removes the dependency on a running Obsidian instance.

3. **Semi-automatic ingestion with review** — Claude generates draft notes, but nothing enters the main vault without user approval. The pipeline learns from approvals to improve classification over time.

4. **Path-based context extraction** — Leverages the existing folder structure (semester/course/type) to auto-populate note metadata, minimizing manual tagging.

5. **Hybrid retrieval (vector + graph + keyword)** — Handles both specific lookups ("what is X?") and thematic queries ("how do these courses connect?") using LightRAG's combined approach.

6. **Claude Max subscription** — NanoClaw uses the Claude Agent SDK which supports Max plan billing via OAuth. No separate API key required.

7. **Docker for containerization** — Standard container isolation for agent sandboxing. Same setup will be used for Mac Mini deployment later.
