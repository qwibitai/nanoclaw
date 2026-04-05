---
name: wiki
description: Maintain a persistent wiki knowledge base. Ingest sources (URLs, files, attachments), build and update interlinked wiki pages, answer questions from the wiki, and run periodic health checks. Use when the user sends sources to add, asks questions the wiki can answer, or requests wiki maintenance.
---

# Wiki Knowledge Base

You maintain a persistent wiki in your workspace. The wiki sits between you and raw sources — when new material arrives, you read it and integrate it into structured, interlinked pages. Knowledge compounds over time rather than being re-derived on every question.

## Directory Structure

```
wiki/                  # LLM-generated pages (you own this entirely)
  index.md             # Content catalog — updated on every ingest
  log.md               # Append-only activity log
  ...                  # Entity pages, concept pages, comparisons, syntheses
sources/               # Raw immutable material (never modify these)
  ...                  # Fetched articles, clipped pages, uploaded files
```

## Operations

### Ingest

When the user sends a URL, file, or says to add something:

1. Fetch or read the source material
2. Save a copy to `sources/` (URLs: fetch and save as markdown; files: copy as-is)
3. Discuss key takeaways with the user
4. Create or update wiki pages — summaries, entity pages, concept pages, cross-references
5. Flag contradictions with existing wiki content
6. Update `index.md` with new and changed pages
7. Append to `log.md`

A single source often touches many wiki pages. Prefer ingesting one source at a time with user involvement, though batch ingestion works for bulk imports.

### Query

When the user asks a question:

1. Read `index.md` to locate relevant pages
2. Read those pages and synthesize an answer
3. Cite which wiki pages informed the answer
4. If the answer is substantial, offer to file it back as a new wiki page — explorations should compound in the wiki, not disappear into chat history

### Lint

When asked to health-check the wiki (or triggered by a scheduled task):

- Contradictions between pages
- Stale claims superseded by newer sources
- Orphan pages with no inbound links
- Important concepts that lack dedicated pages
- Missing cross-references
- Data gaps — suggest sources to pursue

Report findings and offer to fix issues.

## Conventions

- Markdown with YAML frontmatter (`date_created`, `last_updated`, `sources`, `tags`)
- Link between pages with relative markdown links: `[Page Title](page-title.md)`
- One entity or concept per page — split pages over ~500 lines
- `index.md`: organized by category, each entry is `- [Page Title](path.md) — one-line summary`
- `log.md`: append-only, each entry starts with `## [YYYY-MM-DD] <operation> | <description>`

These are defaults. Adapt the structure to the domain — the user's wiki, their conventions.
