# OpenClaw Memory Architecture

A multi-layered memory system for OpenClaw agents that combines structured storage, semantic search, and cognitive patterns to give your agent persistent, reliable memory.

**The problem:** AI agents wake up fresh every session. Context compression eats older messages mid-conversation. Your agent forgets what you told it yesterday.

**The solution:** Don't rely on one approach. Use the right memory layer for each type of recall.

## Why Not Just Vector Search?

Vector search (embeddings) is great for fuzzy recall — *"what were we talking about regarding infrastructure?"* — but it's overkill for 80% of what a personal assistant actually needs:

- "What's my daughter's birthday?" → **Structured lookup** (instant, exact)
- "What did we decide about the database?" → **Decision fact** (instant, exact)
- "What happened last week with the deployment?" → **Semantic search** (fuzzy, slower)

This architecture uses **each tool where it's strongest**.

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                  SESSION CONTEXT                      │
│            (~200K token window)                        │
├──────────────────────────────────────────────────────┤
│                                                       │
│  ┌────────────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ active-context │  │ MEMORY   │  │   USER.md    │ │
│  │ .md            │  │ .md      │  │              │ │
│  │ Working memory │  │ Curated  │  │  Who your    │ │
│  │ What's hot NOW │  │ wisdom   │  │  human is    │ │
│  └───────┬────────┘  └────┬─────┘  └──────────────┘ │
│          │                │                           │
│  ┌───────┴────────────────┴────────────────────────┐ │
│  │        KNOWLEDGE GRAPH (SQLite + FTS5)           │ │
│  │   facts.db + relations + aliases                 │ │
│  │   Activation scoring + decay (Hot/Warm/Cool)     │ │
│  └───────┬────────────────┬────────────────────────┘ │
│          │                │                           │
│  ┌───────┴────────────────┴────────────────────────┐ │
│  │            SEMANTIC SEARCH                       │ │
│  │   QMD (reranking) / llama.cpp GPU (768d)        │ │
│  │   Multilingual: 100+ languages                   │ │
│  └────────────────────────────────────────────────┘ │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │       DOMAIN RAG (Integration Coaching)           │ │
│  │   Ebooks RAG — 4,361 chunks, 27 documents         │ │
│  └──────────────────────────────────────────────────┘ │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │           PROJECT MEMORY                          │ │
│  │  memory/project-{slug}.md per project             │ │
│  └──────────────────────────────────────────────────┘ │
│                                                       │
├──────────────────────────────────────────────────────┤
│              PLUGIN LAYERS (10–12)                    │
├──────────────────────────────────────────────────────┤
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │         CONTINUITY PLUGIN                         │ │
│  │  Cross-session archive (sqlite-vec, 768d)         │ │
│  │  Topic tracking, continuity anchors               │ │
│  └──────────────────────────────────────────────────┘ │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │         STABILITY PLUGIN                          │ │
│  │  Entropy monitoring, principle alignment          │ │
│  │  Loop detection, confabulation guards             │ │
│  └──────────────────────────────────────────────────┘ │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │         GRAPH-MEMORY PLUGIN                       │ │
│  │  Entity extraction, [GRAPH MEMORY] injection      │ │
│  │  Zero API cost, ~2s latency                       │ │
│  └──────────────────────────────────────────────────┘ │
│                                                       │
└──────────────────────────────────────────────────────┘
```

## Layers Quick Reference

| Layer | System | Purpose | Latency |
|-------|--------|---------|---------|
| 1 | Always-loaded files | Identity, working memory | 0ms (injected) |
| 2 | MEMORY.md | Curated long-term wisdom | 0ms (injected) |
| 3 | project-{slug}.md | Cross-agent institutional knowledge | 0ms (injected) |
| 4 | facts.db | Structured entity/key/value | <1ms (SQLite) |
| 5 | Semantic search | Fuzzy recall, document search | 7ms (GPU) |
| 5a | Ebooks RAG | Domain-specific integration content | ~100ms |
| 6 | Daily logs | Raw session history | On demand |
| 7 | tools-*.md | Procedural runbooks | On demand |
| 8 | gating-policies.md | Failure prevention rules | On demand |
| 9 | checkpoints/ | Pre-flight state saves | On demand |
| 10 | Continuity plugin | Cross-session conversation | Runtime |
| 11 | Stability plugin | Behavioral monitoring | Runtime |
| 12 | Graph-memory plugin | Entity injection | Runtime |

## Key Features

### Multilingual Embeddings
- **Model:** nomic-embed-text-v2-moe (768d)
- **Languages:** 100+ including German
- **Latency:** ~7ms on GPU
- **Setup:** llama.cpp Docker container with ROCm

### Knowledge Graph
- **Scale:** 3,108 facts, 1,009 relations, 275 aliases
- **Decay system:** Hot/Warm/Cool tiers, daily cron
- **Benchmark:** 100% recall (60/60 queries)

### Domain RAG
- **Content:** 5-MeO-DMT integration guides, blog posts
- **Scale:** 4,361 chunks, 27 documents
- **Cron:** Weekly reindex

### Runtime Plugins
- **Continuity:** Cross-session memory, topic tracking
- **Stability:** Entropy monitoring, principle alignment
- **Graph-memory:** Automatic entity injection

## Embedding Options

| Provider | Cost | Latency | Dims | Quality | Notes |
|----------|------|---------|------|---------|-------|
| **llama.cpp (GPU)** | Free | **4ms** | 768 | Best | Multilingual, local |
| **Ollama nomic-embed-text** | Free | 61ms | 768 | Good | `ollama pull nomic-embed-text` |
| **ONNX MiniLM-L6-v2** | Free | 240ms | 384 | Fair | Built into continuity plugin |
| **QMD (built-in)** | Free | ~4s | — | Best (reranked) | OpenClaw native |
| **OpenAI** | ~$0.02/M | ~200ms | 1536 | Great | Cloud API |

**Recommendation:** llama.cpp for speed and multilingual support. QMD for best quality when latency is acceptable.

## Quick Start

### 1. Directory Structure

```bash
mkdir -p memory/checkpoints memory/runbooks
```

### 2. Initialize facts.db

```bash
python3 scripts/init-facts-db.py
```

### 3. Seed Facts

```bash
python3 scripts/seed-facts.py
```

### 4. Configure Embeddings

For llama.cpp GPU (recommended):

```yaml
# docker-compose.yml for dedicated embedding server
services:
  llama-embed:
    image: ghcr.io/ggml-org/llama.cpp:server
    container_name: llama-embed
    restart: unless-stopped
    ports:
      - "8082:8080"
    volumes:
      - ./models:/models:ro
    command: >
      llama-server
        -m /models/nomic-embed-text-v2-moe.Q6_K.gguf
        --embedding
        --pooling mean
        -c 2048
        -ngl 999
        --host 0.0.0.0
        --port 8080
