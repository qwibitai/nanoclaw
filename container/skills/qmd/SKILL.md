---
name: qmd
description: Search past conversations and documentation. Use when users ask about things mentioned before, past discussions, or need context from history.
allowed-tools: Bash(npx qmd:*), Grep, Glob, Read
---

# QMD - Conversation Search

Search past conversations and documentation in the groups directory.

## MCP Tools (Preferred)

QMD MCP server runs on the host at `http://host.docker.internal:8182/mcp`.

Available tools:
- `mcp__qmd__query` - Search with lex/vec/hyde queries
- `mcp__qmd__get` - Retrieve document by path or docid
- `mcp__qmd__multi_get` - Batch retrieve by glob pattern
- `mcp__qmd__status` - Check index health

Example query:
```json
{
  "searches": [
    { "type": "lex", "query": "search term" },
    { "type": "vec", "query": "natural language question" }
  ],
  "collections": ["telegram_main"],
  "limit": 10
}
```

## CLI Fallback

If MCP tools are unavailable, use the QMD CLI directly:

```bash
# Keyword search
npx qmd search "search term" -c telegram_main

# Semantic search (requires embeddings)
npx qmd vsearch "natural language question" -c telegram_main

# Hybrid search with reranking (best quality)
npx qmd query "question" -c telegram_main
```

## Fallback: Direct File Search

If QMD isn't available at all, search conversation files directly:

```bash
# Find conversations containing a term
grep -r "term" /workspace/group/conversations/

# List recent conversations
ls -lt /workspace/group/conversations/ | head -10
```

## Conversation Files Location

- Conversations: `/workspace/group/conversations/*.md`
- Documentation: `/workspace/group/docs/*.md`
- Group memory: `/workspace/group/CLAUDE.md`

## When to Use

- User asks "what did we discuss about X"
- User mentions something from a past conversation
- Need context from previous sessions
- Looking up decisions or preferences mentioned before
