---
name: add-memos
description: Add MemOS persistent memory backend to NanoClaw. Provides semantic similarity search, automatic deduplication, memory evolution, and graph-based knowledge via a self-hosted Docker stack. Entirely opt-in — zero impact when not configured.
---

# Add MemOS Memory Backend

This skill integrates [MemOS](https://memos.openmem.net) as a persistent memory backend for NanoClaw agents. When configured, agents get semantic search across past conversations, automatic memory capture, and explicit memory tools (`search_memories`, `add_memory`, `chat`).

## Phase 1: Pre-flight

### Check if already applied

Check if `src/memos-client.ts` exists. If it does, skip to Phase 3 (MemOS Stack Setup). The code changes are already in place.

### Check Docker

```bash
docker info > /dev/null 2>&1 && echo "Docker OK" || echo "Docker not available"
```

Docker is required for both the NanoClaw agent containers and the MemOS stack.

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

This merges in:
- `src/memos-client.ts` — HTTP client for MemOS search/add with graceful degradation
- `container/agent-runner/src/memos-mcp-stdio.ts` — MCP server giving agents `search_memories`, `add_memory`, `chat` tools
- `scripts/migrate-memories-to-memos.ts` — One-time migration tool for existing data
- Config exports (`MEMOS_API_URL`, `MEMOS_USER_ID`, `CONTAINER_NETWORK`) in `src/config.ts`
- Auto-recall and auto-capture in `src/index.ts`
- MemOS secrets passing, Docker network joining, and settings sync in `src/container-runner.ts`
- Conditional MemOS MCP server registration in `container/agent-runner/src/index.ts`
- MemOS environment variables in `.env.example`

If the merge reports conflicts, resolve them by reading the intent files in `.claude/skills/add-memos/modify/`:
- `src/config.ts.intent.md`
- `src/index.ts.intent.md`
- `src/container-runner.ts.intent.md`
- `container/agent-runner/src/index.ts.intent.md`
- `.env.example.intent.md`

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: MemOS Stack Setup

### Deploy MemOS

MemOS runs as a Docker stack with 5 services: `memos-api`, `memos-mcp`, `neo4j`, `qdrant`, and `caddy` (reverse proxy).

Tell the user:

> I need you to set up the MemOS Docker stack. Follow the instructions at:
>
> - [MemOS GitHub](https://github.com/MemTensor/MemOS) — clone and use the Docker Compose setup
> - [MemOS Documentation](https://memos-docs.openmem.net)
>
> The stack requires:
> 1. An OpenAI-compatible API key for embeddings (e.g., [OpenRouter](https://openrouter.ai))
> 2. Docker and Docker Compose
>
> Once running, give me the API URL (e.g., `http://localhost:8080/product`)

### Verify stack is running

```bash
curl -s http://localhost:8080/product/search -X POST -H "Content-Type: application/json" -d '{"query":"test","user_id":"test"}' | head -c 200
```

If using basic auth:

```bash
curl -s -u user:password http://localhost:8080/product/search -X POST -H "Content-Type: application/json" -d '{"query":"test","user_id":"test"}' | head -c 200
```

A JSON response (even with empty results) means the stack is healthy.

## Phase 4: Configuration

### Set environment variables

Add to `.env`:

```bash
# MemOS API endpoint (host-side, through reverse proxy)
MEMOS_API_URL=http://localhost:8080/product

# Basic auth credentials for the reverse proxy (user:password)
MEMOS_API_AUTH=bee:yourpassword

# User namespace in MemOS (defaults to assistant name lowercased)
MEMOS_USER_ID=bee

# Direct Docker network URL for container access (no auth needed)
# Falls back to MEMOS_API_URL if not set
MEMOS_CONTAINER_API_URL=http://memos-api:8000/product

# Docker network name — containers join this to reach MemOS services
CONTAINER_NETWORK=memos_memos
```

Use `AskUserQuestion` to get the user's specific values for each variable.

### About the reverse proxy

We recommend Caddy because it provides automatic SSL/TLS — important since basic auth credentials travel in plaintext without encryption. Users can substitute Nginx, Traefik, or HAProxy depending on their infrastructure.

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

## Phase 6: Optional Migration

Migrate existing conversation history and group notes to MemOS:

### Dry run first

```bash
MEMOS_API_URL=http://localhost:8080/product npx tsx scripts/migrate-memories-to-memos.ts --dry-run
```

### Execute migration

```bash
MEMOS_API_URL=http://localhost:8080/product npx tsx scripts/migrate-memories-to-memos.ts
```

Options:
- `--dry-run` — Preview without sending
- `--user-id=bee` — Override MemOS user ID

## Troubleshooting

### MemOS stack not responding

```bash
docker ps | grep memos
docker logs memos-api --tail 50
```

Check that all 5 services are running. Common issue: embedding API key not set or expired.

### Container can't reach MemOS

- Verify `CONTAINER_NETWORK` matches the actual Docker network: `docker network ls | grep memos`
- Test from inside a container: the URL should be `http://memos-api:8000/product` (internal port, no auth)
- Check that `MEMOS_CONTAINER_API_URL` is set in `.env`

### Auto-recall not working

- Verify `MEMOS_API_URL` is set in `.env`
- Check logs for `searchMemories` errors
- Test the API directly: `curl -u user:pass http://localhost:8080/product/search -X POST -H "Content-Type: application/json" -d '{"query":"test","user_id":"bee"}'`

### Agent doesn't have memory tools

- Clear stale agent-runner: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
- Rebuild container: `cd container && ./build.sh`
- Verify `memos-mcp-stdio.ts` is in `container/agent-runner/src/`

### Relevance scores are all 0.00

- Check that the embedding API is working (MemOS logs will show 400 errors if not)
- Verify `OPENAI_API_KEY` and `OPENAI_BASE_URL` in the MemOS stack `.env`
- Scores improve as more data is ingested

## Removal

1. Remove `.env` variables: `MEMOS_API_URL`, `MEMOS_API_AUTH`, `MEMOS_USER_ID`, `MEMOS_CONTAINER_API_URL`, `CONTAINER_NETWORK`
2. Delete `src/memos-client.ts`
3. Delete `container/agent-runner/src/memos-mcp-stdio.ts`
4. Delete `scripts/migrate-memories-to-memos.ts`
5. Revert MemOS changes in `src/config.ts`, `src/index.ts`, `src/container-runner.ts`, `container/agent-runner/src/index.ts` (use the intent.md files to identify what to remove)
6. Clear stale agent-runner copies: `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
7. Rebuild: `cd container && ./build.sh && cd .. && npm run build`
8. Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux)
