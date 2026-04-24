# Observability Spike: Tool Call Interception & Storage

**Date:** 2026-04-24
**Status:** Spike complete
**Timebox:** 2 hours

---

## 1. Tool Interception Approach

### Decision: PostToolUse hook (settings.json)

**Use Claude Code's native `PostToolUse` hook** to capture every tool call after execution, writing a JSON event file to a new IPC subdirectory for host-side collection.

### Why PostToolUse over alternatives

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **PostToolUse hook** (settings.json) | Native, zero Claude CLI patches. Receives `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `session_id`. Runs after execution so captures outcome. Already proven pattern (service-guard.sh uses PreToolUse). | Adds ~5-15ms per tool call for hook process spawn. No duration timing (would need PreToolUse+PostToolUse pairing). | **Recommended** |
| PreToolUse + PostToolUse pair | Gets both input and duration timing | Requires correlating two events by `tool_use_id`; doubles hook overhead | Good follow-up if duration matters |
| Monkey-patch RunnerBackend.invoke() | Single interception point at `container/agent-runner/src/claude-cli-backend.ts:42` | Only sees session-level invoke, not individual tool calls within a session. Claude CLI is a black box from this layer. | Not viable for per-tool granularity |
| Parse stream-json output | Could extract `content_block_start` events with `type: "tool_use"` from stdout in `parseStreamOutput()` at `claude-cli-backend.ts:131` | Only sees tool invocations, not results. Would need to correlate with result blocks. Fragile coupling to stream format. | Backup option |
| MCP wrapper tool | Add an MCP tool that agents call to log their own tool usage | Agents would need to be prompted to use it; unreliable | Not viable |

### Implementation sketch

**Code locations to modify:**

1. **`src/session-settings.ts:52-60`** — Add PostToolUse hook alongside existing PreToolUse:
   ```typescript
   defaultSettings.hooks = {
     PreToolUse: [/* existing service-guard */],
     PostToolUse: [
       {
         matcher: '',  // match all tools
         hooks: [{ type: 'command', command: toolObserverHook }],
       },
     ],
   };
   ```

2. **New file: `container/hooks/tool-observer.sh`** — Hook script that receives PostToolUse JSON on stdin and writes an event file:
   ```bash
   INPUT=$(cat)
   TOOL=$(echo "$INPUT" | jq -r '.tool_name')
   TS=$(date +%s%N)
   echo "$INPUT" | jq -c '{
     tool_name: .tool_name,
     tool_use_id: .tool_use_id,
     session_id: .session_id,
     tool_input: .tool_input,
     tool_response: (.tool_response | tostring | .[0:2000]),
     timestamp: now
   }' > "/workspace/ipc/tool-events/${TS}-${TOOL}.json"
   exit 0
   ```

3. **`src/container-runner.ts:119-121`** — Add `tool-events` to IPC directory creation:
   ```typescript
   fs.mkdirSync(path.join(groupIpcDir, 'tool-events'), { recursive: true });
   ```

4. **`src/ipc.ts`** — Add tool-events directory processing in `processGroup()`, alongside existing messages/tasks handlers.

5. **New migration** — Schema for tool_call_events table (see Storage section).

### What PostToolUse gives us (per hook invocation)

```json
{
  "session_id": "abc123",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test", "timeout": 120000 },
  "tool_response": { "stdout": "...", "exitCode": 0 },
  "tool_use_id": "toolu_01ABC123"
}
```

This is sufficient for observability: we know what tool was called, with what input, what the result was, and which session it belongs to.

---

## 2. Event Volume Estimates

### Assumptions

- **Single user** (CEO), personal assistant use case
- **Sessions per day:** 3-8 interactive sessions + 5-15 scheduled tasks = ~10-20 sessions/day
- **Tool calls per session:** A typical Claude agent session uses 10-50 tool calls (Read, Bash, Edit, Grep, Glob, Write). Complex tasks can reach 80-150.
- **Max concurrent sessions:** 5 (config: `MAX_CONCURRENT_CONTAINERS` in `src/config.ts:58-61`), parallel dispatch capped at 4 workers

### Volume projections

| Metric | Average Day | Peak Day | Peak Burst (5 min) |
|--------|-------------|----------|-------------------|
| Sessions | 15 | 25 | 5 concurrent |
| Tool calls per session | 30 | 100 | — |
| **Total tool calls/day** | **450** | **2,500** | **50** (10/min) |
| **Tool calls/week** | **3,150** | **17,500** | — |
| **Tool calls/month** | **13,500** | **75,000** | — |

### Event size

- Average event JSON: ~500 bytes (tool_input + truncated tool_response)
- With tool_response capped at 2KB: ~2.5KB worst case

### 7-day retention impact

| Metric | Average | Peak |
|--------|---------|------|
| Rows in 7 days | 3,150 | 17,500 |
| Storage (avg 500B/row) | 1.5 MB | 8.7 MB |
| Storage (worst 2.5KB/row) | 7.9 MB | 43.8 MB |

These volumes are trivial for any storage backend. Even at peak with worst-case event sizes, 7-day retention stays under 50 MB.

---

## 3. Storage Choice

### Decision: SQLite (existing, WAL mode)

**Use the existing SQLite database** (`store/messages.db`) with a new `tool_call_events` table. Do not introduce PostgreSQL for this feature.

### Rationale

| Factor | SQLite (existing) | PostgreSQL (new) |
|--------|-------------------|-----------------|
| **Volume fit** | 17.5K rows/week peak is nothing for SQLite | Massively over-provisioned |
| **Ops burden** | Zero — already running, WAL already enabled (`src/db/index.ts:28`) | Requires new service, connection management, credentials |
| **Write throughput** | WAL mode handles hundreds of writes/sec; our peak is ~0.2 writes/sec | Unnecessary for this volume |
| **Query patterns** | Simple time-range scans, group by tool_name — perfect for SQLite | No need for concurrent readers or complex joins |
| **Existing pattern** | `task_run_logs` table already stores per-execution telemetry in the same DB | Would split observability data across two stores |
| **Backup** | Single file copy | Requires pg_dump or streaming replication |
| **Retention cleanup** | `DELETE FROM tool_call_events WHERE timestamp < ?` + periodic VACUUM | Same, but more operational overhead |

PostgreSQL would only make sense if:
- Multiple NanoClaw instances shared a tool event store (not the case — single node)
- We needed concurrent write access from multiple processes (not the case — host IPC processor is single-threaded)
- Event volume exceeded ~100K writes/day (we're at <3K)

### Proposed schema (new migration)

```sql
CREATE TABLE IF NOT EXISTS tool_call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,
  tool_input TEXT,           -- JSON, may be truncated
  tool_response TEXT,        -- JSON, truncated to 2KB
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_events_session
  ON tool_call_events(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_timestamp
  ON tool_call_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_events_group
  ON tool_call_events(group_folder, timestamp);
```

### Retention strategy

Add a cleanup function called on startup and every 6 hours (similar to `cleanupStaleErrorFiles` in `src/ipc.ts:32-58`):

```typescript
function pruneToolEvents(retentionDays: number = 7): void {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  db.prepare('DELETE FROM tool_call_events WHERE timestamp < ?').run(cutoff);
}
```

---

## 4. Technical Blockers & Concerns

### No blockers identified

The approach uses only existing, proven patterns (hooks, IPC file-based communication, SQLite migrations).

### Concerns to address during implementation

1. **Hook process spawn overhead:** Each PostToolUse hook spawns a shell process. At ~30 tool calls/session this adds ~0.5-1.5s total latency per session. Acceptable, but monitor. If it becomes a problem, the hook could batch-write to a single JSONL file instead of per-event files.

2. **tool_response truncation:** Some tool responses (e.g., file reads, large Bash output) can be very large. The hook script must truncate `tool_response` to a reasonable size (2KB recommended) before writing the event file. Otherwise IPC directory could accumulate large files.

3. **Group folder correlation:** The PostToolUse hook receives `session_id` but not `group_folder`. The host IPC processor knows the group folder from the directory path (`/data/ipc/{groupFolder}/tool-events/`), so this is resolved by the existing IPC namespace design.

4. **Duration timing:** PostToolUse alone doesn't provide tool execution duration. If duration is needed, pair with a PreToolUse hook that writes a start-time file, and correlate by `tool_use_id` in the PostToolUse hook. This is a v2 enhancement, not a blocker.

5. **IPC directory cleanup:** Tool event files are consumed by the host IPC watcher and deleted after insertion into SQLite. If the host is down, files accumulate. The existing IPC error-file cleanup pattern (`src/ipc.ts:32-58`) should be extended to tool-events.

6. **No existing `src/agent/tool-executor.ts`:** The task description references this path, but it does not exist. Tool execution is handled entirely within Claude CLI (opaque to NanoClaw). The hook system is the correct interception point, not a custom executor layer.

---

## Summary

| Question | Answer |
|----------|--------|
| **Interception approach** | PostToolUse hook in `settings.json`, configured at `src/session-settings.ts:52-60`, writing event files via new `container/hooks/tool-observer.sh` to `/workspace/ipc/tool-events/` |
| **Storage** | SQLite (existing `store/messages.db`, WAL mode), new `tool_call_events` table via migration |
| **Average volume** | ~450 tool calls/day, ~3,150/week |
| **Peak volume** | ~2,500 tool calls/day, ~17,500/week |
| **7-day retention** | 1.5-44 MB depending on event size |
| **Blockers** | None. `src/agent/tool-executor.ts` does not exist; hooks are the correct interception layer. |
