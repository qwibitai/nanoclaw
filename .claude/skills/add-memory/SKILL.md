---
name: add-memory
description: Add three-layer semantic memory system with RAG. Gives agents automatic recall of past conversations and stored facts using sqlite-vec and local embeddings. Triggers on "add memory", "memory system", "semantic memory", "RAG memory", "agent memory".
---

# Add Semantic Memory System

Adds a three-layer memory architecture that gives container agents automatic recall of past conversations and stored facts. Uses sqlite-vec for vector search within the existing SQLite database and local embeddings via @huggingface/transformers (all-MiniLM-L6-v2) — no external API costs.

## Memory Layers

1. **Core Memories** — discrete facts/preferences stored by the agent via IPC, auto-injected into prompts when semantically relevant
2. **Conversation Memory** — every message is embedded after each conversation; relevant past messages retrieved via RAG before each agent invocation
3. **Archival Memory** — session summaries searchable via memory_search

## Agent MCP Tools (via IPC)

Four new IPC operations: `memory_add`, `memory_update`, `memory_remove`, `memory_search` — all operating through the existing IPC filesystem with a request-response pattern for search.

## Phase 1: Pre-flight Checks

Before applying, verify:

1. Node.js >= 18 is installed
2. `npm run build` succeeds on the current codebase
3. No uncommitted changes in `src/db.ts`, `src/index.ts`, `src/ipc.ts`, or `src/task-scheduler.ts`

```bash
node -v  # Must be >= 18
npm run build
git diff --name-only src/db.ts src/index.ts src/ipc.ts src/task-scheduler.ts
```

## Phase 2: Apply Skill

### Install dependencies

```bash
npm install sqlite-vec@^0.1.7-alpha.2 @huggingface/transformers@^3.8.1
```

### Apply code changes

The skill engine will:
1. Add `src/memory.ts` (new file — the complete memory system)
2. Modify `src/db.ts` — load sqlite-vec extension into better-sqlite3
3. Modify `src/index.ts` — initialize memory schema, inject RAG context, embed conversations, write memory snapshots
4. Modify `src/ipc.ts` — handle memory IPC operations (add/update/remove/search)
5. Modify `src/task-scheduler.ts` — inject memory context into scheduled task prompts

### Build and verify

```bash
npm run build
npx vitest run .claude/skills/add-memory/tests/add-memory.test.ts
```

## Phase 3: First Run

On first startup after applying:

1. The embedding model (~23MB) downloads automatically to `data/models/`
2. Memory tables and vector indexes are created in the existing SQLite database
3. No configuration needed — memory is per-group isolated automatically

## Phase 4: Verify

```bash
# Check that memory tables exist
sqlite3 data/store/messages.db ".tables" | grep -q "core_memories"

# Check that vector tables exist
sqlite3 data/store/messages.db ".tables" | grep -q "core_memories_vec"

# Run the skill tests
npx vitest run .claude/skills/add-memory/tests/add-memory.test.ts
```

## How It Works

### Prompt Injection (RAG)

Before each agent invocation, `retrieveMemoryContext()` is called with the incoming messages. It:
1. Searches core memories (pinned + semantically relevant) and formats them as `<memory type="core">` XML
2. Searches past conversation chunks and formats them as `<memory type="past_conversations">` XML
3. Prepends both to the agent prompt

### Conversation Embedding

After the agent produces its first successful output, all incoming messages from that turn are embedded asynchronously. Each message gets a 384-dimensional vector (all-MiniLM-L6-v2) with 2 preceding messages as context.

### Memory Snapshot

Before each agent invocation, a `memory_snapshot.json` is written to the group's IPC directory. This lets the container agent see existing memory IDs for update/remove operations.

### IPC Memory Operations

The container agent writes JSON files to `data/ipc/{group}/memory/`:
- `memory_add` — stores a new core memory with embedding
- `memory_update` — updates content and re-embeds
- `memory_remove` — deletes memory and vector
- `memory_search` — request-response pattern: agent writes request, host writes `res-{id}.json` with results

## Troubleshooting

### Model download fails

The embedding model is cached in `data/models/`. If download fails:
```bash
rm -rf data/models/
# Restart — it will re-download
```

### "sqlite-vec not loaded" errors

Ensure `sqlite-vec` is installed and the native binary matches your platform:
```bash
npm ls sqlite-vec
# If issues, reinstall:
npm install sqlite-vec@^0.1.7-alpha.2
```

### Memory not injected into prompts

Check logs for "Memory retrieval failed" warnings. The system gracefully degrades — if memory retrieval fails, the agent still runs without context.

### onnxruntime mutex warning on exit

Harmless. Known onnxruntime cleanup race that only happens when Node.js exits. Does not affect data integrity.
