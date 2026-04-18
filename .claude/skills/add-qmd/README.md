# QMD for NanoClaw

[QMD](https://github.com/tobilu/qmd) (Query Markdown Documents) provides semantic search across NanoClaw's group conversations and documentation.

## What It Does

- **Keyword search** (BM25) — exact term matching, fast, no LLM needed
- **Vector search** — natural language queries, finds conceptually related content
- **Hybrid search** — combines both with reranking, best quality

The agent inside each container accesses QMD via MCP tools (`mcp__qmd__query`, `mcp__qmd__get`, etc.). The MCP server runs on the host; containers connect over HTTP.

## Default Behavior

- Each group gets its own QMD **collection** — a named index of markdown files
- Collections are isolated: the agent in group A cannot search group B's conversations
- Embeddings are generated locally on the host CPU using `embeddinggemma-300M` (~2GB download)
- A daily cron job re-indexes to pick up new conversations

## Isolation & NanoClaw

NanoClaw's security model isolates groups at multiple levels:

| Layer | Isolation | QMD Impact |
|-------|-----------|------------|
| Filesystem | Each group has its own `groups/` directory | Collections are per-directory, naturally isolated |
| Container | Each group spawns its own container | MCP config is shared via agent-runner, but collections are scoped |
| Session | Each group has its own `data/sessions/` dir | Not relevant — QMD runs on the host |

**Cross-group search is possible** but requires explicit configuration. You can add another group's path to a collection:

```bash
~/.local/node_modules/@tobilu/qmd/qmd collection add /path/to/nanoclaw/groups/other_group --name other_group
```

Think through whether cross-group access is appropriate for your use case — some groups may contain private or sensitive conversations that shouldn't be searchable from other groups.

## What's Indexed

QMD indexes all `*.md` files in the collection path. For a typical NanoClaw group this includes:

- `conversations/*.md` — chat history
- `docs/*.md` — documentation
- `CLAUDE.md` — group memory
- Any other markdown files in the group directory

## Limitations

- **Markdown only** — QMD indexes `.md` files. Other file types (PDFs, images, code files) are not searchable unless converted to markdown first
- **CPU embeddings** — runs on CPU by default. Initial indexing of large collections can take several minutes. Incremental updates are fast
- **Local only** — QMD runs on the host machine. It's not a cloud service. The agent can only search conversations that exist on this machine
- **Stale index** — if the cron job fails or embeddings aren't regenerated, new conversations won't appear in search results. Check with `qmd status`
- **Model quality** — uses a 300M parameter embedding model. Good for general semantic search, may miss very niche or technical queries

## Models Used

| Purpose | Model | Size |
|---------|-------|------|
| Embedding | `embeddinggemma-300M-Q8_0` | ~300MB (downloaded automatically) |
| Reranking | `qwen3-reranker-0.6b-q8_0` | ~600MB (downloaded automatically) |
| Query expansion | `Qwen3-0.6B-Q8_0` | ~600MB (downloaded automatically) |

All models run locally. No API keys or cloud services required.
