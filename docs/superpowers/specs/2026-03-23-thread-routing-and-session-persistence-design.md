# Thread Routing and Session Persistence Fix

**Date:** 2026-03-23
**Status:** Proposed

## Problem

Message routing between Discord and container agents has two interrelated failure modes:

1. **Session persistence failure (~46% of threads):** Session files are stored under `pending-{contextId}` directories while the container runs. On first response, the Discord channel renames these to the real Discord thread ID. This rename fails silently almost half the time (race conditions, errors before output, container killed). Subsequent messages find the thread context in the DB but look for session files under the new thread ID path — the files aren't there, so the SDK starts a fresh session, losing all conversation history.

2. **Routing correctness bugs:** The message loop groups messages by `chatJid` (Discord channel) rather than by thread. With multiple threads active, messages batch together and get one thread assignment. The Discord channel's send logic uses prefix matching on send targets, so responses can land in the wrong thread. An in-memory `activeConversation` flag lost on restart causes further mis-routing.

## Context

- Single Discord channel (`#general`) is the only messaging surface
- All bot conversations happen in Discord threads created by the bot
- Scheduled tasks output to `#general`; replies to scheduled output create threads
- `MAX_CONTAINERS_PER_GROUP = 3` allows concurrent threads
- `GroupQueue` already has per-thread state management; the message loop doesn't use it properly

## Design

### Section 1: Stable session directory naming

**Change:** Use the `ThreadContext` DB row ID as the canonical session directory name instead of the Discord thread ID.

- Containers start with `threadId = 'ctx-{contextId}'` (e.g., `ctx-142`)
- Session files live permanently at `data/sessions/{groupFolder}/ctx-{contextId}/.claude/...`
- The Discord thread ID is stored only in the `ThreadContext` DB record, never used for filesystem paths
- `migrateThreadDirs()` is removed entirely — no rename, no race condition

**Why this works:** The `ThreadContext.id` is stable from the moment the DB row is created, which happens before the container starts. The directory path is deterministic and never changes.

**Inbound mapping:** Discord thread messages are mapped to context IDs via `getThreadContextByThreadId(discordThreadId)` — this already exists and returns the context ID.

**Files changed:** `container-runner.ts` (remove `migrateThreadDirs`, update `buildVolumeMounts`), `discord.ts` (stop calling `migrateThreadDirs`, use `ctx-{id}` for thread context keys), `index.ts` (use `ctx-{id}` in session path construction and `processGroupMessages`).

### Section 2: Persist thread context ID on messages

**Change:** Add `thread_context_id` column to the `messages` table.

- Schema migration: `ALTER TABLE messages ADD COLUMN thread_context_id INTEGER` (for existing DBs)
- `CREATE TABLE messages` in `createSchema()` updated to include `thread_context_id` column (for fresh installs)
- `storeMessage()` INSERT statement updated to accept and persist `thread_context_id` (currently the column is not in the INSERT)
- `getNewMessages()` and `getUnprocessedMessages()` SELECT statements updated to include `thread_context_id`
- The in-memory `messageThreadContext` Map in `index.ts` is removed

**Implementation order:** The `storeMessage` change must be deployed before the `messageThreadContext` Map removal. Otherwise messages stored between the Map removal and the DB fix would lose their thread association. In practice this means both changes go in the same commit — the Map is only removed after the DB path is working.

**Why this works:** Thread-to-message association survives process restarts. The message loop can determine which thread each unprocessed message belongs to from the DB alone.

**Not changed:** The `messageImages` in-memory Map stays — images are large binary blobs not worth persisting to SQLite.

**Files changed:** `db.ts` (migration, `createSchema`, `storeMessage` INSERT, `getNewMessages` SELECT, `getUnprocessedMessages` SELECT), `types.ts` (update comment on `NewMessage.thread_context_id` — remove "not persisted to DB" note), `index.ts` (remove `messageThreadContext` Map, pass `thread_context_id` through `onMessage`).

### Section 3: Message loop groups by (chatJid, threadContextId)

**Change:** The message loop groups messages by `(chatJid, threadContextId)` instead of just `chatJid`.

- After `getNewMessages()` returns, group into `Map<string, NewMessage[]>` keyed by `${chatJid}:${threadContextId || 'default'}`
- Each thread-group gets independent: trigger check, `/goal` prefix detection, IPC pipe attempt, queue enqueue
- Messages without `thread_context_id` group under `'default'`

**Why this works:** Aligns the message loop with the `GroupQueue`'s existing per-thread model. Two messages from different threads in the same poll cycle get independent processing instead of being merged.

**Files changed:** `index.ts` (restructure `startMessageLoop`).

### Section 4: Exact-match send targeting

**Change:** Pass thread context ID through to `Channel.sendMessage` for exact lookup instead of prefix scanning.

