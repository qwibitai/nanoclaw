# Thread-Based Parallel Conversations & Obsidian Knowledge Base

**Date:** 2026-03-19
**Status:** Draft

## Problem

NanoClaw currently supports one active conversation per Discord channel. A new `@NanoClaw` mention clears the previous thread and starts fresh. This prevents parallel conversations and loses conversational context when replying to scheduled task outputs.

## Goals

- Enable multiple parallel conversations with NanoClaw in the same channel, each in its own Discord thread
- Replies to any NanoClaw message (including scheduled task outputs) open a thread and continue the relevant session
- All threads within a group share long-term knowledge via an Obsidian-compatible vault
- Each thread gets an isolated Claude session (no cross-talk between concurrent conversations)

## Non-Goals

- Cross-channel threading (each channel manages its own threads independently)
- Multi-user thread permissions (any allowed sender can participate in any thread)
- Real-time collaboration between threads (they share knowledge via files, not live state)

---

## Design

### 1. Thread Routing Model

Thread ID becomes the routing key, replacing the current one-thread-per-channel model.

**Inbound routing rules:**

| Message Location | Action |
|---|---|
| `#general` with `@NanoClaw` mention | Create new thread context, spawn thread on first response |
| `#general` replying to a NanoClaw message | Look up thread context by `origin_message_id`, create thread if none exists |
| Inside a bot-created thread | Route to existing thread context by `thread_id` |
| Reply to NanoClaw within a thread | Same thread context (same `thread_id`) |

**Outbound routing rules:**

| Source | Destination |
|---|---|
| Normal agent response | The thread associated with the thread context |
| Scheduled task initial output | `#general` as top-level message |
| Reply to scheduled task output | New thread on the original message |

**Key change in Discord channel:** Replace single `pendingTrigger` / `activeThread` per channel with a map of thread contexts keyed by thread ID. Multiple threads can be active simultaneously.

### 2. Thread Context Management

New `thread_contexts` table replaces `active_threads`:

```sql
CREATE TABLE thread_contexts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid          TEXT NOT NULL,       -- parent channel (e.g., dc:123456)
  thread_id         TEXT,                -- Discord thread ID (NULL before thread created)
  session_id        TEXT,                -- Claude session ID for this thread
  origin_message_id TEXT,                -- Discord message that spawned this thread
  source            TEXT NOT NULL,       -- 'mention' | 'reply' | 'scheduled_task'
  task_id           INTEGER,             -- FK to scheduled_tasks (if source=scheduled_task)
  created_at        TEXT NOT NULL,    -- ISO 8601 (matches existing codebase convention)
  last_active_at    TEXT NOT NULL     -- ISO 8601
);

CREATE INDEX idx_thread_ctx_chat ON thread_contexts(chat_jid);
CREATE INDEX idx_thread_ctx_thread ON thread_contexts(thread_id);
CREATE INDEX idx_thread_ctx_origin ON thread_contexts(origin_message_id);
```

**Lifecycle:**

1. **Create** — new trigger or reply detected, no existing thread context. `thread_id` may be NULL initially (set when Discord thread is actually created on first response).
2. **Resume** — message arrives in a known thread. Look up by `thread_id`, pass stored `session_id` to container.
3. **Expire** — checked lazily on each thread context lookup: if `last_active_at` is older than `THREAD_EXPIRY_HOURS` (default 24h), the context is considered stale for routing purposes. No background timer needed. Session data persists on disk. Replying to a stale thread resurrects it by updating `last_active_at`.
4. **No hard delete** — thread contexts are cheap. Old ones stop being active but retain their session mapping for future resurrection.

**Session ID flow:**

- First message in new thread → container runs with no session ID → returns new session ID → stored in `thread_contexts`
- Subsequent messages → container resumes with stored session ID
- Scheduled task → runs with isolated session → session ID stashed in `thread_contexts` with `source='scheduled_task'` and `thread_id=NULL`. When user replies, thread is created and context updated with `thread_id`.

### 3. Container Concurrency

Currently `group-queue.ts` enforces one container per group. This changes to **one container per active thread**, bounded by a per-group cap.

**Changes to GroupQueue:**

- Process registry keyed by `{groupJid}:{threadId}` compound key instead of `groupJid` alone
- Per-group operations (message piping, idle detection, stdin close) scoped to the specific thread's container
- New per-group concurrency limit: `MAX_CONTAINERS_PER_GROUP` (default 3)
- If a group hits its cap, new thread messages queue FIFO per-thread within the group
- Global `MAX_CONCURRENT_CONTAINERS` still applies across all groups

**Container naming:** `nanoclaw-{groupFolder}-{threadId}-{timestamp}`

