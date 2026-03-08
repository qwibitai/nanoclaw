# NanoClaw Manual End-to-End Testing Checklist

## Prerequisites

```bash
npm run build
./container/build.sh
# .env configured with at least one channel's credentials
# At least one messaging channel available (WhatsApp, Telegram, Slack, etc.)
```

## Observation Tools

```bash
# Logs (run in separate terminal)
npm run dev  # or tail -f on pino output

# Database inspection
sqlite3 store/messages.db

# Container state
docker ps          # active containers
docker logs <name> # container output

# Group logs
ls groups/*/logs/
```

---

## 1. Startup & Channel Registration

- [ ] **1.1 Clean startup** — `npm run dev` with valid credentials
  - All configured channels connect
  - "Connected to N channels" logged
- [ ] **1.2 Missing credentials** — Remove one channel's env vars, restart
  - Warning logged ("credentials missing")
  - Other channels still connect
- [ ] **1.3 Zero channels** — Remove all channel credentials
  - Fatal error, process exits
- [ ] **1.4 State recovery** — Kill with `SIGKILL`, restart
  - `recoverPendingMessages()` runs
  - No messages lost

## 2. Message Processing Pipeline

- [ ] **2.1 Basic trigger** — Send `@Andy hello` to registered group
  - Container spawns, agent responds, response appears in chat
- [ ] **2.2 No trigger** — Send `hello` to non-main registered group with `requiresTrigger=true`
  - No container spawned
  - Message stored in DB only
- [ ] **2.3 Case-insensitive trigger** — Send `@ANDY hello`
  - Triggers normally
- [ ] **2.4 Trigger at end (invalid)** — Send `hello @Andy`
  - Does NOT trigger (prefix match only)
