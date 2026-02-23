# Knowledge Graph Layer

> Lightweight entity-relationship graph built on SQLite. Zero API cost, sub-millisecond lookups, 100% recall on structured queries.

## The Problem

BM25 and vector search work for fuzzy recall — *"what were we discussing about infrastructure?"* — but fail spectacularly for entity-relationship queries:

- "What port does Keystone run on?" → BM25 can't match "port" to the right file
- "Mama's phone number" → Vector search returns USER.md (wrong), not family-contacts.md (right)
- "What does User own?" → No single file answers this; it's scattered across 5 project files

These are **graph queries**, not search queries. The answer lives in relationships between entities, not keywords in documents.

## Benchmark Results

60-query benchmark across 7 categories (PEOPLE, TOOLS, PROJECTS, FACTS, OPERATIONAL, IDENTITY, DAILY):

| Method | Score | Notes |
|--------|-------|-------|
| BM25 only (QMD) | 46.7% | Baseline — good for keyword matches, poor for entity lookups |
| Graph only | 96.7% | Entity matching + FTS fallback |
| **Hybrid (Graph + BM25)** | **100%** | Graph handles entities, BM25 handles everything else |

The graph doesn't replace vector/keyword search — it fills the gap they can't cover.

## Architecture

### Schema (SQLite + FTS5)

```sql
CREATE TABLE facts (
    id INTEGER PRIMARY KEY,
    entity TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    category TEXT NOT NULL,      -- event, project, infrastructure, identity, etc.
    source TEXT,                  -- which file this came from
    UNIQUE(entity, key, value)
);

CREATE VIRTUAL TABLE facts_fts USING fts5(entity, key, value, content=facts, content_rowid=id);

CREATE TABLE relations (
    id INTEGER PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    source TEXT,
    UNIQUE(subject, predicate, object)
);

CREATE TABLE aliases (
    alias TEXT NOT NULL,
    entity TEXT NOT NULL,
    PRIMARY KEY(alias, entity)
);
```

### Current Scale

| Metric | Count |
|--------|-------|
| Facts | 1,265 |
| Relations | 488 |
| Aliases | 125 |
| Entities | 361 |
| Source files | 74 |

### Four-Phase Search Pipeline

1. **Entity + Intent** (score 95): Query matches a known entity AND contains an intent keyword (birthday, phone, port, stack, etc.)
2. **Entity Facts** (score 70): Query matches an entity via aliases — return all facts for that entity
3. **FTS Facts** (score 50): Full-text search across `facts_fts` for keyword matches
4. **FTS Relations** (score 40): Full-text search across relations for relationship queries

Alias matching uses word boundaries (`\b`) to prevent false positives (e.g., "flo" matching inside "overflow").

## Data Sources

### Manual Seeding (`graph-init.py`)
Initial population from structured files: USER.md, family-contacts.md, project files, tool configs. Creates the core entity definitions with curated facts and relations.

### Auto-Ingestion (`graph-ingest-daily.py`)
Bulk extraction from daily journal files and memory files:

- **Tagged entries**: Parses `[milestone|i=0.85]`, `[decision|i=0.9]` etc. from daily files → creates event entities with date, summary, importance, and project/tech relations
- **Structured data**: Extracts key-value pairs from bullet points (URLs, ports, status)
- **Section content**: Creates entities from `##` sections with >50 chars of content
- **Auto-categorization**: `_infer_category()` classifies facts as event, project, infrastructure, identity, etc.

```bash
# Process all unindexed files
python3 scripts/graph-ingest-daily.py

# Dry run (show what would be added)
python3 scripts/graph-ingest-daily.py --dry-run

# Process one specific file
python3 scripts/graph-ingest-daily.py --file memory/2026-02-18.md

# Show graph statistics
python3 scripts/graph-ingest-daily.py --stats
```

### Live Conversation (planned)
Auto-populate the graph from conversations as they happen — graph grows organically without manual intervention.

## OpenClaw Plugin Integration

The **openclaw-plugin-graph-memory** wires graph search directly into OpenClaw's message pipeline:

### How it works

1. Hooks `before_agent_start` (priority 5, runs before continuity plugin)
2. Extracts the user's last message, strips context injection blocks
3. Spawns `graph-search.py --json` as a subprocess (2s timeout)
4. Filters results: only injects when entities are matched (score ≥ 65), skips FTS-only noise
5. Returns matching facts as `[GRAPH MEMORY]` prependContext block

### Installation

```bash
# Copy plugin to extensions directory
cp -r plugin/ ~/.openclaw/extensions/openclaw-plugin-graph-memory/

# Enable the plugin
openclaw plugins enable graph-memory

# Restart gateway
openclaw gateway restart
```

### What the agent sees

When a user asks "When is Partner's birthday?", the plugin injects before the LLM processes the message:

```
[GRAPH MEMORY]
• Partner.birthday = July 7, 1976
• Partner.full_name = Partner Boyd
• Partner.relationship = User's girlfriend
• Partner → partner_of → User
```

The agent gets the answer in context without needing to search files or make tool calls. Zero additional API cost, sub-2-second latency.

## Context Optimization

The graph enables aggressive trimming of workspace files loaded every session:

| File | Before | After | Savings |
|------|--------|-------|---------|
| MEMORY.md | 12.4KB | 3.5KB | -72% |
| AGENTS.md | 14.7KB | 4.3KB | -70% |
| **Total** | **27.1KB** | **7.8KB** | **~6,500 tokens/session** |

**Why this works**: Facts that used to live in MEMORY.md (agent model map, dispatcher details, embedding setup) are now in the knowledge graph. The graph plugin injects only what's relevant per-turn instead of loading everything every session.

## Key Lesson

Memory is a **content problem**, not a technology problem. The progression:

1. **Embeddings** (vector search): Good for fuzzy recall, expensive, misses entity queries
2. **BM25** (keyword search): Good for keyword matches, free, misses relationship queries
3. **Knowledge graph**: Good for entity/relationship queries, free, misses fuzzy recall
4. **Hybrid (graph + BM25)**: 100% recall, zero API cost

Structure beats embeddings. A well-organized SQLite database with aliases outperforms expensive vector databases for the queries that matter most.
