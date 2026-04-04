---
name: add-lancedb-memory
description: Add semantic memory to container agents using LanceDB + configurable embeddings (Gemini, Jina, OpenAI, Ollama). Hybrid retrieval with BM25, cross-encoder reranking, and recency boost. Agents get 4 MCP tools (memory_store, memory_search, memory_delete, memory_count) for persistent vector-based recall across sessions.
---

# Add Semantic Memory (LanceDB + Hybrid Retrieval)

This skill adds persistent semantic memory to container agents via 4 MCP tools. Uses memory-lancedb-pro for hybrid retrieval (vector + BM25), cross-encoder reranking, recency boost, and noise filtering.

Tools added:
- `memory_store` — store a memory with category and importance
- `memory_search` — search by semantic similarity (natural language)
- `memory_delete` — delete a memory by ID
- `memory_count` — count total stored memories

## Embedding Providers

Set `EMBEDDING_PROVIDER` in `.env` (default: `gemini`):

| Provider | Model | Dimensions | API Key Env |
|----------|-------|------------|-------------|
| `gemini` (default) | gemini-embedding-001 | 3072 | `GEMINI_API_KEY` |
| `jina` | jina-embeddings-v5-text-small | 1024 | `JINA_API_KEY` |
| `openai` | text-embedding-3-small | 1536 | `OPENAI_API_KEY` |
| `ollama` | nomic-embed-text | 768 | — (local) |
| `custom` | (set `EMBEDDING_MODEL`) | (set `EMBEDDING_DIM`) | `EMBEDDING_API_KEY` |

> **Note:** When using Ollama, set `EMBEDDING_DIM` explicitly if you change the model — dimensions vary by model and there is no auto-detection.

Override any default with `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`, `EMBEDDING_DIM`, `EMBEDDING_API_KEY`.

## Rerank Providers (optional)

Set `RERANK_PROVIDER` in `.env` to enable cross-encoder reranking:

| Provider | Model | API Key Env |
|----------|-------|-------------|
| `jina` | jina-reranker-v3 | `JINA_API_KEY` |
| `siliconflow` | BAAI/bge-reranker-v2-m3 | `SILICONFLOW_API_KEY` |
| `voyage` | rerank-2.5 | `VOYAGE_API_KEY` |
| `pinecone` | bge-reranker-v2-m3 | `PINECONE_API_KEY` |
| `vllm` | BAAI/bge-reranker-v2-m3 | — (local, default endpoint: `http://localhost:8000/v1/rerank`) |
| `none` | — | — |

Reranking is **disabled by default** (`RERANK_PROVIDER` is unset). Without a rerank provider, the system falls back to lightweight cosine similarity ranking.

Override with `RERANK_MODEL`, `RERANK_ENDPOINT`, `RERANK_API_KEY`.

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/memory-store.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

An embedding API key is required (unless using Ollama). Ask the user which provider they prefer and whether they have an API key.

AskUserQuestion: Which embedding provider would you like to use? (gemini, jina, openai, ollama, or custom) Do you have an API key, or do you need to get one?

For Gemini (default, free tier):
> Get a free Gemini API key at https://aistudio.google.com/apikey — 1,500 requests/day for embedding.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream feat/memory-lancedb-pro
git merge upstream/feat/memory-lancedb-pro || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `container/agent-runner/src/memory.ts` — public API and provider config
- `container/agent-runner/src/memory-store.ts` — LanceDB storage layer
- `container/agent-runner/src/memory-retriever.ts` — hybrid retrieval pipeline
- `container/agent-runner/src/memory-embedder.ts` — OpenAI-compatible embedding with chunking and key rotation
- `container/agent-runner/src/memory-chunker.ts` — smart document chunking
- `container/agent-runner/src/memory-access-tracker.ts` — reinforcement-based time decay
- `container/agent-runner/src/memory-noise-filter.ts` — trivial content filtering
- `container/agent-runner/src/memory-query-expander.ts` — query expansion stub
- Memory MCP tools in `container/agent-runner/src/ipc-mcp-stdio.ts`
- All embedding/rerank env var passthrough in `src/container-runner.ts`
- `scripts/migrate-memories.mjs` — migration tool for OpenClaw backups

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
./container/build.sh
```

All builds must be clean before proceeding.

## Phase 3: Configure

### Set embedding provider

Add to `.env` (example for Gemini, the default):

```bash
EMBEDDING_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-api-key-here
```

For Jina:
```bash
EMBEDDING_PROVIDER=jina
JINA_API_KEY=your-jina-api-key-here
```

For Ollama (local, no API key needed):
```bash
EMBEDDING_PROVIDER=ollama
```

### Set rerank provider (optional)

```bash
RERANK_PROVIDER=jina
JINA_API_KEY=your-jina-api-key-here  # shared with embedding if using Jina for both
```

### LanceDB Cloud (optional)

By default, memories are stored locally in each group's workspace at `/workspace/group/memory/lancedb`. To override the local path, set `MEMORY_LANCEDB_DIR`. For cloud storage, add:

```bash
LANCEDB_URI=db://your-database
LANCEDB_API_KEY=your-lancedb-api-key
```

### Restart the service

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
# Or:
./scripts/rebuild.sh
```

## Phase 4: Verify

### Test via messaging

Tell the user:

> Send a message like: "Remember that my favorite language is TypeScript"
>
> Then in a later message: "What's my favorite language?"
>
> The agent should use `memory_store` to save the fact, and `memory_search` to retrieve it.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i memory
```

Look for:
- `memory_store` / `memory_search` in container logs — agent used memory tools
- Embedding or API key errors — key not set or invalid

## Troubleshooting

### Embedding API key not set

The key isn't reaching the container. Verify:
1. `.env` has the correct `*_API_KEY` for your provider
2. Service was restarted after changing `.env`
3. Check `src/container-runner.ts` passes the env var (all standard providers are pre-configured)

### Embedding failed (400/context length)

Text exceeds the model's context limit. The embedder auto-chunks long documents, but if chunking also fails, truncate or summarize the text first.

### Memories not persisting across sessions

Each group stores memories in its own workspace. If the group folder is deleted or recreated, memories are lost. For persistent storage across reinstalls, use LanceDB Cloud (`LANCEDB_URI`).

### Agent doesn't use memory tools

The agent may not know about the tools. Try being explicit: "use the memory_store tool to remember that..." or check that the MCP server is registered in the container's agent-runner.

## Migration

To import memories from an OpenClaw JSONL backup:

```bash
EMBEDDING_API_KEY=your-key node scripts/migrate-memories.mjs path/to/backup.jsonl /path/to/lancedb-dir
```

Supports `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL` env vars to use any provider. Streams records in batches to handle large backups.

## Removal

To remove semantic memory:

1. Remove `memory*.ts` files from `container/agent-runner/src/`
2. Remove memory tool registrations from `container/agent-runner/src/ipc-mcp-stdio.ts`
3. Remove `@lancedb/lancedb`, `apache-arrow`, `openai` from `container/agent-runner/package.json`
4. Remove embedding/rerank env var passthrough from `src/container-runner.ts`
5. Remove env vars from `.env`
6. Rebuild: `npm run build && ./container/build.sh`
7. Restart service
