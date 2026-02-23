# Context Graph Learning Loop

Self-evolving execution through mandatory precedent lookup and pattern extraction.

## Core Loop

```
Query → Decide → Store Trace → Verify → Update Outcome
```

## Mandatory Rules

| When | Action |
|------|--------|
| Before any architecture/implementation decision | `context_query_traces` FIRST |
| After any non-trivial failure→fix | `context_store_trace` |
| After verification of fix | `context_update_outcome` |

## Trust Threshold

| Score | Action |
|-------|--------|
| > 0.75 | Use precedent without re-evaluation |
| 0.60-0.75 | Use precedent but verify |
| < 0.60 | New decision |

## Categories

- `troubleshooting`: Error patterns and fixes
- `workflow`: Routing/delegation decisions
- `architecture`: Design choices
- `api`: Integration patterns
- `testing`: Test strategies
- `deployment`: Deploy workflows

## Pattern Detection

```
3+ occurrences → generate draft rule in memory/
5+ validated → auto-promote trigger
```

## Anti-patterns

- Don't query traces AFTER making decision (query BEFORE)
- Don't store trivial edits (typos, .md)
- Don't skip verification before updating to success
- Don't auto-edit CLAUDE.md - only add trigger pointers to existing structure
