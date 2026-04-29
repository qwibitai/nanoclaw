---
name: lore-context
description: Use Lore Context for cross-session semantic memory. Search past conversations, store important insights, and maintain persistent context across sessions.
allowed-tools: Bash(mcp__lore-context__*)
---

# Lore Context — Semantic Memory

You have access to Lore Context, a semantic memory system that persists across sessions. Use it to remember important information, search past context, and maintain continuity for the user.

## When to use Lore Context

### Search (memory_search, context_query)
- User references something from a past conversation
- User asks "what did we decide about X?" or "remember when we..."
- You need context about a project, person, or decision before responding
- Starting a new session and want to recall relevant context

### Write (memory_write)
- User makes an important decision
- You learn a new preference or recurring pattern
- An architectural choice is made
- A bug or issue is discovered and resolved
- A workflow or process is established
- Any information that will be useful in future sessions

### Update (memory_update, memory_supersede)
- A previously stored fact has changed
- A decision is reversed or updated
- Information needs correction

## How to use

### Searching for context

Before answering questions that might reference past work, search Lore:

```
memory_search(query: "database migration decisions")
memory_search(query: "user preferences for code style")
context_query(query: "what was the architecture for the auth system?")
```

Search is semantic — use natural language, not keywords. The results include relevance scores and source information.

### Storing memories

After important interactions, write memories:

```
memory_write(
  content: "The team decided to use PostgreSQL for the main database instead of MongoDB, citing better support for complex queries and ACID compliance.",
  memory_type: "architecture",
  scope: "project",
  project_id: "nanoclaw"
)
```

Memory types:
- `pattern` — recurring code patterns, conventions
- `preference` — user or team preferences
- `architecture` — system design decisions
- `bug` — known issues and their fixes
- `workflow` — processes and procedures
- `fact` — general knowledge, context

Scopes:
- `user` — private to this user
- `project` — shared across the project
- `team` — shared across a team
- `repo` — tied to a specific repository

### Updating memories

When information changes, update rather than duplicate:

```
memory_update(
  memory_id: "<id>",
  content: "Updated: now using Redis for caching instead of Memcached",
  reason: "Architecture changed after performance evaluation"
)
```

Or supersede to create a versioned replacement:

```
memory_supersede(
  memory_id: "<id>",
  content: "New version of the memory",
  reason: "Decision updated based on new requirements"
)
```

### Listing and browsing

```
memory_list(scope: "project", limit: 20)
memory_list(memory_type: "architecture")
```

### Exporting context

Get a summary of all relevant context for a topic:

```
context_query(
  query: "everything we know about the deployment pipeline",
  mode: "memory",
  sources: { memory: true }
)
```

## Best practices

1. **Be specific in writes**: "The user prefers tabs over spaces in Python files" is better than "code style preferences"
2. **Use appropriate types**: Classify memories correctly for better retrieval
3. **Search before writing**: Avoid duplicating existing memories
4. **Supersede, don't delete**: When info changes, supersede the old memory rather than deleting
5. **Scope appropriately**: Don't make personal preferences project-scoped
6. **Include context**: Reference the conversation or situation that generated the memory

## What NOT to store

- Ephemeral information (current weather, today's date)
- Information that belongs in code files or documentation
- Secrets or credentials
- Large data dumps — summarize instead

## Integration with CLAUDE.local.md

Lore Context complements `CLAUDE.local.md`:
- **CLAUDE.local.md**: Quick-access, always-in-context, for the most critical per-turn info
- **Lore Context**: Semantic search across a large corpus of memories, for everything else

Use CLAUDE.local.md for the top 5-10 things you always need. Use Lore for everything else.
