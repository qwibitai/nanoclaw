# Shoggoth: Architecture Document

**A research domain layer on top of NanoClaw**

Version 1.0 — March 19, 2026

---

## What This Is

Shoggoth is a domain layer that turns NanoClaw — an open-source personal AI assistant — into research infrastructure for a computational social scientist.

NanoClaw provides the operating system: container-isolated agent execution, WhatsApp integration, scheduled tasks, agent swarms, SQLite persistence, and a single-process Node.js orchestrator small enough to read in an afternoon.

Shoggoth provides the domain specialization: research-aware skills, a persistent researcher identity, a semantic literature index, academic API integrations, and Obsidian vault conventions that make the vault a shared workspace between human and machine.

The division is clean. NanoClaw is someone else's maintained infrastructure. Shoggoth is your research workflow encoded as agent capabilities. Most of Shoggoth is not code — it's markdown files, configuration, and one real piece of software (the content registry).

---

## Design Philosophy

### Lab, Not Factory

Research produces knowledge that is *true*, not artifacts that *work*. Shoggoth is a lab instrument — fully understood by the researcher who operates it, with legible, auditable outputs. Every agent output is a markdown file the researcher can read, edit, or delete.

### Orchestration Over Execution

The researcher's durable advantage is domain expertise, critical evaluation, and asking the right questions. Shoggoth handles execution — literature search, briefing compilation, idea capture — so the researcher can focus on judgment.

### One Agent, Many Skills

There is no complex routing system. A single well-informed generalist agent receives all messages and decides which skills to apply. It captures ideas by default, answers questions from vault context, and asks before escalating to expensive operations (swarms, Opus reasoning). The agent uses judgment, not a classifier.

### Files as Memory, Database as Index