- `Channel.sendMessage` signature: `sendMessage(jid: string, text: string, threadContextId?: number)`
- Discord channel looks up `this.currentSendTarget.get(\`${jid}:ctx-${threadContextId}\`)` — exact match
- When `threadContextId` is undefined (scheduled tasks, IPC): falls through to channel send (#general)
- `pendingTrigger` Map rekeyed from `${chatJid}:${ctx.id}` (current) to just `contextId` (number key) — exact match, no accidental collisions
- `activeConversation` Set removed entirely — declaration and all `.add()` / `.has()` / `.delete()` call sites in the `MessageCreate` handler (lines 193, 224, 230, 243, 555, 579). Thread-or-channel decision is now explicit based on whether `threadContextId` is provided
- The Step 2.5 DB fallback (currently guarded by `activeConversation`) is also removed. With `thread_context_id` persisted on messages (Section 2), the message loop always knows the thread context. The `onOutput` callback in `processGroupMessages` passes the known `threadContextId` to `channel.sendMessage`, so the send path never needs to guess.

**Critical path — onOutput callback:** The `onOutput` callback in `processGroupMessages` (index.ts line 328) currently calls `channel.sendMessage(chatJid, text)` without thread context. This must be updated to pass `threadContext?.id` as the third argument: `channel.sendMessage(chatJid, text, threadContext?.id)`. The `threadContext` variable is already available in the `processGroupMessages` closure (line 214-223). This is the primary response path — agent output to user.

**IPC and scheduler callers:** The IPC watcher's `sendMessage` callback (index.ts lines 943-947) and the scheduler's `sendMessage` callback (index.ts lines 915-939) call `channel.sendMessage` without thread context. These continue to pass `undefined` for `threadContextId`, which correctly routes to #general. No changes needed for these callers.

**Files changed:** `discord.ts` (sendMessage, sendFile, remove activeConversation, remove Step 2.5 fallback, remove `migrateThreadDirs` import), `types.ts` (Channel interface), `index.ts` (pass threadContextId through onOutput callback, update IPC/scheduler callback types).

### Section 5: Per-thread trigger check and IPC piping

**Change:** Trigger checking and IPC piping operate per thread-group, not per chatJid.

- Messages with a `thread_context_id`: no trigger check needed (they're in a bot thread, Discord channel already prepended the trigger). These skip the trigger-check block entirely and go straight to IPC piping or queue enqueue.
- Messages without `thread_context_id`: trigger check applies as today (the existing `needsTrigger` + `TRIGGER_PATTERN` logic)
- IPC piping uses thread-specific `isActive`: `queue.isActive(chatJid, 'ctx-' + threadContextId)` — a message is only piped to a container if that specific thread's container is active. The current code (line 589) calls `queue.isActive(chatJid)` without a thread arg, which matches any active thread in the group. `GroupQueue.isActive` already accepts an optional `threadId` parameter (group-queue.ts line 127), so no queue changes are needed.
- Non-trigger messages in #general can never accidentally route to an unrelated thread's container

**Files changed:** `index.ts` (per-thread-group logic in message loop — trigger check and IPC piping restructured).

### Section 6: One-time session directory migration

**Change:** A migration script runs once on upgrade to rename existing session directories to the `ctx-{id}` scheme.

- Reads all `pending-{id}` directories under `data/sessions/{groupFolder}/`
- Maps each to `ctx-{id}` by extracting the numeric ID (which is already the ThreadContext row ID)
- Handles duplicates: if `ctx-{id}` already exists (e.g., from a partial previous migration), skip the rename and delete the `pending-` dir
- Reads all remaining numeric directories (e.g., `1484777234249154560/`) — identified by matching `/^\d+$/`. Skips known non-thread directories (`.claude/`, `agent-runner-src/`, `task_*`)
- Looks up the ThreadContext by `thread_id` in the DB to find the context ID, renames to `ctx-{id}`
- If multiple directories map to the same context ID, keep the one with the most recent .jsonl file
- Directories with no matching DB record are deleted (orphaned sessions)
- Task directories (`task_*`) are left unchanged (they use their own naming scheme)
- Runs automatically on startup if a marker file doesn't exist (`data/.session-migration-v1-done`)

**Files changed:** New file `src/migrate-sessions.ts`, called from `main()` in `index.ts` after `initDatabase()`.

## Removals

| Item | Location | Reason |
|------|----------|--------|
| `migrateThreadDirs()` | `container-runner.ts` (definition), `discord.ts` (import + call at line 502) | No longer needed — directories never rename |
| `messageThreadContext` Map | `index.ts` | Replaced by DB column |
| `activeConversation` Set | `discord.ts` | Replaced by explicit `threadContextId` parameter |
| Prefix-scan iteration in `sendMessage` | `discord.ts` | Replaced by exact-match lookup |
| Prefix-scan iteration in `sendFile` | `discord.ts` | Replaced by exact-match lookup |

## Additions

| Item | Location | Purpose |
|------|----------|---------|
| `thread_context_id` column | `messages` table | Persist thread association across restarts |
| `threadContextId` parameter | `Channel.sendMessage` | Exact send targeting |
| `migrate-sessions.ts` | `src/` | One-time directory rename on upgrade |

## Unchanged

- `GroupQueue` — already thread-aware, `isActive` already accepts optional `threadId`, `sendMessage` uses threadId for IPC paths which will naturally use `ctx-{id}` names since threadId flows through from the message loop. No code changes needed.
- `router.ts` — formatting logic stays the same
- Container image / agent-runner — no container-side changes
- Scheduled task flow — still sends to #general via `sendChannelMessage`, replies create threads as today
- `messageImages` in-memory Map — images stay in memory (too large for SQLite)

## Risk

- **Blast radius:** Touches `index.ts`, `discord.ts`, `container-runner.ts`, `db.ts`, `types.ts`. These are core files but the changes are surgical — restructuring the message loop grouping and swapping directory naming. No new architectural concepts.
- **Migration:** The one-time directory rename could fail if a directory is locked by a running container. Mitigation: run migration before starting the message loop and container system.
- **Rollback:** If the migration runs but the code change is reverted, session paths won't match. Mitigation: keep the migration idempotent and add a marker file.
