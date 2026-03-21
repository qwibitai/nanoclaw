# Knowledge Base Skill Design

## Overview

A personal knowledge base managed by the NanoClaw agent through chat. The agent captures, retrieves, and helps review notes across categories like AI agents, reflections, connections, resources, and todos.

Implemented as a container skill (instructions only) — no TypeScript code changes, no database changes. The agent uses its existing tools (Read, Write, Edit, Bash+ripgrep).

## Storage Layout

```
groups/global/kb/
  entries/                          # detailed entries with frontmatter
    2026-03-20-john-acme-corp.md
  agents.md                         # AI agent tips & ideas
  reflections.md                    # personal reflections
  connections.md                    # people & contacts
  resources.md                      # links, articles, tools
  todos.md                          # things to do
  review-stats.md                   # review streak, totals
```

**Category files** collect short notes (one-liners, quick thoughts). New categories created on the fly when the user says "save this under [category]".

**Full entries** in `entries/` are for notes that need detail — contacts with multiple fields, resources with extensive commentary, ideas that have been developed. Each gets YAML frontmatter:

```yaml
---
type: contact
title: John from Acme Corp
tags: [kubernetes, devops]
related: []
created: 2026-03-20
source: direct
score: 0
last_reviewed: null
---

John Smith, Senior DevOps Engineer at Acme Corp.
Met at KubeCon 2025. Deep expertise in Kubernetes operators and ArgoCD.
Saved because: potential consultant for infra migration.

Contact: john@acmecorp.com
```

**Quicknote format** within category files:

```markdown
## 2026-03-20 | #prompting #chain-of-thought | [score:0]
Chain-of-thought works better when you ask "think step by step" at the end.
```

## Interaction Model

### Natural language capture

The agent detects KB-worthy information from conversation:

- "remember that John at Acme knows K8s" -> writes to connections.md
- "idea: agents negotiating with each other" -> writes to agents.md
- "save this link about prompt engineering: https://..." -> writes to resources.md
- "todo: review Q1 budget" -> writes to todos.md

### Explicit commands

- `kb save [category]: [content]` — writes directly
- `kb list [category]` — shows entries in a category
- `kb search [query]` — ripgrep across all KB files
- `kb categories` — lists all category files
- `kb review` — triggers on-demand review session

### Both modes coexist

Natural language for frictionless capture/queries. Explicit commands for structured interactions like browsing and reviewing.

## Quality Gate at Capture

1. Pick the category (or ask if unclear)
2. Structure the note (normalize names, add context)
3. Ask one follow-up: "Why does this matter?" — bake the answer into the note
4. Check for duplicates by scanning the target file first
5. Confirm what was saved

## Retrieval

### Explicit

- "what do I know about kubernetes?" -> rg across all KB files
- "who do I know at Acme?" -> search connections.md and entries/
- "show me my agent ideas" -> read agents.md

### Proactive surfacing (judgment-based)

- Quick grep for key topics at the start of processing a message
- Only surface if it genuinely helps the conversation
- Brief inline mention: "(You have a note that John at Acme is a K8s expert — saved March 2026)"
- Never during review sessions or quick back-and-forth

### Implementation

All retrieval is `rg "[query]" /workspace/global/kb/` — no new code needed.

## Gamified Review

### Mechanism

- Scheduled task: daily cron (e.g. 9 AM), sends 3 notes to main group
- Format per note:

  > **Note #1** (agents.md, Mar 20)
  > Chain-of-thought works better when you ask "think step by step" at the end.
  >
  > thumbs-up Keep / thumbs-down Trash / pencil Rewrite

- User replies with emoji or word
- No response = notes go back in unreviewed pool

### Scoring

- Each quicknote gets `[score:0]` inline tag; full entries use frontmatter `score` field
- "Keep" -> score +1, last_reviewed updated
- "Trash" -> entry removed
- "Rewrite" -> agent asks what to change, updates note, score reset to 1
- Proactive surfacing that user engages with -> score +1

### Selection

Oldest `last_reviewed` first (null = never reviewed = highest priority). Systematic coverage of the entire KB.

### Streaks

Tracked in `kb/review-stats.md`: total reviewed, current streak, notes pruned this month. Occasional lightweight nudge: "12-day review streak. KB is 60% reviewed."

## Promotion

When a quicknote grows (user adds context, gets referenced multiple times), agent suggests promoting it to a full entry in `entries/` with proper frontmatter.

## What Gets Built

1. `container/skills/knowledge-base/SKILL.md` — agent instructions for the entire feature
2. `groups/global/kb/` — initial directory structure with empty category files
3. One scheduled task — daily review cron job

## What Does NOT Get Built

- No new TypeScript code
- No database changes
- No MCP server
- No indexer script
- No new container tools

## Migration Path (Phase 2)

When entries exceed ~500 and ripgrep search degrades:

1. Add FTS5 virtual table to existing `messages.db`
2. Write small indexer that parses KB markdown files into the table
3. Update skill instructions to use `sqlite3` for search instead of `rg`

Frontmatter is structured now to make this migration trivial.
