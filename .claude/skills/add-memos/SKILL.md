---
name: add-memos
description: Add MemOS persistent memory backend to NanoClaw. Provides semantic similarity search, automatic deduplication, memory evolution, and graph-based knowledge via a self-hosted Docker stack. Entirely opt-in — zero impact when not configured.
---

# Add MemOS Memory Backend

This skill integrates [MemOS](https://memos.openmem.net) as a persistent memory backend for NanoClaw agents. When configured, agents get semantic search across past conversations, automatic memory capture, and explicit memory tools (`search_memories`, `add_memory`, `chat`).

## Critical: Known MemOS issues you MUST fix

MemOS (as of the upstream repo at github.com/MemTensor/MemOS) has several issues that will cause search to silently return empty results. These are **not optional** — search will not work without these fixes. Apply them during Phase 3.

### Issue 1: Default relativity threshold filters out results

MemOS's `APISearchRequest` defaults `relativity` to `0.45`. This is a minimum relevance score filter. Most memories score below this, especially with small datasets, so search returns empty even when vectors exist in Qdrant. **Fix:** Pass `relativity: 0` in all search requests from NanoClaw's `src/memos-client.ts` and `container/agent-runner/src/memos-mcp-stdio.ts`. Once MemOS is working, add a memory to it to have the user increase this value over time, as the number of memories stored builds.

### Issue 2: uvicorn --reload destroys in-memory state

The Dockerfile's CMD uses `--reload`, which watches `/app/src` for changes. Since docker-compose mounts `../src:/app/src`, any file change (even during add operations) restarts the server, losing all in-memory cube state. **Fix:** Override the command in docker-compose.yml to remove `--reload`.

### Issue 3: MEMOS_BASE_PATH defaults to ephemeral path

`MEMOS_BASE_PATH` defaults to `.` (cwd), which resolves to `/app` inside the container — not on any persistent volume. The UserManager SQLite database (`/app/.memos/memos_users.db`) is lost on container recreation. **Fix:** Set `MEMOS_BASE_PATH=/app/data` and mount a Docker volume at `/app/data`.

### Issue 4: User/cube registration required before search works

MemOS search only works for users that have been registered with the UserManager (stored in SQLite). The `add` endpoint creates cubes in memory but the `search` endpoint requires them in persistent storage. **Fix:** Pre-register the user via a Python script after the stack starts (see Phase 3).

### Issue 5: Cube user_name prefix mismatch

`_initialize_cube_from_default_config()` in `product.py` prepends `"memos"` to the user_id when setting the graph_db user_name (e.g., `"mctesty"` becomes `"memosmctesty"`). But the `add` endpoint stores data with the plain user_id. Search then filters by the prefixed name and finds nothing. **Fix:** Patch `product.py` line ~235 to use plain `user_id` instead of `f"memos{user_id.replace('-', '')}"`.

### Issue 6: memory_content field is deprecated

Despite what older documentation says, `memory_content` is deprecated in current MemOS. The MemReader logs: "expects message with role... skipping". **Fix:** Always use the `messages` format for adding memories: `{"messages": [{"role": "user", "content": "..."}], "user_id": "..."}`. NanoClaw's memos-client already uses this format.

## Phase 1: Pre-flight & Gather Info

Gather all required information up front so the remaining phases can run unattended.

### Check if already applied

Check if `src/memos-client.ts` exists. If it does, skip to Phase 3 (MemOS Stack Setup). The code changes are already in place.

### Check Docker

```bash
docker info > /dev/null 2>&1 && echo "Docker OK" || echo "Docker not available"
```

Docker is required for both the NanoClaw agent containers and the MemOS stack.

### Read assistant name

Read `ASSISTANT_NAME` from `.env` (defaults to "Andy" if not set). Use this name (lowercased) for defaults below.

### Gather user inputs

Use `AskUserQuestion` to collect all required configuration at once:

> I need a few details to set up MemOS. Please provide:
>
> **1. OpenAI-compatible API provider** — MemOS needs an OpenAI-compatible API for two purposes: generating embeddings (vectors for semantic search) and internal memory operations (summarization, deduplication, synthesis). This is separate from the Claude model that NanoClaw uses for agent conversations.
>   - **OpenRouter** (recommended) — supports many models without a direct OpenAI account. Base URL: `https://openrouter.ai/api/v1`
>   - **OpenAI directly** — Base URL: `https://api.openai.com/v1`
>   - **Other** — any OpenAI-compatible endpoint (e.g., local Ollama, LiteLLM, vLLM)
>
> **2. API key** for the provider above
>
> **3. Embedding model** — used for semantic search vectorization. Default: `openai/text-embedding-3-small` (1536 dimensions). Accept the default or provide a custom model name.
>
> **4. Chat model** — used by MemOS internally for memory summarization, deduplication, and the `chat` tool's synthesis. This is NOT the agent's model (which is Claude). Default: `openai/gpt-4o-mini`. Accept the default or provide a custom model name.
>
> **5. MemOS basic auth password** — used to secure the MemOS API via the reverse proxy. The username will default to `<assistant_name>`. I can generate a strong random password for you, or you can specify your own.
>
> **6. Where to clone MemOS** — the MemOS Docker stack will be cloned here (default: `../MemOS` relative to this project)
>
> **7. Migrate existing memories?** — Should I migrate your existing conversation history and group notes into MemOS? (yes/no)

Store all answers for use in subsequent phases.

### Validate embeddings API

Immediately test the user's embeddings API credentials before proceeding:

```bash
curl -s <OPENAI_BASE_URL>/embeddings \
  -H "Authorization: Bearer <OPENAI_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"input":"test","model":"<embedding_model>"}'
```

A successful response will contain an `embedding` array of floats. If you get a 401 (bad key), 404 (wrong endpoint), or 400 (unsupported model), inform the user what went wrong and loop back to "Gather user inputs" to collect corrected values. Do not proceed until this test passes — MemOS will silently fail to index memories otherwise.

No more user interaction is needed after this point.

## Phase 2: Apply Code Changes

### Ensure remote

```bash
git remote -v
```

If `memos` is missing, add it:

```bash
git remote add memos https://github.com/brentkearney/nanoclaw-memos.git
```

### Merge the skill branch

```bash
git fetch memos main
git merge memos/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in skill instruction files under `.claude/skills/add-memos/`. The actual source files must be copied into place from the skill's `add/` and `modify/` directories:

**Copy new files:**
```bash
cp .claude/skills/add-memos/add/src/memos-client.ts src/memos-client.ts
cp .claude/skills/add-memos/add/container/agent-runner/src/memos-mcp-stdio.ts container/agent-runner/src/memos-mcp-stdio.ts
mkdir -p scripts
cp .claude/skills/add-memos/add/scripts/migrate-memories-to-memos.ts scripts/migrate-memories-to-memos.ts
```

**Apply modified files (these are complete replacement files, not patches):**
```bash
cp .claude/skills/add-memos/modify/src/config.ts src/config.ts
cp .claude/skills/add-memos/modify/src/index.ts src/index.ts
cp .claude/skills/add-memos/modify/src/container-runner.ts src/container-runner.ts
cp .claude/skills/add-memos/modify/container/agent-runner/src/index.ts container/agent-runner/src/index.ts
cp .claude/skills/add-memos/modify/.env.example .env.example
```

If conflicts arise, read the intent files in `.claude/skills/add-memos/modify/` for guidance:
- `src/config.ts.intent.md`
- `src/index.ts.intent.md`
- `src/container-runner.ts.intent.md`
- `container/agent-runner/src/index.ts.intent.md`
- `.env.example.intent.md`

### Fix relativity threshold (Issue 1)

In `src/memos-client.ts`, find the search request body and add `relativity: 0`:

```typescript
body: JSON.stringify({ query, user_id: userId, relativity: 0 }),
```

In `container/agent-runner/src/memos-mcp-stdio.ts`, find the `search_memories` tool's fetch body and add the same:

```typescript
body: JSON.stringify({ query: args.query, user_id: MEMOS_USER_ID, relativity: 0 }),
```

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: MemOS Stack Setup

### Clone MemOS

The MemOS Docker stack has 3 core services: `memos-api` (Python/FastAPI), `neo4j` (graph database), and `qdrant` (vector database). Optionally add `caddy` for reverse proxy with basic auth.

Clone to the location specified in Phase 1:

```bash
git clone https://github.com/MemTensor/MemOS.git <clone_path>
cd <clone_path>
```

### Configure docker-compose.yml

The stock `docker/docker-compose.yml` needs these changes:

1. **Override command to disable --reload** (Issue 2): Add `command:` to the memos service
2. **Add persistent data volume** (Issue 3): Mount a named volume at `/app/data`
3. **Use a predictable network name**: Set `name:` on the network

Here is a working docker-compose.yml:

```yaml
name: memos

services:
  memos:
    container_name: memos-api
    build:
      context: ..
      dockerfile: docker/Dockerfile
    command: ["uvicorn", "memos.api.server_api:app", "--host", "0.0.0.0", "--port", "8000"]
    ports:
      - "8000:8000"
    env_file:
      - ../.env
    depends_on:
      - neo4j
      - qdrant
    environment:
      - PYTHONPATH=/app/src
      - HF_ENDPOINT=https://hf-mirror.com
      - QDRANT_HOST=qdrant
      - QDRANT_PORT=6333
      - NEO4J_URI=bolt://neo4j:7687
    volumes:
      - ../src:/app/src
      - .:/app/docker
      - memos_data:/app/data
    networks:
      - memos

  neo4j:
    image: neo4j:5.26.4
    container_name: neo4j
    ports:
      - "7474:7474"
      - "7687:7687"
    env_file:
      - ../.env
    healthcheck:
      test: wget http://localhost:7474 || exit 1
      interval: 1s
      timeout: 10s
      retries: 20
      start_period: 3s
    environment:
      NEO4J_ACCEPT_LICENSE_AGREEMENT: "yes"
      NEO4J_AUTH: "neo4j/${NEO4J_PASSWORD}"
    volumes:
      - neo4j_data:/data
      - neo4j_logs:/logs
    networks:
      - memos

  qdrant:
    image: qdrant/qdrant:v1.15.3
    container_name: qdrant
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      QDRANT__SERVICE__GRPC_PORT: 6334
      QDRANT__SERVICE__HTTP_PORT: 6333
    restart: unless-stopped
    networks:
      - memos

volumes:
  neo4j_data:
  neo4j_logs:
  qdrant_data:
  memos_data:

networks:
  memos:
    name: memos_network
    driver: bridge
```

### Create the MemOS .env file

Create `<clone_path>/.env` with the values from Phase 1. For `openai/text-embedding-3-small` the dimension is 1536. Use the same API key for all three roles (chat, memreader, embedder). Generate a random Neo4j password (e.g., `openssl rand -base64 24`) — it's used by both the Neo4j container and the memos-api container to authenticate.

```bash
# Core
TZ=<user_timezone>
MOS_CUBE_PATH=/app/data
MEMOS_BASE_PATH=/app/data
MOS_ENABLE_DEFAULT_CUBE_CONFIG=true
MOS_ENABLE_REORGANIZE=false
MOS_TEXT_MEM_TYPE=general_text
ASYNC_MODE=sync

# User defaults
MOS_TOP_K=50

# Chat LLM
MOS_CHAT_MODEL=<chat_model>
MOS_CHAT_TEMPERATURE=0.8
MOS_MAX_TOKENS=2048
MOS_TOP_P=0.9
MOS_CHAT_MODEL_PROVIDER=openai
OPENAI_API_KEY=<api_key>
OPENAI_API_BASE=<api_base_url>

# MemReader (uses same provider)
MEMRADER_MODEL=<chat_model>
MEMRADER_API_KEY=<api_key>
MEMRADER_API_BASE=<api_base_url>
MEMRADER_MAX_TOKENS=5000

# Embeddings
EMBEDDING_DIMENSION=1536
MOS_EMBEDDER_BACKEND=universal_api
MOS_EMBEDDER_PROVIDER=openai
MOS_EMBEDDER_MODEL=<embedding_model>
MOS_EMBEDDER_API_BASE=<api_base_url>
MOS_EMBEDDER_API_KEY=<api_key>

# Reranker (cosine local — no external API needed)
MOS_RERANKER_BACKEND=cosine_local
MOS_RERANKER_STRATEGY=single_turn

# Reader chunking
MEM_READER_BACKEND=simple_struct
MEM_READER_CHAT_CHUNK_TYPE=default
MEM_READER_CHAT_CHUNK_TOKEN_SIZE=1600
MEM_READER_CHAT_CHUNK_SESS_SIZE=10
MEM_READER_CHAT_CHUNK_OVERLAP=2

# Scheduler
MOS_ENABLE_SCHEDULER=false
API_SCHEDULER_ON=true

# Graph / vector stores (Docker internal hostnames)
NEO4J_BACKEND=neo4j-community
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<generated_password>
NEO4J_DB_NAME=neo4j
MOS_NEO4J_SHARED_DB=false
QDRANT_HOST=qdrant
QDRANT_PORT=6333

# Disabled features
ENABLE_INTERNET=false
ENABLE_PREFERENCE_MEMORY=false
MEMSCHEDULER_USE_REDIS_QUEUE=false
NACOS_ENABLE_WATCH=false
```

### Patch product.py user_name prefix (Issue 5)

Before starting the stack, fix the user_name mismatch:

```bash
# In <clone_path>/src/memos/mem_os/product.py, find _initialize_cube_from_default_config (~line 235):
#   cube_config.text_mem.config.graph_db.config.user_name = (
#       f"memos{user_id.replace('-', '')}"
#   )
# Replace with:
#   cube_config.text_mem.config.graph_db.config.user_name = (
#       user_id
#   )
sed -i 's/f"memos{user_id.replace.*}"/user_id/' <clone_path>/src/memos/mem_os/product.py
```

Verify the change:
```bash
grep -A2 "graph_db.config.user_name" <clone_path>/src/memos/mem_os/product.py
```

Should show `user_id` not `f"memos{user_id...}"`.

### Start the stack

```bash
cd <clone_path>/docker
docker compose up -d
```

The first start builds the Python container image (takes several minutes, longer on ARM64). Wait for memos-api to show "Application startup complete":

```bash
# Wait for startup (up to 60s on ARM64)
for i in $(seq 1 60); do
  docker logs memos-api 2>&1 | grep -q "Application startup complete" && echo "Ready" && break
  sleep 1
done
```

### Pre-register the user (Issue 4)

The MEMOS_USER_ID must be registered in the UserManager before search will work:

```bash
docker exec memos-api python3 -c "
import sys, os
sys.path.insert(0, '/app/src')
os.environ['MEMOS_BASE_PATH'] = '/app/data'
from memos.api.config import APIConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_os.product import MOSProduct
default_config = APIConfig.get_product_default_config()
mos_config = MOSConfig(**default_config)
default_cube_config = APIConfig.get_default_cube_config()
mos = MOSProduct(default_config=mos_config, default_cube_config=default_cube_config)
result = mos.user_register(user_id='<MEMOS_USER_ID>', user_name='<MEMOS_USER_ID>', default_cube_config=default_cube_config)
print('Register result:', result)
cubes = mos.user_manager.get_user_cubes('<MEMOS_USER_ID>')
print('Cubes:', len(cubes))
"
```

Expected output: `Register result: {'status': 'error', 'message': 'Failed to register user: stat: ...'}`  followed by `Cubes: 1`. The error is cosmetic — the user and cube are still created. Verify with `Cubes: 1`.

### Verify end-to-end memory storage and retrieval

Test the full pipeline. Use the `messages` format (not `memory_content`):

```bash
# Store a test memory
curl -s http://localhost:8000/product/add -X POST \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"The sky is blue and water is wet"},{"role":"assistant","content":"Yes, those are basic facts."}],"user_id":"<MEMOS_USER_ID>"}'
```

Should return `"code":200` with a `memory_id` in the response. If `"data":[]` (empty), the memory was not ingested — check logs.

Wait 15 seconds (longer on ARM64), then search with `relativity: 0`:

```bash
curl -s http://localhost:8000/product/search -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"what color is the sky","user_id":"<MEMOS_USER_ID>","relativity":0}'
```

Should return results in `data.text_mem[0].memories[]` with non-zero `metadata.relativity` scores.

**If search returns empty results**, debug in order:

1. **Check Qdrant has vectors**: `curl -s http://localhost:6333/collections/neo4j_vec_db | python3 -c "import sys,json; print('points:', json.load(sys.stdin)['result']['points_count'])"` — should be > 0
2. **Check user_name in Qdrant matches**: `curl -s http://localhost:6333/collections/neo4j_vec_db/points/scroll -X POST -H "Content-Type: application/json" -d '{"limit":3,"with_payload":true,"with_vector":false}' | python3 -c "import sys,json; [print(p['payload'].get('user_name')) for p in json.load(sys.stdin)['result']['points']]"` — should show your MEMOS_USER_ID, not `"memos<user_id>"`
3. **Check cube is registered**: Run the user registration script again and verify `Cubes: 1`
4. **Check API logs**: `docker logs memos-api --tail 50 2>&1 | grep -iE "error|fail"`
5. **Verify relativity=0 is passed**: Without it, the default 0.45 threshold filters most results

## Phase 4: NanoClaw Configuration

### Set environment variables

Add to NanoClaw's `.env` using the values from Phase 1:

```bash
# MemOS API endpoint (host-side, direct access — no reverse proxy)
MEMOS_API_URL=http://localhost:8000/product

# Basic auth credentials for the reverse proxy (user:password)
# Only needed if you set up Caddy. Omit if accessing directly on localhost.
# MEMOS_API_AUTH=<assistant_name>:<password>

# User namespace in MemOS (defaults to assistant name lowercased)
MEMOS_USER_ID=<assistant_name>

# Direct Docker network URL for container access (no auth needed)
# Falls back to MEMOS_API_URL if not set
MEMOS_CONTAINER_API_URL=http://memos-api:8000/product

# Docker network name — containers join this to reach MemOS services
CONTAINER_NETWORK=memos_network
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### About the reverse proxy

For local-only setups (MemOS and NanoClaw on the same machine), accessing the API directly on localhost:8000 is fine — no reverse proxy needed. For remote access or multi-machine setups, add Caddy for SSL/TLS and basic auth.

## Phase 5: Build & Verify

### Clear stale agent-runner copies

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
```

### Rebuild the container

```bash
cd container && ./build.sh
```

### Compile and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

### Test

Tell the user:

> MemOS is connected! Send a message in your main channel. Check the logs for:
>
> - `Injected MemOS memories into prompt` — auto-recall is working
> - The agent should now have `search_memories`, `add_memory`, and `chat` tools
>
> After a conversation ends, the exchange is automatically stored in MemOS.

Monitor logs:

```bash
tail -f logs/nanoclaw.log | grep -iE "(memos|memor)"
```

## Phase 6: Migration (if requested)

Only run this if the user opted in during Phase 1.

### Dry run first

```bash
MEMOS_API_URL=http://localhost:8000/product npx tsx scripts/migrate-memories-to-memos.ts --dry-run
```

### Execute migration

```bash
MEMOS_API_URL=http://localhost:8000/product npx tsx scripts/migrate-memories-to-memos.ts
```

Options:
- `--dry-run` — Preview without sending
- `--user-id=<assistant_name>` — Override MemOS user ID

## Troubleshooting

### Search returns empty but add succeeds

This is the most common issue. Check in order:

1. **Did you pass `relativity: 0`?** Without it, MemOS filters results below 0.45 (most results).
2. **Is the user registered?** Run the pre-register script from Phase 3. Verify `Cubes: 1`.
3. **Check user_name mismatch**: Query Qdrant to see what `user_name` is stored. If it's `"memos<user_id>"` instead of `"<user_id>"`, the product.py patch wasn't applied.
4. **Was --reload disabled?** Check `docker logs memos-api 2>&1 | grep "reloader"`. If you see "Started reloader process", the command override didn't take effect — recreate with `docker compose up -d --force-recreate`.

### MemOS stack not responding

```bash
docker ps | grep -E "memos|neo4j|qdrant"
docker logs memos-api --tail 50
```

Check that all 3 services are running. Common issue: embedding API key not set or expired. The memos-api container takes 20-60 seconds to start (longer on ARM64).

### Container can't reach MemOS

- Verify `CONTAINER_NETWORK` matches the actual Docker network: `docker network ls | grep memos`
- Test from inside a container: the URL should be `http://memos-api:8000/product` (internal port, no auth)
- Check that `MEMOS_CONTAINER_API_URL` is set in `.env`

### Auto-recall not working

- Verify `MEMOS_API_URL` is set in `.env`
- Check logs for `searchMemories` errors
- Test the API directly: `curl http://localhost:8000/product/search -X POST -H "Content-Type: application/json" -d '{"query":"test","user_id":"<user_id>","relativity":0}'`

### Agent doesn't have memory tools

- Clear stale agent-runner: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
- Rebuild container: `cd container && ./build.sh`
- Verify `memos-mcp-stdio.ts` is in `container/agent-runner/src/`

### ARM64 / Raspberry Pi notes

- Container build takes significantly longer (10-20 minutes for first build)
- API startup takes 20-60 seconds (vs ~5s on x86_64)
- Allow 15 seconds between add and search for async ingestion
- neo4j and qdrant ARM64 images are available and work without changes

## MemOS architecture notes (for debugging)

Understanding MemOS's internal architecture helps when things go wrong:

- **Two separate API apps exist**: `server_api.py` (mounted at startup, uses class-based handlers) and `start_api.py` (uses MOSProduct directly). The Docker container runs `server_api.py`.
- **server_api uses handler classes** (`SearchHandler`, `AddHandler`) that operate on a shared `naive_mem_cube` — a single memory cube initialized at startup. These do NOT use the `MOSProduct` class that `product_router.py` uses.
- **The search pipeline**: `SearchHandler → SingleCubeView → search_text_memories → TreeTextMemory.search → Searcher.retrieve → graph_retriever (Neo4j + Qdrant)`. Results go through `_postformat_memories → post_process_textual_mem → rerank_knowledge_mem → _apply_relativity_threshold`.
- **The add pipeline**: `AddHandler → naive_mem_cube.text_mem.add` → stores in Neo4j (graph) + Qdrant (vectors). The `messages` format goes through `MemReader` which extracts structured memories.
- **User/cube management**: `PersistentUserManager` stores users and cubes in SQLite at `MEMOS_BASE_PATH/.memos/memos_users.db`. The search pipeline loads cubes via `_load_user_cubes()` which queries this database.

## Removal

1. Remove `.env` variables: `MEMOS_API_URL`, `MEMOS_API_AUTH`, `MEMOS_USER_ID`, `MEMOS_CONTAINER_API_URL`, `CONTAINER_NETWORK`
2. Delete `src/memos-client.ts`
3. Delete `container/agent-runner/src/memos-mcp-stdio.ts`
4. Delete `scripts/migrate-memories-to-memos.ts`
5. Revert MemOS changes in `src/config.ts`, `src/index.ts`, `src/container-runner.ts`, `container/agent-runner/src/index.ts` (use the intent.md files to identify what to remove)
6. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
7. Rebuild: `cd container && ./build.sh && cd .. && npm run build`
8. Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux)
