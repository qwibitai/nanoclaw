---
description: File format choice - JSONL append-only nature prevents catastrophic data overwrites by AI agents
topics: [data-storage, architecture, safety]
created: 2026-02-24
---

# JSONL format prevents agent data loss through append-only design

JSONL (JSON Lines) is superior to JSON for AI agent systems because of its append-only nature.

**Problem with JSON:**
- Agents write entire file at once
- One mistake = lost historical data
- Example: Agent rewrites entire file, loses 3 months of contact history

**JSONL advantages:**
- One JSON object per line
- Agent can only add lines (append-only)
- Stream-friendly (read line-by-line without parsing entire file)
- Every line is self-contained, valid JSON
- Deletion is done via status flags: `"status": "archived"`

**Format-function mapping:**
- **JSONL** for logs (contacts, interactions, posts, decisions, failures)
- **YAML** for config (hierarchical data, supports comments, human-readable)
- **Markdown** for narrative (LLM-native, renders everywhere, clean Git diffs)

**Schema pattern:**
Start each JSONL file with schema line:
```json
{"_schema": "contact", "_version": "1.0", "_description": "..."}
```

Agent always knows structure before reading data.

**Key principle:** Append-only is non-negotiable for agent safety.

## Related Notes
- [[Progressive disclosure uses three-level architecture for AI context]]

---
*Topics: [[data-storage]] · [[architecture]] · [[safety]]*
