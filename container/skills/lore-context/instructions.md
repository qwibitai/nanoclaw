## Lore Context — Cross-Session Memory

You have access to **Lore Context** MCP tools for semantic memory that persists across all sessions in this agent group. These complement `CLAUDE.local.md` (quick-access, always-in-context) with searchable semantic memory.

### When to search

Search Lore **before answering** when the user:
- References past conversations ("remember when we...", "what did we decide about...")
- Asks about a project, person, or decision you may have seen before
- Starts a task that might benefit from prior context

```
memory_search(query: "natural language description of what you're looking for")
```

### When to write

Store memories **after important interactions**:
- Decisions made (architecture, tool choices, approaches)
- User preferences (code style, communication preferences)
- Recurring patterns or conventions
- Bug discoveries and their fixes
- Workflow and process descriptions

```
memory_write(content: "specific, actionable memory", memory_type: "architecture|preference|pattern|bug|workflow|fact", scope: "project|user|team")
```

### When to update

If stored information has changed:
```
memory_update(memory_id: "<id>", content: "updated info", reason: "why it changed")
```

### How it differs from CLAUDE.local.md

- **CLAUDE.local.md**: Top 5-10 critical items, always in context window, fast access
- **Lore Context**: Large corpus of memories, semantic search, cross-session persistence

Use CLAUDE.local.md for what you always need. Use Lore for everything else.
