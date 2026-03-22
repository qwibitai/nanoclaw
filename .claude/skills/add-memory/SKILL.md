# Skill: /add-memory

Add a persistent memory system with full-text search (BM25 via SQLite FTS5) and pre-compaction flush to NanoClaw. The memory MCP server runs on the HOST (not inside containers), keeping the search index outside the sandbox.

## Prerequisites

- NanoClaw fork with at least one channel operational
- `~/nanoclaw-data/memory/<your-group-folder>/` directory already exists with `MEMORY.md` and `memory/` subdirectory
- `~/nanoclaw-data/memory` already in mount allowlist
- `groups/<your-group-folder>/CLAUDE.md` already exists for the target group

## Overview

This skill creates:
1. **Memory MCP Server** (`src/memory-mcp-server.ts`) — host-side process exposing `memory_search`, `memory_write`, `memory_get` tools via stdio to containers
2. **Pre-compaction flush** — token estimation in `src/index.ts` that injects a memory-save prompt before context compaction
3. **Docker integration** — registers the MCP server in `container-runner.ts` and `agent-runner/src/index.ts`

## Architecture

```
[Container: agent-runner]  ←stdio→  [Host: memory-mcp-server.ts]  →  [SQLite FTS5 index]
        │                                      │
        │ uses tools:                          │ manages:
        │  memory_search                       │  ~/nanoclaw-data/memory/{group}/.memory-index.db
        │  memory_write                        │  (NEVER mounted in container)
        │  memory_get                          │
        │                                      │ reads/writes:
        └─ reads/writes ──────────────────────→│  ~/nanoclaw-data/memory/{group}/MEMORY.md
           /workspace/extra/memory/            │  ~/nanoclaw-data/memory/{group}/memory/*.md
```

The MCP server follows the EXACT same pattern as `@modelcontextprotocol/server-github` and `@cocal/google-calendar-mcp` — it runs on the host, communicates via stdio pipe with the container agent. The index `.db` file lives in the memory directory but is NEVER mounted into the container.

## Step-by-step implementation

### Step 1: Install better-sqlite3 on the host

```bash
cd ~/nanoclaw
npm install better-sqlite3
npm install @types/better-sqlite3 --save-dev
```

Verify FTS5 is available:
```bash
node -e "const db = require('better-sqlite3')(':memory:'); db.exec('CREATE VIRTUAL TABLE test USING fts5(content)'); console.log('FTS5 OK');"
```

### Step 2: Create the Memory MCP Server

Create `src/memory-mcp-server.ts`. This is a standalone MCP server that:
- Receives `MEMORY_DIR` env var pointing to the group's memory directory (e.g., `~/nanoclaw-data/memory/telegram_main`)
- Creates/maintains a SQLite FTS5 index at `$MEMORY_DIR/.memory-index.db`
- Exposes 3 tools via MCP stdio protocol
- Re-indexes `.md` files on startup (only files whose mtime changed since last index)

The server MUST use the MCP SDK pattern. Import from `@modelcontextprotocol/sdk/server/index.js` and `@modelcontextprotocol/sdk/server/stdio.js`. Look at how other MCP servers in the project are structured (check any existing MCP server imports in the codebase) and follow the same pattern.

#### Tool definitions:

**`memory_search`**
- Input: `{ query: string, max_results?: number (default 5, max 20), date_from?: string, date_to?: string }`
- Behavior: Run BM25 full-text search over the FTS5 index. If date_from/date_to provided, filter by filename pattern (daily logs are named YYYY-MM-DD.md). Return snippets with ±3 lines of context.
- Output: `{ results: Array<{ file: string, line_start: number, line_end: number, snippet: string, score: number }> }`

