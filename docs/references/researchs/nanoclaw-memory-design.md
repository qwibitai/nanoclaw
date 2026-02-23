# NanoClaw Memory System — Complete Design Document

> A production-ready, multi-layered memory architecture for persistent AI agents.
> Synthesized from OpenClaw's native memory layer and the openclaw-memory-architecture's 12-layer cognitive system.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Architecture Overview](#2-architecture-overview)
3. [Memory Layers (1–12)](#3-memory-layers)
4. [Knowledge Graph (Layer 4)](#4-knowledge-graph)
5. [Search Pipeline](#5-search-pipeline)
6. [Embedding Infrastructure](#6-embedding-infrastructure)
7. [Runtime Plugins (Layers 10–12)](#7-runtime-plugins)
8. [Information Flow & Lifecycle](#8-information-flow--lifecycle)
9. [Database Schema](#9-database-schema)
10. [MCP Server Integration](#10-mcp-server-integration)
11. [Configuration Reference](#11-configuration-reference)
12. [Implementation Roadmap](#12-implementation-roadmap)
13. [Appendix: Comparison of Approaches](#appendix-comparison-of-approaches)

---

## 1. Design Philosophy

### Core Insight

No single memory technology handles all recall patterns. Vector search excels at fuzzy recall but fails on entity lookups. BM25 keyword search is fast but misses relationships. Structured databases are instant for known keys but can't handle open-ended queries. **NanoClaw uses each tool where it's strongest.**

### Principles

| Principle | Rationale |
|-----------|-----------|
| **Markdown-first source of truth** | Human-readable, version-controllable, debuggable. You can `cat MEMORY.md` and see exactly what the agent knows. |
| **Hybrid search over single-method** | Graph + BM25 + vector = 100% benchmark recall vs. 46.7% BM25-only. |
| **Upward consolidation** | Raw observations (daily logs) → working memory (active-context) → curated wisdom (MEMORY.md) → structured facts (facts.db). Mirrors how human episodic memory distills into semantic memory. |
| **Temporal decay on ephemeral, permanence on curated** | Daily logs decay (relevance halves every 30 days). MEMORY.md and facts.db are evergreen. |
| **Privacy-scoping** | Sensitive memory (MEMORY.md) loads only in private sessions. Group/shared contexts get filtered views. |
| **Low cost for recall** | Graph lookups and BM25 are free (local SQLite). Embedding calls use Azure OpenAI — extremely cheap per query. Only the LLM inference call is the major cost. |
| **Graceful degradation** | Every layer has fallbacks. If Azure OpenAI is down, BM25 still works. If facts.db is missing, semantic search still works. The agent never fails silently on memory. |

### What Each Layer Answers

| Question Type | Best Layer | Example |
|--------------|-----------|---------|
| "What's my daughter's birthday?" | Layer 4: Knowledge Graph | `facts.db WHERE entity='Daughter' AND key='birthday'` |
| "What were we discussing about infrastructure?" | Layer 5: Semantic Search | BM25 + vector similarity over daily logs |
| "What did we decide about the database migration?" | Layer 2: MEMORY.md | Curated decision record |
| "What's the port for Keystone?" | Layer 4: Knowledge Graph | `facts.db WHERE entity='Keystone' AND key='port'` |
| "How did last week's deployment go?" | Layer 10: Continuity Plugin | Cross-session archive search |
| "Have I corrected the agent about this before?" | Layer 12+: Growth Vectors | Behavioral lesson lookup |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SESSION CONTEXT                              │
│                   (conversation + tool outputs)                       │
│                     ~200K token window                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   TIER A: ALWAYS-LOADED CONTEXT (injected at session boot)          │
│   ┌─────────────┐ ┌────────────┐ ┌──────────┐ ┌──────────────────┐ │
│   │  SOUL.md    │ │  USER.md   │ │IDENTITY  │ │ active-context   │ │
│   │  Persona,   │ │  Who your  │ │.md       │ │ .md              │ │
│   │  voice,     │ │  human is, │ │ Name,    │ │ Working memory:  │ │
│   │  values,    │ │  family,   │ │ emoji,   │ │ what's hot       │ │
│   │  principles │ │  projects  │ │ vibe     │ │ RIGHT NOW        │ │
│   └─────────────┘ └────────────┘ └──────────┘ └──────────────────┘ │
│                                                                      │
│   TIER B: STRATEGIC MEMORY (loaded selectively)                     │
│   ┌───────────────────────┐ ┌──────────────────────────────────┐   │
│   │  MEMORY.md            │ │  project-{slug}.md               │   │
│   │  Curated long-term    │ │  Cross-agent institutional       │   │
│   │  wisdom (<200 lines)  │ │  knowledge per project           │   │
│   │  Private sessions     │ │  Architecture decisions, lessons │   │
│   │  only                 │ │  conventions, known risks        │   │
│   └───────────────────────┘ └──────────────────────────────────┘   │
│                                                                      │
│   TIER C: STRUCTURED STORAGE & SEARCH                               │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │              KNOWLEDGE GRAPH (SQLite + FTS5)                  │  │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │  │
│   │  │  facts   │ │relations │ │ aliases  │ │ co_occurrences │  │  │
│   │  │  3K+     │ │ 1K+     │ │  275+    │ │  weighted edges│  │  │
│   │  │  entries │ │ triples │ │  mappings│ │  Hebbian learn │  │  │
│   │  └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │  │
│   │  Activation scoring (Hot/Warm/Cool) + daily decay            │  │
│   │  4-phase search: entity+intent → entity → FTS → relations   │  │
│   └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │              SEMANTIC SEARCH                                  │  │
│   │  Primary: BM25 + LLM reranking (best quality, ~4s)          │  │
│   │  Fallback: Azure OpenAI embeddings (3072d, ~150ms)          │  │
│   │  Indexing: 70% vector + 30% BM25, union-merged               │  │
│   │  Chunking: 400 tokens, 80-token overlap, SHA-256 dedup      │  │
│   └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│   TIER D: DAILY LOGS & PROCEDURAL MEMORY                           │
│   ┌──────────────┐ ┌──────────────┐ ┌───────────────────────────┐  │
│   │ YYYY-MM-DD   │ │ tools-*.md   │ │ gating-policies.md        │  │
│   │ .md          │ │ Runbooks,    │ │ Failure prevention rules  │  │
│   │ Raw session  │ │ how-tos,     │ │ "Never do X because Y"   │  │
│   │ logs with    │ │ credentials  │ │ Learned from mistakes     │  │
│   │ importance   │ │              │ │                           │  │
│   │ tags         │ │              │ │                           │  │
│   └──────────────┘ └──────────────┘ └───────────────────────────┘  │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│              RUNTIME PLUGIN LAYERS (active during inference)         │
├─────────────────────────────────────────────────────────────────────┤
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │  GRAPH-MEMORY PLUGIN (priority 5)                            │  │
│   │  Hook: before_agent_start                                     │  │
│   │  Entity extraction → facts.db lookup → [GRAPH MEMORY] inject │  │
│   │  Activation bump + co-occurrence wiring on retrieval          │  │
│   └──────────────────────────────────────────────────────────────┘  │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │  CONTINUITY PLUGIN (priority 10)                             │  │
│   │  Hook: before_agent_start                                     │  │
│   │  Cross-session search (Azure OpenAI) → [CONTINUITY CONTEXT]  │  │
│   │  Topic tracking + continuity anchors                         │  │
│   └──────────────────────────────────────────────────────────────┘  │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │  STABILITY PLUGIN (priority 15)                              │  │
│   │  Hook: before_agent_start                                     │  │
│   │  Entropy monitoring → [STABILITY CONTEXT] inject             │  │
│   │  Loop detection + confabulation guards                       │  │
│   └──────────────────────────────────────────────────────────────┘  │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │  GROWTH VECTORS PLUGIN (priority 20) [future]               │  │
│   │  Hook: before_agent_start                                     │  │
│   │  Behavioral lesson matching → [GROWTH VECTORS] inject        │  │
│   │  Correction detection + effectiveness tracking               │  │
│   └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer Summary

| Layer | System | What It Stores | Query Latency | Storage |
|-------|--------|---------------|---------------|---------|
| 1 | Always-loaded files | Identity, persona, working memory | 0ms (in context) | Markdown files |
| 2 | MEMORY.md | Curated long-term wisdom | 0ms (in context) | Single markdown file |
| 3 | project-{slug}.md | Per-project institutional knowledge | 0ms (in context) | Markdown per project |
| 4 | facts.db | Entity/key/value + relations + aliases | <1ms | SQLite + FTS5 |
| 5 | Semantic search | Fuzzy recall across all memory files | ~150ms Azure / 4s reranked | SQLite-vec / BM25 |
| 5a | Domain RAG | Domain-specific knowledge corpus | ~100ms | SQLite + embeddings |
| 6 | Daily logs | Raw session history with importance tags | On demand | Markdown per day |
| 7 | Runbooks | Procedural knowledge (how-to guides) | On demand | Markdown files |
| 8 | Gating policies | Failure prevention rules | On demand | Single markdown file |
| 9 | Checkpoints | Pre-flight state saves | On demand | Directory of snapshots |
| 10 | Continuity plugin | Cross-session conversation archive | ~150ms | SQLite + sqlite-vec (Azure OpenAI) |
| 11 | Stability plugin | Behavioral drift detection | ~0ms (computed) | In-memory |
| 12 | Graph-memory plugin | Automatic entity injection | ~500ms | Subprocess + SQLite |

---

## 3. Memory Layers

### Layer 1: Always-Loaded Context

These files load at the start of **every** session, injected into the LLM context window before any user message.

| File | Purpose | Size Target | Update Frequency |
|------|---------|-------------|-----------------|
| `SOUL.md` | Agent personality, voice, values, behavioral principles | <2KB | Rarely (curated) |
| `USER.md` | Human identity — name, family, preferences, timezone | <3KB | When new info learned |
| `IDENTITY.md` | Agent name, emoji, vibe (created during bootstrap) | <0.5KB | Rarely |
| `active-context.md` | Working memory — current focus, hot topics, recent decisions | <2KB | End of every significant session |
| `HEARTBEAT.md` | Periodic maintenance checklist | <1KB | As needed |

**Token budget:** ~2,000 tokens total. Keep files lean — every byte here costs on every turn.

**Loading rules:**
- Hard limit: 20,000 characters per file, 150,000 characters total
- Missing files produce a marker warning, not a crash
- `active-context.md` updates at session close capture "what's hot now" for next boot

**Example `active-context.md`:**
```markdown
# Active Context

## Current Focus
- Migrating payment API from REST to GraphQL
- Deadline: March 15

## Recent Decisions
- Using Apollo Server (not Yoga) — better error handling
- Keeping REST endpoints alive for 6 months (deprecation period)

## Open Questions
- How to handle webhook subscriptions during migration?
- Need to benchmark GraphQL N+1 query performance
```

### Layer 2: Strategic Memory (MEMORY.md)

The curated, actively-maintained knowledge store. **This is the agent's institutional memory.**

**Rules:**
- **Private sessions only** — never loaded in group/shared contexts (privacy protection)
- **Actively pruned** — keep under ~200 lines; stale info gets removed
- **Consolidation target** — important daily observations get promoted here
- **Evergreen in search** — never subject to temporal decay

**Structure:**
```markdown
# Long-Term Memory

## About [User]
- Communication preferences
- Key decisions and reasoning
- Project involvement

## Active Projects
- Architecture summaries (distilled, not raw)
- Stack decisions and why

## Decisions & Lessons
- Important choices with rationale
- Hard-won lessons (what NOT to do)

## Preferences
- Tooling choices
- Workflow patterns
- Style preferences
```

### Layer 3: Project Memory

**`memory/project-{slug}.md`** — Institutional knowledge per project that survives agent resets.

**What belongs here:**
- Architecture decisions (with reasoning)
- Lessons learned the hard way
- Conventions that emerged during development
- Known risks and active concerns

**What does NOT belong here:**
- Current sprint state, task lists (that's the task tracker)
- Raw daily logs (that's Layer 6)
- Personal context (that's MEMORY.md)

### Layer 4: Knowledge Graph

See [Section 4: Knowledge Graph](#4-knowledge-graph) for full details.

### Layer 5: Semantic Search

**Two-tier search with automatic fallback:**

| Tier | Method | Latency | Quality | Use Case |
|------|--------|---------|---------|----------|
| Primary | BM25 + LLM reranking | ~4s | Best | Default for open-ended queries |
| Fallback | Azure OpenAI embeddings (1536d/3072d) | ~100-200ms | Very good | When reranker unavailable or as default embedding backend |

**Hybrid indexing (default weights):**
- 70% vector similarity (cosine distance)
- 30% BM25 keyword matching (FTS5)
- Results are union-merged: a chunk scoring high on vectors but zero on keywords still appears

**Chunking parameters:**
- Chunk size: ~400 tokens
- Overlap: 80 tokens between consecutive chunks
- Algorithm: line-aware, preserves line numbers for source attribution
- Deduplication: SHA-256 hash per chunk, skip re-embedding identical content
- File watcher: 1.5-second debounce triggers re-indexing on changes

**Post-processing pipeline:**
1. Union-merge vector + BM25 results
2. Apply temporal decay (daily logs only; MEMORY.md and non-dated files exempt)
3. Optional MMR re-ranking (reduces redundant near-duplicate snippets)

### Layer 5a: Domain RAG (Optional)

For domain-specific knowledge that the agent needs to reference but shouldn't memorize in full:

- Technical documentation corpora
- Specialized reference materials
- Book/paper collections

**Implementation:** Chunk documents, embed with same model as Layer 5, store in dedicated SQLite database. Weekly cron reindex.

### Layer 6: Daily Logs

**`memory/YYYY-MM-DD.md`** — Append-only session history.

**Loading at boot:** Today's + yesterday's files are injected. Older files remain indexed for search but aren't in the context window.

**Importance tagging:**
```markdown
- [decision|i=0.9] Switched to nomic-embed-text-v2-moe for all embeddings
- [milestone|i=0.85] Payment API migration reached alpha
- [lesson|i=0.7] llama.cpp requires "search_document:" prefix for v2 model
- [context|i=0.3] Routine code review, no major findings
```

**Retention policy based on importance:**
| Importance | Retention | Category |
|------------|-----------|----------|
| i >= 0.8 | Permanent | Structural decisions, milestones |
| 0.4 <= i < 0.8 | 30 days | Lessons, observations |
| i < 0.4 | 7 days | Routine context |

**Temporal decay:** Relevance score halves every 30 days. Naturally deprioritizes stale context in search results.

### Layers 7–9: Procedural & Safety Memory

| Layer | File(s) | Purpose |
|-------|---------|---------|
| 7 | `tools-*.md` | Runbooks: API credentials, deployment steps, environment setup |
| 8 | `gating-policies.md` | Numbered failure-prevention rules learned from mistakes |
| 9 | `checkpoints/` | Pre-flight state saves before risky operations |

**Example gating policy:**
```markdown
## GP-001: Never restart gateway without confirmation
- Trigger: Any request to restart services
- Gate: Require explicit "yes, restart" from user
- Reason: Feb 15 incident — silent restart during active session lost 2h context
- Source: 2026-02-15.md
```

---

## 4. Knowledge Graph

### The Problem Knowledge Graphs Solve

BM25 and vector search fail on **entity-relationship queries**:

| Query | BM25 Result | Graph Result |
|-------|-------------|-------------|
| "What port does Keystone run on?" | Wrong file, keyword mismatch | `Keystone.port = 3000` (instant) |
| "Mama's phone number" | USER.md (wrong file) | `Mama → alias → Heidi`, `Heidi.phone = +1-555-...` |
| "What projects does User own?" | Scattered across 5 files | All `relations WHERE subject='User' AND predicate='owns'` |

**Benchmark proof:** 60-query benchmark across 7 categories:

| Method | Recall | Notes |
|--------|--------|-------|
| BM25 only | 46.7% | Good for keywords, poor for entity lookups |
| Graph only | 96.7% | Entity matching + FTS fallback |
| **Hybrid (Graph + BM25)** | **100%** | Graph handles entities, BM25 handles everything else |

### Schema

```sql
-- ==========================================================================
-- Core facts: entity/key/value with activation scoring
-- ==========================================================================
CREATE TABLE facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,           -- "Alice", "MyProject", "Keystone"
    key TEXT NOT NULL,              -- "birthday", "stack", "port"
    value TEXT NOT NULL,            -- "March 15, 1990", "Next.js + PostgreSQL", "3000"
    category TEXT NOT NULL,         -- person, project, decision, convention, etc.
    source TEXT,                    -- origin: "conversation 2026-02-14", "USER.md"
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed TEXT,             -- updated on every retrieval (for decay)
    access_count INTEGER DEFAULT 0, -- how often this fact is retrieved
    permanent BOOLEAN DEFAULT 0,    -- 1 = never decays (birthdays, core decisions)
    decay_score REAL,               -- computed decay score for pruning
    activation REAL DEFAULT 1.0,    -- how "hot" this fact is (bumped on retrieval)
    importance REAL DEFAULT 0.5     -- baseline importance (0.0-1.0)
);

CREATE INDEX idx_facts_entity ON facts(entity);
CREATE INDEX idx_facts_category ON facts(category);
CREATE INDEX idx_facts_entity_key ON facts(entity, key);

-- ==========================================================================
-- Full-text search on facts (with auto-sync triggers)
-- ==========================================================================
CREATE VIRTUAL TABLE facts_fts USING fts5(
    entity, key, value,
    content=facts,
    content_rowid=id
);

-- Auto-sync FTS index on INSERT/UPDATE/DELETE
CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, entity, key, value)
    VALUES (new.id, new.entity, new.key, new.value);
END;

CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, entity, key, value)
    VALUES('delete', old.id, old.entity, old.key, old.value);
END;

CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, entity, key, value)
    VALUES('delete', old.id, old.entity, old.key, old.value);
    INSERT INTO facts_fts(rowid, entity, key, value)
    VALUES (new.id, new.entity, new.key, new.value);
END;

-- ==========================================================================
-- Relations: subject-predicate-object triples
-- ==========================================================================
CREATE TABLE relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_relations_subject ON relations(subject);
CREATE INDEX idx_relations_predicate ON relations(predicate);

-- FTS on relations for natural language queries
CREATE VIRTUAL TABLE relations_fts USING fts5(
    subject, predicate, object,
    content=relations,
    content_rowid=id
);

-- ==========================================================================
-- Aliases: map nicknames to canonical entity names
-- e.g. "Mom" -> "Jane Smith", "K8s" -> "Kubernetes"
-- ==========================================================================
CREATE TABLE aliases (
    alias TEXT NOT NULL COLLATE NOCASE,
    entity TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (alias, entity)
);

-- ==========================================================================
-- Co-occurrences: Hebbian learning — "facts that fire together wire together"
-- ==========================================================================
CREATE TABLE co_occurrences (
    fact_a INTEGER NOT NULL,
    fact_b INTEGER NOT NULL,
    weight REAL DEFAULT 1.0,        -- incremented each co-retrieval
    last_wired TEXT,
    PRIMARY KEY (fact_a, fact_b),
    FOREIGN KEY (fact_a) REFERENCES facts(id),
    FOREIGN KEY (fact_b) REFERENCES facts(id)
);

CREATE INDEX idx_co_occ_a ON co_occurrences(fact_a);
CREATE INDEX idx_co_occ_b ON co_occurrences(fact_b);
```

### Activation/Decay System

The activation system implements a simplified version of the ACT-R memory model from cognitive science:

**Activation tiers:**
| Tier | Range | Behavior |
|------|-------|----------|
| Hot | activation > 2.0 | Frequently accessed, always prominent in results |
| Warm | 1.0 - 2.0 | Moderately accessed, normal ranking |
| Cool | < 1.0 | Rarely accessed, candidates for pruning |

**On retrieval:**
- Bump activation by configurable amount (default: +0.5)
- Increment access_count
- Update last_accessed timestamp
- Wire co-occurrences between all facts retrieved together (Hebbian learning)

**Daily decay (cron at 3 AM):**
```python
# 5% daily decay
UPDATE facts SET activation = activation * 0.95
WHERE permanent = 0 AND activation > 0.01;
```

**Co-occurrence (spreading activation):**
When facts A and B are retrieved together in the same query:
1. `co_occurrences(A, B).weight += 1.0`
2. Next time A is retrieved, B is pulled in if `weight >= threshold`
3. This creates emergent associations — the graph "learns" which facts belong together

### Four-Phase Search Pipeline

```
Query: "When is Partner's birthday?"
         │
         ▼
┌─────────────────────────────┐
│ Phase 1: Entity + Intent    │  Score: 95
│                             │
│ 1. Extract candidates:      │
│    ["Partner"]              │
│ 2. Resolve aliases:         │
│    Partner → "Partner Boyd" │
│ 3. Extract intent:          │
│    "birthday"               │
│ 4. Query:                   │
│    facts WHERE entity =     │
│    'Partner Boyd' AND       │
│    key LIKE '%birthday%'    │
│                             │
│ Result: Partner.birthday =  │
│         July 7, 1976        │
└─────────────────────────────┘
         │
         ▼ (if no Phase 1 hits)
┌─────────────────────────────┐
│ Phase 2: Entity Facts       │  Score: 70
│                             │
│ All facts for resolved      │
│ entity + all relations      │
│ (subject = entity)          │
└─────────────────────────────┘
         │
         ▼ (if no entity resolved)
┌─────────────────────────────┐
│ Phase 3: FTS Facts          │  Score: 50
│                             │
│ Full-text search on         │
│ facts_fts table             │
│ Stop-word filtered          │
└─────────────────────────────┘
         │
         ▼ (if results < top_k)
┌─────────────────────────────┐
│ Phase 4: FTS Relations      │  Score: 40
│                             │
│ Full-text search on         │
│ relations_fts table         │
└─────────────────────────────┘
```

**Entity extraction heuristics:**
1. Capitalized words (single, 2-word, 3-word combos)
2. Known lowercase aliases from the aliases table (word-boundary matched)
3. Possessive patterns: "someone's" → extract "someone"
4. Self-reference patterns: "who am i", "my name" → agent entity

### Data Population

**Three complementary strategies:**

| Strategy | Script | When | What |
|----------|--------|------|------|
| **Manual seeding** | `graph-init.py` | Initial setup | Core entities from USER.md, contacts, projects |
| **Auto-ingestion** | `graph-ingest-daily.py` | Daily cron | Extract from daily logs: tagged entries, key-value bullets, section content |
| **Live conversation** | Growth vectors plugin | Runtime | Auto-populate from corrections and new information (future) |

---

## 5. Search Pipeline

### Combined Scoring (Graph-Memory Plugin)

When the graph-memory plugin retrieves facts, it applies a combined scoring system that preserves **tier separation** — entity matches always rank above FTS-only results:

```
tierBoost = (score >= 65) ? 100 : 0
normRelevance = searchScore / 100
normActivation = min(activation / maxActivation, 1.0)

combinedScore = tierBoost
              + (normRelevance * relevanceWeight)     -- default 0.7
              + (normActivation * activationWeight)    -- default 0.3
```

**Why tier-preserved scoring matters:** Without the tier boost, a frequently-accessed FTS result (high activation) could outrank a precisely-matched entity result. The 100-point tier boost ensures entity matches (score >= 65) always appear above FTS-only matches (score < 65), while activation still influences ordering within each tier.

### Query Flow (End-to-End)

```
User message arrives
    │
    ├─► Graph-Memory Plugin (priority 5)
    │   ├── Extract entities from message
    │   ├── Check LRU cache (60s TTL)
    │   ├── Run 4-phase graph search
    │   ├── Score with relevance + activation
    │   ├── Bump activations on retrieved facts
    │   ├── Wire co-occurrences
    │   ├── Pull spreading-activation results
    │   └── Inject [GRAPH MEMORY] block
    │
    ├─► Continuity Plugin (priority 10)
    │   ├── Embed user message (768d)
    │   ├── Search conversation archive
    │   ├── Apply topic tracking
    │   ├── Budget tokens across priority tiers
    │   └── Inject [CONTINUITY CONTEXT] block
    │
    ├─► Stability Plugin (priority 15)
    │   ├── Calculate conversation entropy
    │   ├── Check principle alignment
    │   ├── Detect loops / confabulation
    │   └── Inject [STABILITY CONTEXT] block
    │
    └─► LLM processes message with all injected context
```

### Memory Tools (Agent-Accessible)

Two tools the agent can invoke explicitly during a session:

| Tool | Purpose | Returns |
|------|---------|---------|
| `memory_search` | Semantic recall over indexed files | Chunks (max ~700 chars) with file path, line range, relevance score |
| `memory_get` | Targeted read of a specific file/line range | File content (graceful empty on missing) |

**Agent instruction:** *"Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search."*

---

## 6. Embedding Infrastructure

### Model Selection

| Provider | Cost | Latency | Dimensions | Quality | Notes |
|----------|------|---------|------------|---------|-------|
| **Azure OpenAI text-embedding-3-large** | ~$0.13/M tokens | ~150ms | 3072 (or 1536 custom) | **Best** | Recommended — high quality, multilingual, scalable |
| **Azure OpenAI text-embedding-3-small** | ~$0.02/M tokens | ~100ms | 1536 | Great | Lower cost alternative, still excellent quality |
| **QMD (BM25 + reranking)** | Free | ~4s | — | Best reranked | Built-in to OpenClaw, uses Qwen3-0.6B reranker |
| **llama.cpp GPU** | Free | ~7ms | 768 | Good | Local alternative if GPU available |
| **Ollama nomic-embed-text** | Free | ~61ms | 768 | Good | Local alternative: `ollama pull nomic-embed-text` |

**Recommended setup for NanoClaw:**
- **Primary:** Azure OpenAI `text-embedding-3-large` (3072d, best quality, ~150ms)
- **Budget alternative:** Azure OpenAI `text-embedding-3-small` (1536d, cheaper, ~100ms)
- **Offline fallback:** BM25/FTS only (no vector search, still functional via knowledge graph)

### Azure OpenAI Setup

**1. Create Azure OpenAI resource and deploy embedding model:**

```bash
# Via Azure CLI
az cognitiveservices account create \
  --name nanoclaw-openai \
  --resource-group nanoclaw-rg \
  --kind OpenAI \
  --sku S0 \
  --location eastus2

# Deploy the embedding model
az cognitiveservices account deployment create \
  --name nanoclaw-openai \
  --resource-group nanoclaw-rg \
  --deployment-name text-embedding-3-large \
  --model-name text-embedding-3-large \
  --model-version "1" \
  --model-format OpenAI \
  --sku-capacity 120 \
  --sku-name Standard
```

**2. Environment variables:**

```bash
# .env (never commit this file)
AZURE_OPENAI_API_KEY=your-key-here
AZURE_OPENAI_ENDPOINT=https://nanoclaw-openai.openai.azure.com
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large
AZURE_OPENAI_API_VERSION=2024-06-01
```

### Embedding API

```bash
# Embed a document (for indexing)
curl -s "${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_EMBEDDING_DEPLOYMENT}/embeddings?api-version=${AZURE_OPENAI_API_VERSION}" \
  -H "Content-Type: application/json" \
  -H "api-key: ${AZURE_OPENAI_API_KEY}" \
  -d '{"input": "Alice birthday is March 15"}'

# Embed a query (for searching) — same endpoint, same format
curl -s "${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_EMBEDDING_DEPLOYMENT}/embeddings?api-version=${AZURE_OPENAI_API_VERSION}" \
  -H "Content-Type: application/json" \
  -H "api-key: ${AZURE_OPENAI_API_KEY}" \
  -d '{"input": "When is Alice born?"}'
```

**Note:** Azure OpenAI `text-embedding-3-*` models do **not** require task prefixes (unlike nomic-embed-text). The same API call works for both indexing and querying.

**Optional dimension reduction:** `text-embedding-3-large` supports a `dimensions` parameter to reduce output size (e.g., 1536 instead of 3072) for faster similarity search with minimal quality loss:

```json
{"input": "some text", "dimensions": 1536}
```

### Embedding Client (Python)

```python
# embed.py — Azure OpenAI embedding client for NanoClaw
import os
import httpx

AZURE_ENDPOINT = os.environ["AZURE_OPENAI_ENDPOINT"]
AZURE_KEY = os.environ["AZURE_OPENAI_API_KEY"]
AZURE_DEPLOYMENT = os.environ.get("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-3-large")
AZURE_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-06-01")

def embed(texts: list[str], dimensions: int | None = None) -> list[list[float]]:
    """Embed one or more texts using Azure OpenAI."""
    url = f"{AZURE_ENDPOINT}/openai/deployments/{AZURE_DEPLOYMENT}/embeddings?api-version={AZURE_API_VERSION}"
    body = {"input": texts}
    if dimensions:
        body["dimensions"] = dimensions
    resp = httpx.post(url, json=body, headers={"api-key": AZURE_KEY}, timeout=30)
    resp.raise_for_status()
    return [item["embedding"] for item in resp.json()["data"]]

def embed_single(text: str, dimensions: int | None = None) -> list[float]:
    """Embed a single text string."""
    return embed([text], dimensions)[0]
```

### Embedding Client (JavaScript/Node.js)

```javascript
// embed.js — Azure OpenAI embedding client for NanoClaw
const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'text-embedding-3-large';
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-06-01';

async function embed(texts, dimensions = null) {
    const url = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/embeddings?api-version=${AZURE_API_VERSION}`;
    const body = { input: texts };
    if (dimensions) body.dimensions = dimensions;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': AZURE_KEY
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error(`Azure OpenAI error: ${response.status}`);
    const data = await response.json();
    return data.data.map(item => item.embedding);
}

async function embedSingle(text, dimensions = null) {
    const results = await embed([text], dimensions);
    return results[0];
}

module.exports = { embed, embedSingle };
```

### Batch Embedding (Cost Optimization)

Azure OpenAI supports up to **2048 inputs per request**. For bulk indexing (e.g., re-embedding all memory files), batch your inputs:

```python
# Batch embed for bulk indexing
BATCH_SIZE = 256  # balance between speed and request size

def embed_batch(texts: list[str], dimensions: int | None = None) -> list[list[float]]:
    """Embed a large list of texts in batches."""
    all_embeddings = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i:i + BATCH_SIZE]
        all_embeddings.extend(embed(batch, dimensions))
    return all_embeddings
```

### Fallback Chain

```
Azure OpenAI text-embedding-3-large (cloud, 3072d)
    │ unavailable / quota exceeded?
    ▼
Azure OpenAI text-embedding-3-small (cloud, 1536d)
    │ unavailable?
    ▼
Disabled (BM25/FTS + knowledge graph only — no vector search)
```

If the embedding provider, model, or dimensions change, trigger a full reindex of all memory files automatically.

### Cost Estimation

| Scenario | Tokens/day | Model | Daily Cost |
|----------|-----------|-------|------------|
| Light use (50 queries + 10 file re-embeds) | ~50K | text-embedding-3-large | ~$0.007 |
| Moderate use (200 queries + 50 file re-embeds) | ~200K | text-embedding-3-large | ~$0.026 |
| Heavy use (500 queries + full reindex) | ~1M | text-embedding-3-large | ~$0.130 |
| Same heavy use with small model | ~1M | text-embedding-3-small | ~$0.020 |

**Bottom line:** Embedding costs are negligible compared to LLM inference costs. Even heavy daily use with the large model costs less than a single GPT-4o conversation.

---

## 7. Runtime Plugins

### Plugin Architecture

Plugins hook into the agent's message pipeline at defined points. Each plugin:
1. Registers event handlers with a priority (lower = runs first)
2. Receives the event object (messages, context)
3. Returns modified context (typically `{ prependContext: "..." }`)

```javascript
module.exports = {
    id: 'plugin-name',
    name: 'Human-Readable Name',

    register(api) {
        api.on('before_agent_start', async (event, ctx) => {
            // Extract user message
            // Do computation (search, scoring, etc.)
            // Return context injection
            return { prependContext: '[PLUGIN BLOCK]\n...' };
        }, { priority: 5 });

        api.on('gateway_stop', async () => {
            // Cleanup resources
        });
    }
};
```

### Plugin 1: Graph-Memory (Priority 5)

**Purpose:** Inject relevant entity facts before every LLM call.

**Flow:**
1. Extract user's last message, strip previous injection blocks
2. Check LRU cache (10 entries, 60s TTL)
3. Spawn graph-search.py subprocess (500ms timeout)
4. Filter: only inject if entity-matched results exist (score >= 65)
5. Score with combined relevance (70%) + activation (30%), tier-preserved
6. Bump activations on retrieved facts (+0.5)
7. Wire co-occurrences between co-retrieved facts
8. Pull spreading-activation results (up to 4 co-occurring facts, weight >= 2)
9. Format and inject `[GRAPH MEMORY]` block

**Configuration:**
```json
{
    "enabled": true,
    "maxResults": 8,
    "minScore": 50,
    "timeoutMs": 500,
    "activationBump": 0.5,
    "activationWeight": 0.3,
    "relevanceWeight": 0.7,
    "coOccurrenceLimit": 4,
    "coOccurrenceMinWeight": 2,
    "cacheSize": 10,
    "cacheTTL": 60000
}
```

**What the agent sees:**
```
[GRAPH MEMORY]
• Partner.birthday = July 7, 1976
• Partner.full_name = Partner Boyd
• Partner → partner_of → User
• User.timezone = America/Chicago [linked]
```

### Plugin 2: Continuity (Priority 10)

**Purpose:** Cross-session conversation memory via semantic search over conversation archive.

**Components:**
| Component | Purpose |
|-----------|---------|
| Conversation archive | All user/agent exchange pairs, embedded (Azure OpenAI, sqlite-vec) |
| Topic tracking | Detect active, fixated, and fading conversation topics |
| Continuity anchors | Preserve identity moments, contradictions (max 15, 2h TTL) |
| Context budgeting | Token allocation across priority tiers (recent > mid > old) |

**Proprioceptive framing:** Retrieved memories use first-person language:
- "You said:" (not "Archive contains:")
- "You were working on:" (not "Records show:")

This makes the agent recognize retrieved context as its own experience, not external data.

**What the agent sees:**
```
[CONTINUITY CONTEXT]
You were discussing the payment API migration yesterday.
You said: "We should keep REST endpoints alive for 6 months"
User mentioned wanting a deprecation notice in the API response headers.
Topics: payment-api (active), graphql-migration (active)
```

### Plugin 3: Stability (Priority 15)

**Purpose:** Behavioral drift detection and correction.

**Components:**
| Component | What It Detects |
|-----------|----------------|
| Entropy monitoring | Conversation coherence (0.0 stable → 1.0+ drift) |
| Principle alignment | Behavior vs. SOUL.md principles |
| Loop detection | Tool loops, repeated file reads |
| Confabulation detection | Temporal mismatches, quality decay, making up facts |

**What the agent sees:**
```
[STABILITY CONTEXT]
Entropy: 0.3 (stable)
Principles: directness, reliability
```

### Plugin 4: Growth Vectors (Priority 20) [Future]

**Purpose:** Behavioral learning from user corrections.

**How it works:**
1. **Detect corrections** in user messages (regex patterns: "don't X", "you should Y", "next time Z")
2. **Extract lessons** from correction context
3. **Embed trigger patterns** with 768d vectors
4. **Match future queries** against stored triggers using cosine similarity
5. **Inject behavioral reminders** before the agent responds
6. **Track effectiveness** — does entropy decrease after injection?
7. **Metabolize** effective lessons into SOUL.md principles after 30+ days

**Schema addition:**
```sql
CREATE TABLE growth_vectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_pattern TEXT NOT NULL,
    trigger_embedding BLOB,          -- float32 (3072d for text-embedding-3-large)
    lesson_text TEXT NOT NULL,
    principle TEXT,                   -- "reliability", "directness", etc.
    effectiveness_score REAL DEFAULT 1.0,
    injection_count INTEGER DEFAULT 0,
    maturity_days INTEGER DEFAULT 0,
    is_metabolized BOOLEAN DEFAULT 0,
    activation REAL DEFAULT 1.0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE vector_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vector_id INTEGER NOT NULL,
    query_text TEXT,
    pre_entropy REAL,
    post_entropy REAL,
    user_feedback TEXT,              -- "good", "bad", "neutral"
    helped BOOLEAN,
    injection_time TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (vector_id) REFERENCES growth_vectors(id)
);
```

---

## 8. Information Flow & Lifecycle

### Upward Consolidation

Information flows upward from raw observations to structured knowledge:

```
Daily logs (raw, ephemeral)
    │  auto-ingest + manual review
    ▼
active-context.md (working memory, refreshed each session)
    │  periodic heartbeat maintenance
    ▼
MEMORY.md (curated wisdom, <200 lines)
    │  structured extraction
    ▼
facts.db (entity/key/value, permanent or decaying)
    │  behavioral extraction (future)
    ▼
growth_vectors (behavioral lessons, tracked effectiveness)
    │  metabolization (30+ days, >80% effectiveness)
    ▼
SOUL.md principles (core identity)
```

### Session Boot Sequence

**Main agent (personal assistant):**
```
1. Load SOUL.md         → who am I
2. Load USER.md         → who am I helping
3. Load IDENTITY.md     → quick identity card
4. Load active-context  → what's hot right now
5. Load MEMORY.md       → long-term wisdom (private sessions only)
6. Load today's + yesterday's daily logs
7. [Runtime] Graph-memory plugin → entity injection per turn
8. [Runtime] Continuity plugin → cross-session context per turn
9. [Runtime] Stability plugin → behavioral monitoring per turn
10. [On demand] memory_search → semantic recall
11. [On demand] memory_get → targeted file read
```

**Project agent (developer, QA, PM):**
```
1. Load project-{slug}.md  → institutional knowledge (FIRST)
2. Load SOUL.md / IDENTITY.md
3. Agent-specific boot steps
4. Load today's daily log
5. [Runtime] Plugins as configured
```

### Pre-Compaction Memory Flush

When the context window approaches its limit, an automatic memory flush fires:

**Trigger:** `contextWindow - reserveTokensFloor - softThresholdTokens`
(e.g., 200K - 20K - 4K = **176K tokens**)

**Process:**
1. System injects hidden prompt: *"Session nearing compaction. Store durable memories now."*
2. Agent writes lasting observations to `memory/YYYY-MM-DD.md`
3. Agent replies with `NO_REPLY` if nothing to store
4. Only **one flush per compaction cycle** (tracked in sessions.json)
5. Skipped if workspace is read-only

**Why this matters:** Without this mechanism, valuable in-session context would be permanently lost when the context window is truncated. The flush gives the agent a chance to persist important observations to disk before they vanish.

### Maintenance Crons

| Time | Script | Purpose |
|------|--------|---------|
| 3:00 AM daily | `graph-decay.py` | Apply 5% decay to non-permanent facts |
| 3:30 AM weekly | `ebook-rag-update.sh` | Reindex domain RAG (if using Layer 5a) |
| On change | File watcher (1.5s debounce) | Re-embed modified memory files |

---

## 9. Database Schema

### Complete ERD

```
┌─────────────────────────┐         ┌─────────────────────┐
│         facts           │         │      relations      │
├─────────────────────────┤         ├─────────────────────┤
│ id (PK)                 │◄───┐    │ id (PK)             │
│ entity                  │    │    │ subject              │
│ key                     │    │    │ predicate            │
│ value                   │    │    │ object               │
│ category                │    │    │ source               │
│ source                  │    │    │ created_at           │
│ created_at              │    │    └─────────────────────┘
│ last_accessed           │    │
│ access_count            │    │    ┌─────────────────────┐
│ permanent               │    │    │      aliases        │
│ decay_score             │    │    ├─────────────────────┤
│ activation              │    │    │ alias (PK)          │
│ importance              │    │    │ entity              │
└─────────┬───────────────┘    │    └─────────────────────┘
          │                    │
          │ fact_a             │ fact_b
          ▼                    ▼
┌─────────────────────────────────────┐
│          co_occurrences             │
├─────────────────────────────────────┤
│ fact_a (PK, FK→facts.id)           │
│ fact_b (PK, FK→facts.id)           │
│ weight                              │
│ last_wired                          │
└─────────────────────────────────────┘

┌─────────────────────────┐    ┌─────────────────────────┐
│    growth_vectors       │    │    vector_outcomes      │
├─────────────────────────┤    ├─────────────────────────┤
│ id (PK)                 │◄───│ vector_id (FK)          │
│ trigger_pattern         │    │ id (PK)                 │
│ trigger_embedding       │    │ query_text              │
│ lesson_text             │    │ pre_entropy             │
│ principle               │    │ post_entropy            │
│ effectiveness_score     │    │ user_feedback           │
│ injection_count         │    │ helped                  │
│ maturity_days           │    │ injection_time          │
│ is_metabolized          │    └─────────────────────────┘
│ activation              │
│ created_at              │
└─────────────────────────┘
```

### FTS5 Virtual Tables

```
facts_fts (entity, key, value) ← auto-synced via triggers
relations_fts (subject, predicate, object) ← auto-synced via triggers
```

### Continuity Archive (separate database)

```sql
-- continuity.db (per-agent)
CREATE TABLE exchanges (
    id INTEGER PRIMARY KEY,
    session_id TEXT,
    user_message TEXT,
    agent_response TEXT,
    timestamp TEXT,
    topic TEXT,
    embedding BLOB           -- Azure OpenAI float32 (3072d or 1536d depending on model)
);

-- sqlite-vec virtual table for vector search
-- Dimensions must match AZURE_OPENAI_EMBEDDING_DEPLOYMENT output
CREATE VIRTUAL TABLE exchanges_vec USING vec0(
    embedding float[3072]    -- use 1536 if using text-embedding-3-small
);
```

---

## 10. MCP Server Integration

For NanoClaw implementations that use the Model Context Protocol (MCP), the memory system can be exposed as an MCP server with these tools:

### MCP Tools

```typescript
// Memory search: semantic recall across indexed files
{
    name: "memory_search",
    description: "Search memory for relevant context about a topic",
    inputSchema: {
        type: "object",
        properties: {
            query: { type: "string", description: "What to search for" },
            limit: { type: "number", default: 5 }
        },
        required: ["query"]
    }
}

// Memory read: targeted file access
{
    name: "memory_get",
    description: "Read a specific memory file or line range",
    inputSchema: {
        type: "object",
        properties: {
            file: { type: "string", description: "File path relative to memory/" },
            startLine: { type: "number" },
            endLine: { type: "number" }
        },
        required: ["file"]
    }
}

// Graph search: entity/relationship lookup
{
    name: "graph_search",
    description: "Search the knowledge graph for entity facts and relationships",
    inputSchema: {
        type: "object",
        properties: {
            query: { type: "string" },
            topK: { type: "number", default: 6 }
        },
        required: ["query"]
    }
}

// Memory write: store new observations
{
    name: "memory_write",
    description: "Write observations to today's daily log",
    inputSchema: {
        type: "object",
        properties: {
            content: { type: "string" },
            importance: { type: "number", description: "0.0-1.0" }
        },
        required: ["content"]
    }
}

// Fact upsert: add/update structured facts
{
    name: "fact_upsert",
    description: "Add or update a fact in the knowledge graph",
    inputSchema: {
        type: "object",
        properties: {
            entity: { type: "string" },
            key: { type: "string" },
            value: { type: "string" },
            category: { type: "string" },
            importance: { type: "number", default: 0.5 }
        },
        required: ["entity", "key", "value", "category"]
    }
}
```

### MCP Resources

```typescript
// Always-loaded memory files as resources
{
    uri: "memory://soul",
    name: "SOUL.md",
    mimeType: "text/markdown"
}
{
    uri: "memory://user",
    name: "USER.md",
    mimeType: "text/markdown"
}
{
    uri: "memory://active-context",
    name: "active-context.md",
    mimeType: "text/markdown"
}
{
    uri: "memory://long-term",
    name: "MEMORY.md",
    mimeType: "text/markdown"
}
```

---

## 11. Configuration Reference

### Directory Structure

```
~/.nanoclaw/
├── workspace/
│   ├── SOUL.md                      # Agent persona (Layer 1)
│   ├── USER.md                      # Human identity (Layer 1)
│   ├── IDENTITY.md                  # Agent identity card (Layer 1)
│   ├── AGENTS.md                    # Operating instructions
│   ├── TOOLS.md                     # Tool guidance notes
│   ├── HEARTBEAT.md                 # Periodic maintenance checklist
│   ├── BOOT.md                      # Startup checklist
│   ├── MEMORY.md                    # Curated long-term memory (Layer 2)
│   ├── memory/
│   │   ├── active-context.md        # Working memory (Layer 1)
│   │   ├── 2026-02-23.md            # Today's daily log (Layer 6)
│   │   ├── 2026-02-22.md            # Yesterday's daily log
│   │   ├── project-nanoclaw.md      # Project memory (Layer 3)
│   │   ├── tools-deploy.md          # Runbook (Layer 7)
│   │   ├── gating-policies.md       # Failure prevention (Layer 8)
│   │   └── checkpoints/             # Pre-flight saves (Layer 9)
│   └── scripts/
│       ├── graph-search.py          # 4-phase search engine
│       ├── graph-decay.py           # Daily activation decay
│       ├── graph-ingest-daily.py    # Auto-extract facts from logs
│       ├── init-facts-db.py         # Initialize database
│       ├── seed-facts.py            # Bulk insert facts
│       └── memory-benchmark.py      # 60-query benchmark suite
│
├── data/
│   ├── facts.db                     # Knowledge graph (Layer 4)
│   └── continuity.db                # Conversation archive (Layer 10)
│
├── extensions/
│   ├── graph-memory/                # Plugin (Layer 12)
│   ├── continuity/                  # Plugin (Layer 10)
│   ├── stability/                   # Plugin (Layer 11)
│   └── growth-vectors/              # Plugin (future)
│
└── nanoclaw.json                    # Main configuration
```

### Main Configuration (`nanoclaw.json`)

```json
{
    "memory": {
        "searchWeights": {
            "vector": 0.7,
            "bm25": 0.3
        },
        "chunkSize": 400,
        "chunkOverlap": 80,
        "temporalDecayHalfLife": 30,
        "maxBootstrapCharsPerFile": 20000,
        "maxBootstrapCharsTotal": 150000
    },
    "embeddings": {
        "provider": "azure-openai",
        "endpoint": "${AZURE_OPENAI_ENDPOINT}",
        "apiKey": "${AZURE_OPENAI_API_KEY}",
        "deployment": "text-embedding-3-large",
        "apiVersion": "2024-06-01",
        "dimensions": 3072,
        "fallbackDeployment": "text-embedding-3-small",
        "fallbackDimensions": 1536
    },
    "plugins": {
        "allow": ["graph-memory", "continuity", "stability"],
        "entries": {
            "graph-memory": {
                "enabled": true,
                "maxResults": 8,
                "minScore": 50,
                "timeoutMs": 500,
                "activationBump": 0.5
            },
            "continuity": {
                "enabled": true,
                "maxExchanges": 5000,
                "contextBudget": 2000
            },
            "stability": {
                "enabled": true,
                "entropyThreshold": 0.7
            }
        }
    },
    "cron": {
        "decay": "0 3 * * *",
        "ragReindex": "30 3 * * 0"
    }
}
```

---

## 12. Implementation Roadmap

### Phase 1: Foundation (Week 1)

**Goal:** Basic persistent memory with file-based storage + knowledge graph.

| Task | Deliverable |
|------|-------------|
| Set up workspace directory structure | All Layer 1-3 markdown files |
| Initialize facts.db with schema | `init-facts-db.py` + `facts.sql` |
| Seed core entities | `seed-facts.py` with user data, projects, tools |
| Implement graph-search.py | 4-phase search pipeline |
| Create daily log template | `YYYY-MM-DD.md` with importance tagging |
| Set up embedding service | Azure OpenAI resource + text-embedding-3-large deployment |

**Milestone:** `graph-search.py "When is [person]'s birthday?"` returns correct result.

### Phase 2: Search Integration (Week 2)

**Goal:** Hybrid search that combines graph + semantic retrieval.

| Task | Deliverable |
|------|-------------|
| Implement memory indexer | Chunk files, embed, store in SQLite-vec |
| Build memory_search tool | BM25 + vector hybrid search |
| Build memory_get tool | Targeted file/line reader |
| Run 60-query benchmark | Validate 100% hybrid recall |
| Implement file watcher | Auto-reindex on memory file changes |

**Milestone:** Benchmark shows 100% recall on hybrid search.

### Phase 3: Runtime Plugins (Week 3)

**Goal:** Active memory augmentation during inference.

| Task | Deliverable |
|------|-------------|
| Build graph-memory plugin | Entity injection via before_agent_start hook |
| Build continuity plugin | Cross-session archive with sqlite-vec |
| Build stability plugin | Entropy monitoring + principle alignment |
| Add telemetry logging | `/tmp/nanoclaw/memory-telemetry.jsonl` |

**Milestone:** All three `[CONTEXT]` blocks injecting correctly.

### Phase 4: Activation & Learning (Week 4)

**Goal:** Memory that learns from usage patterns.

| Task | Deliverable |
|------|-------------|
| Implement activation scoring | Bump on retrieval, daily decay cron |
| Implement co-occurrence wiring | Hebbian learning between co-retrieved facts |
| Implement spreading activation | Pull related facts via co-occurrence links |
| Build auto-ingestion script | Extract facts from daily logs |
| Set up daily decay cron | `graph-decay.py` at 3 AM |

**Milestone:** Frequently-accessed facts rise to "Hot" tier; unused facts decay to "Cool."

### Phase 5: Behavioral Learning (Week 5-6) [Optional]

**Goal:** Agent that learns from user corrections.

| Task | Deliverable |
|------|-------------|
| Build correction detection | Regex patterns for "don't X", "you should Y" |
| Build growth vectors table | Schema + CLI for manual vector creation |
| Build growth-vectors plugin | Embed triggers, match queries, inject lessons |
| Build effectiveness tracking | Pre/post entropy comparison |
| Build metabolization workflow | Promote proven lessons to SOUL.md |

**Milestone:** Agent stops repeating corrected behaviors after 2-3 sessions.

### Phase 6: MCP Integration (Week 7) [If applicable]

**Goal:** Expose memory system as an MCP server for Claude/other clients.

| Task | Deliverable |
|------|-------------|
| Build MCP server wrapper | Express memory tools as MCP tool definitions |
| Expose memory resources | SOUL.md, USER.md, MEMORY.md as MCP resources |
| Build context injection middleware | Plugin-style injection for MCP-based agents |

**Milestone:** Claude Desktop can search and write to NanoClaw memory via MCP.

---

## Appendix: Comparison of Approaches

### OpenClaw Native Memory vs. NanoClaw Design

| Feature | OpenClaw Native | NanoClaw (This Design) |
|---------|----------------|----------------------|
| **Storage format** | Markdown files only | Markdown + SQLite knowledge graph |
| **Search** | BM25 + vector (hybrid) | Graph + BM25 + vector (triple hybrid) |
| **Entity lookups** | Requires embedding search (~7ms) | Direct SQLite lookup (<1ms) |
| **Relationships** | Not supported | `relations` table with FTS |
| **Aliases** | Not supported | `aliases` table with case-insensitive matching |
| **Activation/Decay** | Temporal decay on daily logs | Per-fact activation scoring + daily decay cron |
| **Cross-session memory** | Pre-compaction flush only | Dedicated continuity plugin with conversation archive |
| **Behavioral learning** | None | Growth vectors (correction → lesson → principle) |
| **Behavioral monitoring** | None | Stability plugin (entropy, loops, confabulation) |
| **Runtime injection** | None (all at boot) | Three plugin hooks inject per-turn context |
| **Benchmark recall** | 46.7% (BM25 only) | 100% (hybrid) |
| **Entity injection** | Manual via memory_search | Automatic via graph-memory plugin |
| **API cost for recall** | Embedding API calls | Minimal (Azure OpenAI embeddings ~$0.13/M tokens; graph/BM25 free) |

### When to Use What

| Scenario | Recommended Approach |
|----------|---------------------|
| **Personal assistant** | Full 12-layer stack. You need entity lookups, continuity, and behavioral learning. |
| **Code assistant** | Layers 1-6 + continuity. Skip domain RAG and growth vectors. Add code-aware search. |
| **Multi-agent team** | Layers 1-6 per agent + shared project memory (Layer 3). Continuity per-agent. |
| **Minimal setup** | Layers 1-6 only. Markdown files + facts.db + semantic search. No plugins needed. |
| **Maximum recall** | Full stack + Domain RAG (Layer 5a) for specialized knowledge. |

### Performance Reference

| Operation | Latency | Notes |
|-----------|---------|-------|
| SQLite fact lookup | <1ms | Direct key-value query |
| FTS5 full-text search | <1ms | Indexed text search |
| Azure OpenAI embedding (3072d) | ~150ms | text-embedding-3-large, cloud API |
| Azure OpenAI embedding (1536d) | ~100ms | text-embedding-3-small, cloud API |
| Graph search full pipeline | ~500ms | 4-phase + subprocess spawn |
| Continuity semantic search | ~150ms | Azure embedding + sqlite-vec cosine similarity |
| QMD BM25 + reranking | ~4s | Best quality, highest latency |
| Pre-compaction flush | ~2s | Single hidden agentic turn |

---

*Document version: 1.1 | Date: 2026-02-23 | Source: openclaw-memory-architecture v6.0 + OpenClaw Clawbot research | Embedding: Azure OpenAI*
