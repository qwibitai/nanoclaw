---
description: Data architecture - flat-file relational model allows AI to join data across modules without database
topics: [architecture, data-storage, knowledge-management]
created: 2026-02-24
---

# Cross-module references enable knowledge graph traversal without loading entire system

Modules should be isolated for loading, but connected for reasoning.

**Flat-file relational model:**
- `contact_id` in interactions.jsonl points to entries in contacts.jsonl
- `pillar` in ideas.jsonl maps to content pillars in identity/brand.md
- Bookmarks feed content ideas
- Post metrics feed weekly reviews

**Example workflow: "Prepare for meeting with Sarah"**
Agent traverses references:
1. Find Sarah in contacts.jsonl
2. Pull interactions.jsonl filtered by contact_id
3. Check todos.md for pending items involving Sarah
4. Compile one-page brief with relationship context

**Key insight:**
- Isolation without connection = pile of folders
- Cross-references = knowledge graph agent can navigate
- Agent follows references across modules without loading entire system

**Implementation:**
- Consistent ID scheme across files (e.g., contact_id, post_id)
- Foreign key pattern in JSONL logs
- Agent can JOIN data like SQL but with files

**Benefits:**
- No database required
- Git-versionable
- Human-readable
- Agent can reason across domains

## Related Notes
- [[JSONL format prevents agent data loss through append-only design]]
- [[Progressive disclosure uses three-level architecture for AI context]]

---
*Topics: [[architecture]] · [[data-storage]] · [[knowledge-management]]*