Human-readable knowledge lives in Obsidian markdown files. Both the researcher and agents read and write these files. Postgres+pgvector handles what files cannot: semantic search over thousands of literature entries. SQLite (NanoClaw's built-in) handles operational state.

---

## System Topology

```
┌──────────────────────────────────────────────────────────────┐
│                   RESEARCHER'S MACHINE (Mac)                  │
│                                                               │
│  Obsidian Vault ←── iCloud / Syncthing ──→ VPS               │
│    ├── _meta/              researcher identity + context       │
│    ├── Briefings/           agent-written, researcher reads    │
│    ├── Projects/            shared workspace                   │
│    ├── Ideas/               idea capture + investigations      │
│    ├── Literature/          reading lists + paper notes         │
│    ├── Tasks/               task tracking                      │
│    ├── Career/              job/grant/CFP alerts               │
│    └── ...                                                     │
│                                                               │
│  Claudian (Obsidian sidebar)                                   │
│    → Claude Code with vault as working directory               │
│    → Interactive research sessions                             │
│                                                               │
│  Emacs / Claude Code CLI (unchanged workflows)                 │
│                                                               │
└──────────────────────────────────────────────────────────────┘
                │
                │ Vault sync
                ▼
┌──────────────────────────────────────────────────────────────┐
│                    HETZNER VPS (Linux)                         │
│                                                               │
│  NanoClaw (unmodified or lightly configured)                   │
│    ├── WhatsApp via Baileys                                    │
│    ├── Scheduled task runner                                   │
│    ├── Docker container runner                                 │
│    ├── Agent swarm support                                     │
│    ├── SQLite (messages, sessions, tasks)                      │
│    └── Per-group CLAUDE.md personas + skills                   │
│                                                               │
│  Shoggoth Domain Layer                                         │
│    ├── .claude/skills/         research workflow skills         │
│    ├── _meta/                  researcher context (from vault)  │
│    ├── MCP-Vault               structured vault access          │
│    └── Content Registry        Postgres+pgvector literature     │
│         └── API tools          Semantic Scholar, OpenAlex,      │
│                                Zotero .bib integration          │
│                                                               │
│  Containers (Docker, ephemeral, dispatched by NanoClaw)        │
│    → Swarm investigations, writing tasks, web research          │
│    → MCP-Vault available inside containers                     │
│    → Content registry tools available inside containers         │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## The Shoggoth Domain Layer

Five components. One is code. The rest are content.

### 1. Skills (markdown files)

Skills tell the agent how to perform domain-specific tasks. They are templates, not rigid instructions — the agent applies judgment about whether and when to use them. Skills live in `.claude/skills/` in the NanoClaw installation directory.

Full skill files are maintained separately. Summary of each:

**Idea Capture** — When the researcher shares a substantive thought, capture it as a lightweight note in Ideas/ (title + 2-4 sentences + optional project links, no boilerplate frontmatter). After capturing, offer to escalate to a research investigation. Never escalate without confirmation.

**Daily Briefing** — Scheduled weekday mornings. Read `_meta/` and all project `PROJECT.md` files. Write a briefing to Briefings/ with urgent items, active project status, recent captures, and a suggested focus. Be specific, not vague.

**Research Investigation (Swarm)** — On explicit confirmation only. Spawn sub-agents for literature search, conceptual framing, and methodology. Synthesize into a single Ideas/ note with literature landscape, theoretical framing, possible approaches, and next steps.

**Literature Monitoring** — Scheduled weekly. Search Semantic Scholar and OpenAlex for recent papers matching researcher interests. Index in the content registry. Write a tiered reading list (Must-Read / Should-Read / Skim) to Literature/.

**Project Status** — When asked about a specific project. Read the project's `PROJECT.md`, search vault for recent mentions, summarize. Update the Status section of `PROJECT.md` if the researcher provides new information (append, never overwrite).

### 2. Researcher Context (`_meta/`)

Three markdown files giving agents persistent memory of who the researcher is:

- `researcher-profile.md` — Stable identity: interests, affiliation, methods, working style, career stage
- `top-of-mind.md` — Current priorities, updated frequently
- `preferences.md` — Communication style, formatting, accumulated corrections

Per-project context lives in `Projects/<n>/PROJECT.md` (single file per project — see Vault Structure below). Agents read `_meta/` but never overwrite it.

### 3. MCP-Vault (installed package)

Structured Obsidian vault access. Provides `read_note`, `write_note`, `patch_note`, `search_notes`, `update_frontmatter`, `manage_tags`. Replaces raw Read/Write for vault operations with safe frontmatter handling, BM25 search, and path sandboxing.

Install: `npm install mcpvault` plus `npx skills add bitbonsai/mcpvault`

### 4. Content Registry (~550 lines of TypeScript)

Postgres+pgvector service for semantically searchable academic literature. The one component that justifies writing real code.

```
Semantic Scholar API ─┐
OpenAlex API ─────────┤──→ Normalize ──→ Embed ──→ Postgres+pgvector
Zotero .bib export ───┘
                                │
Agent query ──→ Vector search ──┘──→ Catalog (title, authors, summary)
                                     └──→ Expand (full details) on request
```

**Tools exposed to agents:**
- `search_literature(query, sources?, limit?)` — search APIs, return results
- `index_papers(papers[])` — embed and store
- `search_registry(query, limit?)` — vector search over indexed papers
- `expand_paper(id)` — full details for a specific paper
- `import_zotero(bibpath)` — parse .bib, index new entries

### 5. Scheduled Tasks (configuration)

```
morning-briefing:  "0 6 * * 1-5"  Europe/Zurich   Daily Briefing skill
weekly-literature: "0 7 * * 1"    Europe/Zurich   Literature Monitoring skill
career-monitor:    "0 8 * * 1"    Europe/Zurich   Search jobs, grants, CFPs
```

---

## Vault Structure

```
vault/
├── _meta/
│   ├── researcher-profile.md
│   ├── top-of-mind.md
│   └── preferences.md
├── briefings/
├── projects/
│   ├── <project>/
│   │   ├── PROJECT.md          ← single source of truth
│   │   └── (working docs)      ← optional, ad-hoc
│   └── _registry.md
├── ideas/
├── literature/
│   ├── Weekly-YYYY-WNN.md
│   ├── Queue.md
│   └── Notes/
├── tasks/
├── career/
└── archive/
```

**Conventions:** Agent-written files in dedicated directories. Shared workspaces (projects/, ideas/) for both human and agent. `_meta/` is researcher-written only. Idea notes are minimal. The filesystem provides dates and status — don't duplicate in frontmatter.

### Project file structure (flat, single-file)

Each project has one authoritative file: `PROJECT.md`. This replaces the previous multi-file layout (STATUS.md, CONTEXT.md, decision-log.md, project-overview.md). The goal is to reduce cognitive load — when you open a project folder, there's one file to read, not four.

**PROJECT.md template:**

```markdown
---
phase: <current phase>
priority: <high | medium | low>
last_updated: <YYYY-MM-DD>
---

# <Project Name>

<1-3 sentence description of what the project is and why it matters.>

## Status

<Current focus, blockers, next steps. This is the section the agent reads
for briefings and updates when the researcher provides new information.
Keep it current — this is the fast-changing part of the file.>

## Context

<Collaborators, technical stack, key repos/files, important links.
Stable reference information. Changes rarely.>

## Key Decisions

<Lightweight decision log, newest first. Only log decisions that
actually matter — not every small choice. Agent appends new entries
at the top when decisions are made in conversation.>
```

Additional working documents (analysis notes, draft outlines, etc.) can live alongside PROJECT.md in the project folder. The agent treats PROJECT.md as the canonical source; everything else is supplementary.

**Agent behavior with PROJECT.md:**
- Daily briefing reads the Status section of every project's PROJECT.md
- When the researcher provides status updates, the agent updates the Status section (append, never overwrite the whole file)
- Key Decisions entries are appended at the top of that section
- The agent never touches the Context section unless the researcher explicitly asks

---

## Routes to Complex Systems (Future)

NanoClaw's container system dispatches to anything in Docker:

- **APE-style research loops** (cf. Social Catalyst Lab): Full autonomous research pipelines
- **HPC job management:** SSH into SLURM clusters, submit jobs, report results
- **Experimental platform simulations:** Study environments managed by agents
- **Code orchestration:** Claude Code sessions for analysis code

Not part of the initial build. Possible once the foundation is running.

---

## Technology Stack

| Component | Technology | Notes |
|---|---|---|
| Agent OS | NanoClaw | Containers, WhatsApp, scheduler, swarms |
| Agent runtime | Claude Agent SDK (via NanoClaw) | Inside containers |
| Models | Opus 4.6 / Sonnet / Haiku | Anthropic API, tiered by task |
| Vault access | MCP-Vault | Structured note ops, search, frontmatter |
| Vault sync | Syncthing or iCloud | Bidirectional |
| Content registry | Postgres 16 + pgvector | ~550 lines TypeScript |
| Embeddings | OpenAI text-embedding-3-small | For pgvector |
| Literature APIs | Semantic Scholar, OpenAlex | Open, complementary |
| Citations | Zotero + Better BibTeX | .bib as registry input |
| Obsidian chat | Claudian or Agent Client | Claude Code in sidebar |

---

## Open Questions

- **WhatsApp groups:** Separate groups per context. NanoClaw supports this natively.
- **Project repo mounts:** Containers need code repo access beyond the vault.
- **Voice input:** How whisper.cpp output reaches the vault or WhatsApp.
- **Memory evolution:** `_meta/` is forward-compatible with emerging patterns.
