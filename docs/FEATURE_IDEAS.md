# Feature Ideas & Architecture Decisions

## Per-Group Model & Provider Routing

**Status:** Proposed
**Priority:** Medium
**Complexity:** Medium

### Overview
Allow different model providers and models per group/channel instead of globally. This enables cost optimization (cheap models for simple tasks, expensive models for complex ones) and multi-provider usage.

### Example Use Case
- **Self-chat (main):** Use Haiku for cost savings
- **Zibot group:** Use GPT-4o-mini for different capabilities
- **Work group:** Use Claude Opus for complex tasks

### Implementation Plan

1. **Database Schema**
   ```sql
   ALTER TABLE registered_groups ADD COLUMN agent_provider TEXT DEFAULT 'anthropic';
   ALTER TABLE registered_groups ADD COLUMN agent_model TEXT DEFAULT 'claude-haiku-4-5-20251001';
   ```

2. **Registration Command**
   ```bash
   npx tsx setup/index.ts --step register \
     --agent-provider "openai" \
     --agent-model "gpt-4o-mini"
   ```

3. **Container Runtime**
   - Read `agent_provider` and `agent_model` from registered_groups
   - Pass to container as environment variables
   - Container agent runner uses these values

4. **Provider Implementation**
   - In `container/agent-runner/src/index.ts`, add provider detection
   - Support: `anthropic`, `openai`, `xai`, etc.
   - Fall back to Claude Agent SDK for Anthropic

### Files to Modify
- `src/db.ts` - Add columns, migrations
- `setup/register.ts` - Add CLI flags
- `src/container-runner.ts` - Pass config to container
- `container/agent-runner/src/index.ts` - Provider routing logic

### Related
- Provider API key management
- Per-group credential isolation
- Multi-provider MCP server approach

---

## NanoClaw Search (Per-Group Local Search)

**Status:** v1 Shipped (BM25 keyword search)
**Priority:** High
**Complexity:** Medium

### Overview
Provides agent containers with the ability to search past conversation history and custom document collections. Uses a deterministically isolated approach where an individual `search.db` (SQLite + FTS5) is maintained for each group and mounted exclusively into its respective container.

### What's Working (v1)
- **Host-side exporter** (`src/search-exporter.ts`): real-time message export on ingest + 10-minute background sync
- **Container CLI** (`qsearch`): BM25 keyword search over messages and named document collections
- **Skill doc** (`container/skills/search/SKILL.md`): declares `qsearch` for agent SDK
- **Backfill script** (`scripts/backfill-search.ts`): one-shot population of search.db from existing messages
- **Deterministic isolation**: each group's search.db lives in its group folder, physically inaccessible to other containers

### v2 Upgrade Path (vectors)
The schema anticipates semantic search via `sqlite-vec`. See [search_plan.md](./search_plan.md) for full details.

---