```

### 5. Enable Plugins

```bash
cd ~/.openclaw/extensions
git clone https://github.com/CoderofTheWest/openclaw-plugin-continuity.git
git clone https://github.com/CoderofTheWest/openclaw-plugin-stability.git
git clone https://github.com/CoderofTheWest/openclaw-plugin-graph-memory.git

# Install dependencies
for d in openclaw-plugin-*; do cd "$d" && npm install && cd ..; done
```

Enable in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["continuity", "stability", "graph-memory", "telegram", "discord"],
    "entries": {
      "continuity": { "enabled": true },
      "stability": { "enabled": true },
      "graph-memory": { "enabled": true }
    }
  }
}
```

### 6. Schedule Decay Cron

```bash
(crontab -l 2>/dev/null; echo "0 3 * * * python3 ~/clawd/scripts/graph-decay.py >> /tmp/openclaw/graph-decay.log 2>&1") | crontab -
```

## Reference Hardware

| Component | Spec |
|-----------|------|
| CPU | AMD Ryzen AI MAX+ 395 — 16c/32t |
| RAM | 32GB DDR5 (unified with GPU) |
| GPU | AMD Radeon 8060S — 96GB unified VRAM |
| Storage | 1.9TB NVMe |

The 96GB unified VRAM enables running large models without swapping. Smaller setups (8-16GB) work fine — just use llama.cpp alone without QMD.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Full layer documentation
- [`docs/knowledge-graph.md`](docs/knowledge-graph.md) — Graph search, benchmarks
- [`docs/context-optimization.md`](docs/context-optimization.md) — Token trimming methodology
- [`CHANGELOG.md`](CHANGELOG.md) — Version history

## Credits

This architecture was informed by:
- **David Badre** — *On Task: How the Brain Gets Things Done*
- **Shawn Harris** — [Building a Cognitive Architecture for Your OpenClaw Agent](https://shawnharris.com/building-a-cognitive-architecture-for-your-openclaw-agent/) — Memory gating, active-context patterns, gating policies
- **r/openclaw community** — [How I Built a Memory System That Actually Works](https://old.reddit.com/r/openclaw/comments/1r7nd4y/how_i_built_a_memory_system_that_actually_works/) — Hybrid search benchmarking
- **CoderofTheWest** — Continuity, stability, and metabolism plugins

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

MIT — use it, adapt it, share what you learn.