- [ ] **2.5 Main group (no trigger needed)** — Send any message to main group
  - Always triggers (main groups don't require trigger)
- [ ] **2.6 Context accumulation** — Send 3 messages without trigger, then `@Andy summarize`
  - Agent receives all 4 messages as XML context
- [ ] **2.7 Bot message filtering** — Check DB after agent responds
  - Agent's own messages have `is_bot_message=1`
  - Excluded from next prompt
- [ ] **2.8 Unregistered group** — Send `@Andy hello` to unregistered group
  - Ignored completely, no container

## 3. Container Lifecycle

- [ ] **3.1 Container spawn** — Trigger message, run `docker ps`
  - Container visible with correct name pattern
- [ ] **3.2 Mount verification (main)** — Trigger in main group, inspect mounts
  - Project root (ro), group folder (rw), global memory (ro), .claude/ (rw)
- [ ] **3.3 Mount verification (regular)** — Trigger in regular group, inspect mounts
  - Group folder (rw), global memory (ro), .claude/ (rw)
  - NO project root
- [ ] **3.4 Output streaming** — Trigger multi-step response
  - Incremental output appears (not all at once)
- [ ] **3.5 Internal tag stripping** — Agent uses `<internal>reasoning</internal>`
  - Stripped from user-visible output
- [ ] **3.6 Container cleanup** — After response completes, check `docker ps`
  - Container removed (or idle-waiting if IDLE_TIMEOUT active)
- [ ] **3.7 Follow-up message** — While container idle-waiting, send another message
  - Message piped to active container via IPC (no new container)
- [ ] **3.8 Idle timeout** — Wait IDLE_TIMEOUT after last output
  - Container stops gracefully, treated as success

## 4. IPC & Authorization

- [ ] **4.1 Send message (own group)** — Agent in group A sends message to group A's JID
  - Message delivered
- [ ] **4.2 Send message (cross-group, non-main)** — Agent in group A sends to group B's JID
  - Error -32000 (unauthorized)
- [ ] **4.3 Send message (cross-group, main)** — Agent in main sends to group B's JID
  - Message delivered
- [ ] **4.4 Register group (main)** — Main agent calls `register_group`
  - Group registered, folder created
- [ ] **4.5 Register group (non-main)** — Non-main agent calls `register_group`
  - Error -32000 (unauthorized)
- [ ] **4.6 Unregister main group** — Main agent tries to unregister itself
  - Error (protected)
- [ ] **4.7 List groups (main)** — Main agent calls `list_groups`
  - Returns all chats with metadata
- [ ] **4.8 List groups (non-main)** — Non-main agent calls `list_groups`
  - Error (unauthorized)

## 5. Task Scheduling

- [ ] **5.1 Create cron task** — Agent calls `schedule_task` with cron `*/2 * * * *`
  - Task created, runs every 2 minutes
- [ ] **5.2 Create interval task** — Agent calls `schedule_task` with interval 120000
  - Task runs every 2 minutes, no drift
- [ ] **5.3 Create one-shot task** — Agent schedules once at future timestamp
  - Runs once, status becomes 'completed'
- [ ] **5.4 Pause/resume task** — Pause active task, wait past due time, resume
  - Task skips while paused, runs after resume
- [ ] **5.5 Cancel task** — Cancel a scheduled task
  - Task deleted, run logs cleared
- [ ] **5.6 Task result logging** — Run task, check `task_run_logs` table
  - duration_ms, status, result, run_at populated
- [ ] **5.7 Group context mode** — Schedule with `context_mode='group'`
  - Uses group's persistent Claude session
- [ ] **5.8 Isolated context mode** — Schedule with `context_mode='isolated'`
  - Fresh session each run
- [ ] **5.9 Invalid cron** — Schedule with `* * *` (invalid)
  - Error -32602 with details

## 6. Concurrency & Queueing

- [ ] **6.1 Concurrent limit** — Set `MAX_CONCURRENT_CONTAINERS=2`, trigger 4 groups
  - Only 2 containers active, others queued
- [ ] **6.2 Queue drain** — After first 2 finish, check
  - Next 2 start automatically
- [ ] **6.3 Task priority** — Queue message and task for same group
  - Task runs before message
- [ ] **6.4 Retry on failure** — Force container failure (e.g., bad image)
  - Retries with exponential backoff (5s, 10s, 20s...)
- [ ] **6.5 Max retries** — Force 5+ consecutive failures
  - Stops retrying after 5, waits for next message
- [ ] **6.6 Graceful shutdown** — SIGTERM while containers running
  - Queue stops accepting work, waits 10s, detaches containers

## 7. Security & Isolation

- [ ] **7.1 Group folder isolation** — Agent in group A tries `ls /workspace/`
  - Cannot see group B's files
- [ ] **7.2 Project root read-only** — Main agent tries to write to `/workspace/project/`
  - Write fails (read-only mount)
- [ ] **7.3 Global memory read-only** — Non-main agent tries to write to `/workspace/global/`
  - Write fails (read-only mount)
- [ ] **7.4 .env shadow** — Main agent tries `cat /workspace/project/.env`
  - File is `/dev/null` (shadowed)
- [ ] **7.5 Secret handling** — Check container logs and `docker inspect`
  - No secrets in env vars, logs, or mounts
- [ ] **7.6 Path traversal** — Try to register group with folder `../etc`
  - Rejected (invalid folder name)
- [ ] **7.7 Mount allowlist** — Add blocked path to additional mounts
  - Rejected by `validateAdditionalMounts()`
- [ ] **7.8 Sender allowlist (drop)** — Configure drop mode, send from denied sender
  - Message silently discarded

## 8. State Persistence

- [ ] **8.1 Cursor persistence** — Process message, restart, send another
  - Only new message processed (cursor restored from DB)
- [ ] **8.2 Session persistence** — Run agent, restart, run again in same group
  - Same session ID used (conversation context preserved)
- [ ] **8.3 Group registration persistence** — Register group, restart
  - Group still registered
- [ ] **8.4 Corrupted router state** — Manually corrupt `router_state` JSON in DB, restart
  - Warning logged, state reset, no crash

## 9. Error Handling & Edge Cases

- [ ] **9.1 Missing container image** — Set `CONTAINER_IMAGE` to nonexistent tag
  - Spawn error, message retried
- [ ] **9.2 Container crash** — Agent hits unrecoverable error
  - Exit code != 0, error logged, cursor rolled back
- [ ] **9.3 Timeout (no output)** — Container hangs without producing output
  - Hard kill after CONTAINER_TIMEOUT, error response
- [ ] **9.4 Timeout (after output)** — Container produces output then hangs
  - Idle cleanup (success), no error
- [ ] **9.5 Output truncation** — Agent produces >10MB output
  - Truncated, logged, continues
- [ ] **9.6 Invalid JSON-RPC** — Container sends malformed JSON on stdout
  - Logged as debug, ignored (no crash)

---

## Suggested Testing Order

1. **Startup (1.1-1.4)** — verify the system runs at all
2. **Basic message flow (2.1, 2.5, 3.1, 3.4)** — core happy path
3. **Trigger logic (2.2-2.4, 2.6-2.8)** — message filtering
4. **Container lifecycle (3.2-3.8)** — mounts, streaming, cleanup
5. **IPC authorization (4.1-4.8)** — security boundaries
6. **Task scheduling (5.1-5.9)** — cron/interval/once
7. **Concurrency (6.1-6.6)** — queue behavior under load
8. **Security (7.1-7.8)** — isolation and access control
9. **Persistence (8.1-8.4)** — state survives restarts
10. **Error handling (9.1-9.6)** — graceful degradation

## Verification Commands

```bash
# Check message was stored
sqlite3 store/messages.db "SELECT id, jid, body, is_bot_message FROM messages ORDER BY id DESC LIMIT 5;"

# Check group registration
sqlite3 store/messages.db "SELECT * FROM groups;"

# Check task scheduling
sqlite3 store/messages.db "SELECT * FROM scheduled_tasks;"

# Check task run logs
sqlite3 store/messages.db "SELECT * FROM task_run_logs ORDER BY run_at DESC LIMIT 5;"

# Check router state
sqlite3 store/messages.db "SELECT * FROM router_state;"

# Inspect container mounts
docker inspect <container-name> --format '{{json .Mounts}}' | jq

# Check container environment (should be clean)
docker inspect <container-name> --format '{{json .Config.Env}}' | jq
```