**`memory_write`**
- Input: `{ target: "daily" | "long_term", content: string, section?: string, mode: "append" | "replace_section" }`
- Behavior:
  - If target="daily": append content to `memory/YYYY-MM-DD.md` (create file if needed, using today's date). Always append with a blank line separator.
  - If target="long_term": edit `MEMORY.md`. If mode="append", append to end. If mode="replace_section" and section is provided, find the `## {section}` heading and replace content between it and the next `##` heading.
- After writing, re-index the modified file in FTS5.
- Output: `{ success: boolean, file: string, lines_written: number }`

**`memory_get`**
- Input: `{ file: string, line_start?: number, line_end?: number }`
- Behavior: Read a specific memory file. Support aliases: "today" → `memory/YYYY-MM-DD.md`, "yesterday" → `memory/YYYY-MM-DD.md` (yesterday's date), or literal paths relative to MEMORY_DIR (e.g., "MEMORY.md", "memory/2026-03-15.md"). If the file doesn't exist, return `{ text: "", path: resolved_path, lines: 0 }` (graceful degradation, do NOT throw).
- Output: `{ text: string, path: string, lines: number }`

#### FTS5 Index schema:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  file,
  line_start,
  content,
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS memory_meta (
  file TEXT PRIMARY KEY,
  last_modified INTEGER,
  line_count INTEGER
);
```

#### Chunking strategy:
- Split each .md file into chunks of ~10 lines with 2-line overlap
- When re-indexing a file: DELETE all rows for that file from memory_fts, then INSERT new chunks
- Only re-index files whose mtime (from fs.statSync) differs from memory_meta.last_modified

#### Startup behavior:
1. Open/create `.memory-index.db` in MEMORY_DIR
2. Create tables if not exist
3. Scan all `.md` files in MEMORY_DIR and MEMORY_DIR/memory/
4. For each file, check mtime against memory_meta. Re-index if changed.
5. Start MCP stdio server

### Step 3: Integrate MCP server in container-runner.ts

Two changes are needed: **a bind mount** to get the binary into the container, and **an env var** to pass `MEMORY_DIR`.

> **Critical: mount path must be `/app/dist/`, not `/usr/local/lib/`**
> Node.js ESM module resolution walks up directories from the file's location to find `node_modules`. From `/app/dist/` it reaches `/app/node_modules/` (where `@modelcontextprotocol/sdk` lives). From `/usr/local/lib/` there is no `node_modules/` ancestor — the MCP server silently fails to start.

**1. Add the binary mount** — in `buildVolumeMounts`, add:

```typescript
// Memory MCP: mount compiled server into /app/dist/ so ESM resolution finds node_modules
const memoryMcpBin = path.join(process.cwd(), 'dist', 'memory-mcp-server.js');
if (fs.existsSync(memoryMcpBin)) {
  mounts.push({
    hostPath: memoryMcpBin,
    containerPath: '/app/dist/memory-mcp-server.js',
    readonly: true,
  });
}
```

**2. Mount the per-group memory directory** — so the MCP server can read/write memory files:

```typescript
// Mount per-group memory directory for the memory MCP server
const memoryDir = path.join(os.homedir(), 'nanoclaw-data', 'memory', groupFolder);
if (fs.existsSync(memoryDir)) {
  mounts.push({
    hostPath: memoryDir,
    containerPath: '/workspace/extra/memory',
    readonly: false,
  });
}
```

**IMPORTANT:** The memory MCP server must be added for ALL groups, not just telegram_main. Use the `groupFolder` variable from the container runner context. If a group's memory directory doesn't exist yet, the MCP server should create it on startup.

**IMPORTANT:** Do NOT use `.mcp.json` — it doesn't work for containerized agents.

### Step 4: Register tools in agent-runner

In `container/agent-runner/src/index.ts`:

1. Add `memory` to the `mcpServers` object using `/app/dist/memory-mcp-server.js` as the command path:

```typescript
...(fs.existsSync('/app/dist/memory-mcp-server.js') ? {
  memory: {
    command: 'node',
    args: ['/app/dist/memory-mcp-server.js'],
    env: { MEMORY_DIR: '/workspace/extra/memory' },
  },
} : {}),
```

2. Add `mcp__memory__*` to the `allowedTools` array (wildcard covers all three tools).

> **Why `/app/dist/`?** The container's Node.js ESM resolution walks up from the file's directory to find `node_modules`. From `/app/dist/` it reaches `/app/node_modules/` where `@modelcontextprotocol/sdk` is installed. Using `/usr/local/lib/` breaks this resolution silently — the MCP server fails to start with no useful error.

### Step 5: Implement pre-compaction flush in src/index.ts

Add token estimation and flush injection to the message processing loop.

#### 5a: Add state tracking

Near the top of `src/index.ts`, with the other state variables:

```typescript
const flushTriggered: Record<string, boolean> = {};
const TOKEN_FLUSH_THRESHOLD = 0.75;
const ESTIMATED_CONTEXT_WINDOW = 200000; // Claude Sonnet 4
```

#### 5b: Add token estimation function

```typescript
function shouldTriggerMemoryFlush(groupFolder: string): boolean {
  const sessionDir = path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  try {
    if (!fs.existsSync(sessionDir)) return false;
    const sessionFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
    let totalChars = 0;
    for (const file of sessionFiles) {
      totalChars += fs.statSync(path.join(sessionDir, file)).size;
    }
    const estimatedTokens = totalChars / 4;
    return estimatedTokens > (ESTIMATED_CONTEXT_WINDOW * TOKEN_FLUSH_THRESHOLD);
  } catch {
    return false;
  }
}
```

#### 5c: Inject flush prompt

In the message processing flow, AFTER the agent responds and BEFORE advancing the cursor, add:

```typescript
const groupFolder = registeredGroups[jid]?.folder;
if (groupFolder && !flushTriggered[groupFolder] && shouldTriggerMemoryFlush(groupFolder)) {
  flushTriggered[groupFolder] = true;
  // Queue a system message for the next interaction
  // Write this prompt in the user's preferred language (the agent will respond in that language)
  const flushPrompt = `[SYSTEM] Your session context is approaching the limit. Before continuing:
1. Review the current conversation and save a summary to the daily log using memory_write(target="daily")
2. If there are new decisions or preferences, save them to long-term memory using memory_write(target="long_term")
3. After saving, confirm with "Memory synced" and continue normally`;
  // Prepend to the next message batch for this group
  // Use the same mechanism used for scheduled task messages
}
```

Find how scheduled tasks inject messages into the processing pipeline (look at task-scheduler.ts or how scheduled task output is sent). Use the same mechanism to inject the flush prompt as a system-level message to the group's next agent invocation.

#### 5d: Reset flush flag on session clear

If there's a session clear/reset mechanism, reset `flushTriggered[groupFolder] = false` there. Also reset on service restart (which already happens since it's in-memory).

### Step 6: Update CLAUDE.md for MCP tools

Update `groups/<your-group-folder>/CLAUDE.md` — add or replace the memory usage instructions with tool-aware content. Write this section in the user's preferred language (the agent reads and responds in whatever language its CLAUDE.md is written in):

```markdown
### How to use memory
- **Search**: use the `memory_search` tool with a natural language query to find information in past logs and long-term memory
- **Write daily log**: use `memory_write` with `target="daily"`, `mode="append"`, and the content as Markdown
- **Write long-term**: use `memory_write` with `target="long_term"`, `section="Preferences"` (or Decisions/Facts/Patterns), `mode="replace_section"` to update a whole section, or `mode="append"` to add to the end
- **Read a specific file**: use `memory_get` with `file="MEMORY.md"`, `file="today"`, `file="yesterday"`, or `file="memory/2026-03-15.md"`
- You can also read and write files directly in /workspace/extra/memory/ as a fallback
```

### Step 7: Build and verify

```bash
# Compile TypeScript
npm run build

# Verify the MCP server starts standalone
MEMORY_DIR=~/nanoclaw-data/memory/<your-group-folder> node dist/memory-mcp-server.js
# Should start without errors and wait for stdio input. Ctrl+C to stop.

# Rebuild Docker image (agent-runner changes)
docker build -t nanoclaw-agent:latest -f ~/nanoclaw/container/Dockerfile ~/nanoclaw/container/

# Clear session cache
rm -rf ~/nanoclaw/data/sessions/<your-group-folder>/agent-runner-src

# Restart service
systemctl --user restart nanoclaw
```

### Step 8: Verify from Telegram

Test memory_search:
```
@AssistantName, search your memory for everything related to [topic]
```

Test memory_write:
```
@AssistantName, add to the daily log that today we implemented FTS5 search in the memory system
```

Test memory_get:
```
@AssistantName, read yesterday's notes
```

Test pre-compaction flush:
The flush triggers automatically when session size exceeds 75% of 200K tokens. To test manually, check the session size:
```bash
du -sh ~/nanoclaw/data/sessions/<your-group-folder>/.claude/
```

## Troubleshooting

| Problem | Solution |
|---|---|
| "memory_search not found" | MCP server not registered in agent-runner. Check `container/agent-runner/src/index.ts` for `mcp__memory__*` in allowedTools |
| "Failed to connect to memory MCP" | Check that `dist/memory-mcp-server.js` exists (run `npm run build`). Check MEMORY_DIR path is correct |
| FTS5 not available | Reinstall better-sqlite3: `npm rebuild better-sqlite3`. Verify with the node one-liner in Step 1 |
| Agent still uses file read/write instead of MCP tools | Update CLAUDE.md instructions to emphasize MCP tools. Clear session cache and restart |
| Flush prompt never triggers | Check session file sizes. The 75% threshold on 200K tokens ≈ 600KB of JSONL. Lower TOKEN_FLUSH_THRESHOLD for testing |
| MCP server crashes on startup | Check MEMORY_DIR exists and has correct permissions (700). Check `.memory-index.db` is writable |

## Security notes

- The `.memory-index.db` SQLite file is NEVER mounted into any container
- All SQL queries in the MCP server MUST use parameterized statements (no string concatenation)
- The MCP server only reads/writes within MEMORY_DIR — validate all file paths to prevent directory traversal
- Memory directories must have permissions 700 (owner only)
