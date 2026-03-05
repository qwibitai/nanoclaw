# Fork Changelog

Changes in `robbyczgw-cla/nanoclaw` vs upstream `qwibitai/nanoclaw`.

---

## 2026-03-05 — Initial Fork (cd216a5)

Based on upstream NanoClaw v1.2.6.

### 🧠 Semantic Memory System
- **`src/embeddings.ts`** — Embedding service: Synthetic API + SQLite storage + cosine similarity search
- **`src/memory-server.ts`** — HTTP endpoint on port 7832 for container access to memory
- **`container/agent-runner/src/ipc-mcp-stdio.ts`** — Added `search_memory` MCP tool so agents can semantically search chat history
- **`src/index.ts`** — Auto-embed incoming messages on receive
- **`src/container-runner.ts`** — `--add-host` flag for container → host network access
- **`src/db.ts`** — Embeddings DB initialization

### 💬 Slash Commands
- **`src/channels/telegram.ts`** — Telegram slash commands (`/status`, `/new`, `/tasks`) with menu registration
- **`src/channels/discord.ts`** — Discord text commands (`/status`, `/new`, `/tasks`)
- **`src/channels/telegram.test.ts`** + **`discord.test.ts`** — Tests
- **`src/channels/index.ts`** + **`registry.ts`** — Channel registration system

### 🦎 NanoCami Identity
- **`groups/main/CLAUDE.md`** — Full personality, Robby context, formatting rules, memory instructions
- **`groups/global/CLAUDE.md`** — Compact global config for all groups

### 🔧 Config
- **`.env.example`** — Added Synthetic API key placeholder
- **`.gitignore`** — Updated group tracking rules
- **`package.json`** — New dependencies for embeddings + channels
- **`src/config.ts`** + **`src/ipc.ts`** — Minor extensions

## [2026-03-05] IPC Permission Fix + Container Stability

### Bug Fixed
- **Root cause:** Host runs as root (uid 0), Docker container as node (uid 1000)
- IPC subdirs (messages, tasks, input) were root-owned → container agent couldn't delete files → agent hung → timeout killed container (exit 137 / SIGKILL)
- Debug dir didn't exist → ENOENT crash on subagent spawn (exit 1)

### Changes in 
- IPC subdirs now get  on creation → container user can read/write/unlink
- Debug dir pre-created with  → no more ENOENT crashes for subagents

### Impact
- Swarm tasks no longer hang indefinitely waiting on stuck IPC operations
- No more manual `chmod -R 777 /root/nanoclaw/data/ipc/` needed after restart
