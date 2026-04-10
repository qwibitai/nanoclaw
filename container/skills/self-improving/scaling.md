# Scaling Patterns

## Volume Thresholds

| Scale | Entries | Strategy |
|-------|---------|----------|
| Small | <100 | Single memory.md, no namespacing |
| Medium | 100-500 | Split into domains/, basic indexing |
| Large | 500-2000 | Full namespace hierarchy, aggressive compaction |
| Massive | >2000 | Archive yearly, summary-only HOT tier |

## When to Split

Create new namespace file when:
- Single file exceeds 200 lines
- Topic has 10+ distinct corrections
- User explicitly separates contexts ("for work...", "in this project...")

## Compaction Rules

### Merge Similar Corrections
```
BEFORE (3 entries):
- [02-01] Use tabs not spaces
- [02-03] Indent with tabs
- [02-05] Tab indentation please

AFTER (1 entry):
- Indentation: tabs (confirmed 3x, 02-01 to 02-05)
```

### Summarize Verbose Patterns
```
BEFORE:
- When writing emails to Marcus, use bullet points, keep under 5 items,
  no jargon, bottom-line first, he prefers morning sends

AFTER:
- Marcus emails: bullets ≤5, no jargon, BLUF, AM preferred
```

### Archive with Context
When moving to COLD:
```
## Archived 2026-02

### Project: old-app (inactive since 2025-08)
- Used Vue 2 patterns
- Preferred Vuex over Pinia
- CI on Jenkins (deprecated)

Reason: Project completed, patterns unlikely to apply
```

## Index Maintenance

`index.md` tracks all namespaces:
```markdown
# Memory Index

## HOT (always loaded)
- memory.md: 87 lines, updated 2026-02-15

## WARM (load on match)
- projects/current-app.md: 45 lines
- projects/side-project.md: 23 lines
- domains/code.md: 112 lines
- domains/writing.md: 34 lines

## COLD (archive)
- archive/2025.md: 234 lines
- archive/2024.md: 189 lines

Last compaction: 2026-02-01
Next scheduled: 2026-03-01
```

## Multi-Project Patterns

### Inheritance Chain
```
global (memory.md)
  └── domain (domains/code.md)
       └── project (projects/app.md)
```

### Override Syntax
In project file:
```markdown
## Overrides
- indentation: spaces (overrides global tabs)
- Reason: Project eslint config requires spaces
```

### Conflict Detection
When loading, check for conflicts:
1. Build inheritance chain
2. Detect contradictions
3. Most specific wins
4. Log conflict for later review

## User Type Adaptations

| User Type | Memory Strategy |
|-----------|-----------------|
| Power user | Aggressive learning, minimal confirmation |
| Casual | Conservative learning, frequent confirmation |
| Team shared | Per-user namespaces, shared project space |
| Privacy-focused | Local-only, explicit consent per category |

## Recovery Patterns

### Context Lost
If agent loses context mid-session:
1. Re-read memory.md
2. Check index.md for relevant namespaces
3. Load active project namespace
4. Continue with restored patterns

### Corruption Recovery
If memory file corrupted:
1. Check archive/ for recent backup
2. Rebuild from corrections.md
3. Ask user to re-confirm critical preferences
4. Log incident for debugging
