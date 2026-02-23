# Semantic Code Search with grepai

## Overview

[grepai](https://github.com/yoanbernabeu/grepai) adds a semantic search layer for your codebase — search by meaning, not just text. It uses the same embedding model (`nomic-embed-text`) as the memory system, so no additional infrastructure required.

This complements the memory architecture by giving agents **codebase awareness** alongside **conversational memory**.

```
┌─────────────────────────────────────────────────────┐
│              AGENT KNOWLEDGE                         │
│                                                      │
│   Memory (what happened)    Code (what exists)       │
│   ┌──────────────────┐     ┌──────────────────┐    │
│   │ facts.db         │     │ grepai index     │    │
│   │ MEMORY.md        │     │ (semantic code   │    │
│   │ active-context   │     │  search)         │    │
│   │ daily logs       │     │                  │    │
│   │ QMD/Ollama       │     │ nomic-embed-text │    │
│   └──────────────────┘     └──────────────────┘    │
│                                                      │
│   "What did we decide?"    "Where is auth logic?"   │
│   → facts.db / QMD         → grepai search          │
└─────────────────────────────────────────────────────┘
```

## Why It Matters

AI coding agents (Claude Code, Cursor, etc.) typically ingest your entire codebase to understand it — burning tokens. grepai lets them search semantically first, loading only the relevant files.

| Approach | Tokens Used | Quality |
|----------|-------------|---------|
| Load entire codebase | ~500K+ | Everything available but expensive |
| `grep` for patterns | Minimal | Misses semantically related code |
| `grepai search` | Minimal | Finds code by meaning |

Example: `grepai search "authentication middleware"` finds `src/middleware.ts` and `src/auth.ts` even if neither file contains the word "authentication."

## Installation

```bash
# Linux/macOS
curl -sSL https://raw.githubusercontent.com/yoanbernabeu/grepai/main/install.sh | sh

# macOS (Homebrew)
brew install yoanbernabeu/tap/grepai

# Requires nomic-embed-text (same as memory system)
ollama pull nomic-embed-text
```

## Setup

```bash
cd your-project/
grepai init          # Choose ollama, gob backend
grepai watch &       # Start indexing daemon (runs in background)
grepai status        # Check index health
```

## Usage

### Semantic Search
```bash
# Find code by meaning
grepai search "error handling patterns"
grepai search "database schema definitions"
grepai search "user authentication flow"
grepai search "API routes without auth checks"
```

### Call Graph Tracing
```bash
# Who calls this function?
grepai trace callers "getAgents"

# What does this function call?
grepai trace callees "handleLogin"
```

### AI Agent Integration

grepai includes an MCP server so coding agents can call it as a tool:

```bash
grepai mcp-serve     # Start MCP server
grepai agent-setup   # Configure AI agents
```

## Resource Sharing

grepai uses `nomic-embed-text` — the same model already pinned in VRAM for memory search. No additional VRAM cost. The file watcher daemon uses minimal CPU/memory.

## When to Use What

| Question | Tool |
|----------|------|
| "What's Alice's birthday?" | `facts.db` |
| "What did we decide about the database?" | `facts.db` / `memory_search` |
| "What happened last Tuesday?" | `memory_search` (QMD/Ollama) |
| "Where is the auth middleware?" | `grepai search` |
| "Who calls getAgents()?" | `grepai trace callers` |
| "Find all error handling code" | `grepai search` |