**IPC namespacing:** Both inbound and outbound IPC are namespaced per thread:
- Outbound (agent → host): `data/ipc/{groupFolder}/{threadId}/messages/` — host watches per-thread directories
- Inbound (host → agent): `data/ipc/{groupFolder}/{threadId}/input/` — follow-up messages routed to the correct container by thread ID
- Sentinel: `data/ipc/{groupFolder}/{threadId}/input/_close` — per-thread container shutdown

**Claude SDK session isolation:** Currently `.claude/` is mounted per-group at `data/sessions/{groupFolder}/.claude/`. With concurrent containers, this must be per-thread: `data/sessions/{groupFolder}/{threadId}/.claude/`. Each container gets its own SDK state directory, preventing lock file and settings conflicts between concurrent containers. The `settings.json` (env vars, permissions) is copied from a shared group template at container start.

**Shared filesystem:**

- All containers for a group mount the same `groups/{folder}/` workspace (read-write)
- Knowledge vault writes are naturally safe due to Obsidian's many-small-files model (see Section 5)

### 4. Scheduled Task Integration

**On task execution:**

1. Task runs in an isolated session (no thread context yet)
2. Output posted to `#general` via `sendChannelMessage` which must now **return the posted message's ID** (update `ChannelInterface.sendChannelMessage` return type from `void` to `Promise<string | undefined>` where the string is the platform message ID)
3. Thread context created: `source='scheduled_task'`, `session_id` from the run, `origin_message_id` from the returned message ID, `thread_id=NULL`, `task_id` referencing the scheduled task

**On user reply to scheduled task message:**

1. Discord `messageCreate` fires — detect it's a reply to a known `origin_message_id`
2. Look up thread context → find stashed session ID
3. Create Discord thread on the original message
4. Update thread context with new `thread_id`
5. Spawn container resuming that session → response goes to thread

**On subsequent replies in that thread:**

- Normal thread routing — context already has `thread_id` and `session_id`

**Multiple runs of the same task:**

Each execution creates a new thread context with a new session. Monday's report and Tuesday's report are independent — replying to Monday's message opens a thread with Monday's session, Tuesday's opens a separate one.

### 5. Obsidian Knowledge Base

**Vault location:** `groups/{name}/knowledge/` — one vault per group, mounted into all containers at `/workspace/group/knowledge/`.

**Initial structure:**

```
knowledge/
  .obsidian/           -- minimal Obsidian config (generated at setup)
  people/              -- people the agent learns about
  projects/            -- ongoing work, goals, status
  preferences/         -- user preferences, communication style
  decisions/           -- key decisions and rationale
  reference/           -- facts, links, resources
```

**Agent instructions** (added to group `CLAUDE.md`):

- Read relevant notes from `knowledge/` at conversation start for context
- Create/update notes when learning something worth remembering
- Use `[[wiki-links]]` between notes and YAML frontmatter for metadata
- One concept per file, descriptive filenames (e.g., `people/alex-backend-lead.md`)
- Never delete notes — mark outdated ones with a `deprecated: true` frontmatter flag
- After creating or updating notes, stage and commit with a descriptive message
- If a git remote is configured, push after committing

**Version control:**

- Each `knowledge/` folder is its own git repository (separate from the NanoClaw repo)
- NanoClaw's root `.gitignore` adds `groups/*/knowledge/` to prevent repo nesting
- `.gitignore` inside the vault ignores `.obsidian/workspace.json` and other Obsidian cache files; keeps `.obsidian/` config tracked
- User can add a remote to sync to GitHub; agent pushes automatically when a remote exists

**Concurrent write safety:**

- Obsidian's many-small-files model naturally minimizes conflicts
- Agent instructions steer toward creating new notes rather than modifying existing ones
- For the rare case of two threads writing the same file, last-write-wins is acceptable for knowledge notes
- Git history preserves all versions regardless

**User access:**

Point Obsidian at `groups/{name}/knowledge/` as a vault. Browse, search, edit, and graph the agent's knowledge. User edits are immediately visible to future agent sessions.

---

## Migration

- Rename/migrate `active_threads` table to `thread_contexts` with new columns
- Existing `active_threads` rows get `source='mention'`, NULL for new columns, timestamps set to migration time
- No breaking changes to other channels (WhatsApp, Telegram, Slack) — thread contexts are Discord-specific initially
- `sendChannelMessage` behavior unchanged for non-threaded channels

## Configuration

| Setting | Default | Description |
|---|---|---|
| `MAX_CONTAINERS_PER_GROUP` | 3 | Max concurrent containers per group |
| `THREAD_EXPIRY_HOURS` | 24 | Hours of inactivity before thread context goes stale |

## Testing

- Unit: thread context CRUD, session lookup by origin_message_id, IPC namespacing
- Integration: concurrent containers for same group, scheduled task → reply → thread flow
- Manual: Discord thread creation, parallel conversations, Obsidian vault browsing
