# feat: MemOS persistent memory backend (opt-in skill)

## Summary

This proposes an opt-in `/add-memos` skill that integrates self-hosted [MemOS](https://memos.openmem.net) ([GitHub](https://github.com/MemTensor/MemOS)) as a persistent memory backend for NanoClaw agents. MemOS is an open-source Memory Operating System for LLMs and AI agents that provides semantic search, automatic deduplication, and memory evolution.

The integration is entirely opt-in — when `MEMOS_API_URL` is not configured, NanoClaw automatically reverts to its default behavior. When `MEMOS_API_URL` _is_ configured, new memories are stored in MemOS and not the default database/files.

## What MemOS adds beyond NanoClaw's existing memory

NanoClaw already has solid memory foundations with SQLite for message history and CLAUDE.md for agent notes. MemOS complements these with capabilities that are difficult to achieve with keyword search and flat files alone:

- **Semantic similarity search** — Vector-based retrieval via Qdrant finds conceptually related memories, not just keyword matches. Ask about "deployment issues" and it surfaces memories about "prod server problems" or "container networking" even if those exact words weren't used.
- **Memory evolution and auto-dedup** — MemOS automatically merges and evolves related memories over time. Near-identical entries are deduplicated without manual consolidation. Memories grow more refined with use rather than accumulating noise.
- **Graph-based knowledge** — Neo4j stores entity relationships (who/what/where/when), enabling structured queries across the memory graph.
- **Multiple memory types** — Text, tree (hierarchical), vector, and graph memory — each optimized for different retrieval patterns.
- **Memory correction** — Natural language feedback to refine, correct, or supplement existing memories over time.
- **Async ingestion** — Millisecond-level latency, production-stable under concurrency.

## How it works

The integration has two layers:

### Host-side (orchestrator)
- **Auto-recall**: Before each agent invocation, searches MemOS using the latest user message and injects relevant memories into the prompt as context.
- **Auto-capture**: After the agent finishes (including idle timeout / SIGKILL), stores the full user-assistant exchange as a memory. Fire-and-forget — never blocks response delivery.

### Container-side (agent)
Agents get three MCP tools via a stdio server:
- `search_memories(query)` — Semantic search across all stored memories
- `add_memory(content)` — Explicitly store information for future recall
- `chat(query)` — Natural language synthesis from relevant memories

When MemOS is active, Claude's built-in auto-memory is disabled to avoid duplicate capture.

## MemOS infrastructure

MemOS runs as a self-hosted Docker stack with 5 services:

| Service | Role |
|---------|------|
| `memos-api` | Core API server (memory operations, LLM orchestration) |
| `memos-mcp` | MCP protocol server |
| `neo4j` | Graph database (entity relationships) |
| `qdrant` | Vector database (semantic similarity search) |
| `caddy` | Reverse proxy with automatic TLS termination and authentication |

**Embeddings API (external)**
MemOS requires an OpenAI-compatible API to generate embeddings for semantic search. This is an external dependency — not part of the Docker stack. Any compatible provider works; [OpenRouter](https://openrouter.ai) supports many embedding models without requiring a direct OpenAI account. Configured via `OPENAI_API_KEY` and `OPENAI_BASE_URL` in the MemOS stack environment.

### Storage backends
Our reference implementation uses Neo4j (graph) + Qdrant (vector), which provides the richest feature set. MemOS also supports a lighter local plugin with SQLite + FTS5 + vector search for users who don't need graph capabilities, as well as S3 and filesystem backends.

### Reverse proxy
We selected **Caddy** for its automatic SSL/TLS certificate management and simple configuration. This is important because basic auth credentials travel in plaintext without TLS — Caddy encrypts them on the wire with zero additional configuration. Users can substitute Nginx, Traefik, HAProxy, or any other reverse proxy depending on their existing infrastructure.

### Hardware requirements
The full stack runs comfortably on a Raspberry Pi 4 (8GB RAM, ARM64). No GPU required.

## Relationship to #907

The learning system epic (#907) takes a thoughtful file-based approach with USER.md, MEMORY.md, FTS5 search, and agent-driven consolidation. That design is simple, needs no extra infrastructure, and covers many use cases well.

MemOS is a complementary option for users who want richer semantic memory capabilities — vector search, automatic deduplication, graph-based knowledge, and memory evolution. Both approaches are valid for different needs, and they could potentially coexist (MemOS disables only Claude's auto-memory when active, not the file-based system).

This is not intended to replace #907's work, just to offer the community an alternative for those who are willing to run additional infrastructure in exchange for more powerful memory features.

## Scope

- **3 new files**: `src/memos-client.ts` (API client), `container/agent-runner/src/memos-mcp-stdio.ts` (MCP server), `scripts/migrate-memories-to-memos.ts` (migration tool)
- **5 modified files**: `src/config.ts`, `src/index.ts`, `src/container-runner.ts`, `container/agent-runner/src/index.ts`, `.env.example`
- **No new npm dependencies** — uses Node's built-in `fetch`, plus existing `@modelcontextprotocol/sdk` and `zod`
- **Graceful degradation** — every MemOS call checks for configuration and returns empty/false when unconfigured



## Links

- [MemOS website](https://memos.openmem.net)
- [MemOS GitHub](https://github.com/MemTensor/MemOS)
