# Codebase Concerns

**Analysis Date:** 2026-02-27

## Performance Bottlenecks

### SQLite Query Load on Large Message Histories

**Problem:** `getMessagesSince()` and `getNewMessages()` scan the entire messages table with timestamp filtering but no pagination. As message history grows (potentially thousands per group), these queries may slow down.

**Files:** `src/db.ts` (lines 292-341), `src/index.ts` (lines 137-244)

**Impact:** Message processing latency increases proportionally with total message count in DB. No visible symptom until 10k+ messages per group.

**Improvement path:**
- Add LIMIT clause to message queries (e.g., fetch last 500 messages within timestamp range)
- Consider archiving old messages to separate table or S3
- Add query performance index on (chat_jid, timestamp)

### Container Output Accumulation

**Problem:** `container-runner.ts` accumulates all stdout/stderr in memory (lines 348-437). With verbose agents or long-running containers, this can exhaust memory.

**Files:** `src/container-runner.ts` (lines 348-437)

**Concern:** `CONTAINER_MAX_OUTPUT_SIZE` limit (config) caps output, but truncation can hide critical errors. No streaming to disk for long-lived containers.

**Improvement path:**
- Stream output to disk after threshold instead of truncating
- Implement rolling file-based logging for container output
- Consider async decompression for archived logs

## Fragile Areas

### Message Cursor Rollback Logic

**Problem:** Complex state management in message processing: after advancing `lastAgentTimestamp`, if an error occurs and output was sent to user, the cursor is NOT rolled back to prevent duplicates (lines 224-241 in `src/index.ts`). If output was NOT sent, cursor is rolled back. This is correct but fragile.

**Files:** `src/index.ts` (lines 137-244)

**Why fragile:**
- Logic depends on accurate `outputSentToUser` flag tracking
- If streaming callback fails after setting flag, cursor won't roll back even though data may be lost
- Race condition possible if message arrives between cursor advance and container spawn

**Safe modification:**
- Wrap cursor advance in try-finally that restores on any exception
- Use database transaction to atomically update cursor + log container start
- Add integration tests for crash scenarios

### Idle Timeout & Container Cleanup Race

**Problem:** Multiple timeout mechanisms interact without clear coordination:
1. Container hard timeout at `IDLE_TIMEOUT + 30s` (line 444 in `src/container-runner.ts`)
2. IPC close sentinel written after agent finishes + TASK_CLOSE_DELAY_MS (line 128 in `src/task-scheduler.ts`)
3. Group queue idle waiting state (line 146 in `src/group-queue.ts`)

**Files:** `src/container-runner.ts`, `src/task-scheduler.ts`, `src/group-queue.ts`

**Impact:** If IPC close sentinel is lost or delayed, container hangs until hard timeout. Unpredictable cleanup order.

**Test coverage:** Integration tests don't cover timeout expiry with concurrent IPC writes.

### Per-Group IPC Directory Isolation

**Problem:** IPC authorization checked at task level (sourceGroup vs. targetGroup) but filesystem is hierarchical. A compromised agent could theoretically:
1. Access sibling group's IPC directory by path traversal if container escapes mount isolation
2. Modify messages/tasks files before the IPC watcher reads them

**Files:** `src/ipc.ts` (lines 77-98), `src/container-runner.ts` (lines 156-166)

**Current mitigation:**
- Read-only containers + writable IPC namespace per-group
- Authorization checks in `processTaskIpc()` verify sourceGroup identity

**Remaining risk:** If container-runner mounts are misconfigured or Docker escape occurs, IPC isolation fails silently.

## Scaling Limits

### Concurrent Container Limit

**Problem:** `MAX_CONCURRENT_CONTAINERS` (config) limits active containers to prevent resource exhaustion. Once limit reached, groups queue in `waitingGroups` array (line 33 in `src/group-queue.ts`). Queue drains sequentially.

**Current:** Likely set to 3-5. With 20+ registered groups, users experience queue wait times proportional to container execution time.

**Scaling path:**
- Monitor actual resource usage (CPU/memory per container)
- Implement adaptive concurrency based on available resources
- Add priority queue (e.g., main group always runs immediately)
- Provide metrics endpoint showing queue depth

### Database Connection Pooling

**Problem:** Single `better-sqlite3` connection (line 15 in `src/db.ts`). Synchronous API means all database operations block the event loop.

**Impact:**
- Large schema migrations can freeze message loop for seconds
- IPC task creation (DB write) blocks polling loop
- No connection pool = no parallelism even if async APIs available

**Risk:** Acceptable for current scale (1-3 groups). Breaks at 10+ concurrent message streams.

**Fix:** Migrate to `bun:sqlite` or `node-sqlite3` with connection pooling.

## Tech Debt

### WhatsApp WebAPI Version Fallback

**Problem:** `fetchLatestWaWebVersion()` can fail (network timeout, rate limit). Fallback uses hardcoded version or random old version (lines 63-70 in `src/whatsapp-auth.ts`, lines 64-71 in `src/channels/whatsapp.ts`).

**Files:** `src/whatsapp-auth.ts`, `src/channels/whatsapp.ts`

**Issue:** Stale version causes connection failures. No automatic retry or version refresh mechanism.

**Improvement:**
- Cache known-good version in config
- Implement exponential backoff for version fetch
- Store version in DB with freshness timestamp

### Manual JSON State Migrations

**Problem:** DB schema migrations use ad-hoc try-catch blocks for ALTER TABLE (lines 88-128 in `src/db.ts`). No migration framework, manual backfill of added columns.

**Files:** `src/db.ts` (lines 88-128), plus legacy JSON-to-DB migration (lines 611-669)

**Risk:** Schema changes require careful sequencing. Hard to track which migrations have run.

**Better approach:** Implement migration framework (sql-migrate, umzug) with version tracking table.

### String-Based Type Casting

**Problem:** `JSON.stringify()` and `JSON.parse()` used throughout for type conversion:
- `lastAgentTimestamp` stored as JSON string in router_state (lines 81 in `src/index.ts`)
- container_config stored as JSON string in DB (line 550 in `src/db.ts`)
- Task context_mode checked with string equality (line 257 in `src/ipc.ts`)

**Files:** `src/index.ts`, `src/db.ts`, `src/ipc.ts`

**Impact:** Silent type mismatches if JSON schema changes. Difficult to refactor.

**Fix:** Use proper serialization library or TypeScript discriminated unions for type safety.

## Security Considerations

### Keychain Token Fallback Without Verification

**Problem:** `readKeychainToken()` reads macOS keychain without schema validation (lines 226-238 in `src/container-runner.ts`). Expects JSON with specific structure but crashes if malformed.

**Files:** `src/container-runner.ts` (lines 226-238)

**Risk:** If keychain is corrupted or contains unexpected data, token parsing silently fails. No warning to user that auth token is missing.

**Mitigation:**
- Wrap JSON.parse in try-catch (already done)
- Log warning if token is missing AND not in .env
- Validate token format before passing to container

### Mount Allowlist Not Reloaded

**Problem:** Mount allowlist loaded once at startup (line 54-62 in `src/mount-security.ts`). Changes to `~/.config/nanoclaw/mount-allowlist.json` require service restart.

**Files:** `src/mount-security.ts`

**Risk:** Low. Allowlist is outside project root. But no audit trail of mount changes.

**Improvement:** Watch allowlist file for changes and reload on update.

### IPC Task Authorization Checked by Directory Name

**Problem:** IPC processor determines sourceGroup from directory path (line 61-62 in `src/ipc.ts`). If directory structure is exploited (symlinks, race condition during file creation), sourceGroup can be spoofed.

**Files:** `src/ipc.ts` (lines 45-157)

**Current mitigation:** Container IPC directory is per-group and mounted read-write only to that group. Symlinks resolve to real path.

**Remaining risk:** If multiple IPC processors run concurrently (e.g., during hot reload), race condition in directory scanning could allow out-of-order task execution.

**Fix:** Add sequence number / timestamp to IPC files to detect reordering.

## Known Bugs

### Max Retries Silent Drop

**Problem:** When message processing fails 5 times, `scheduleRetry()` silently drops the messages (line 264 in `src/group-queue.ts`). No alert to user or log entry except "Max retries exceeded".

**Files:** `src/group-queue.ts` (lines 259-280)

**Symptom:** Messages disappear without user knowledge.

**Workaround:** User must check logs to find dropped messages.

**Fix:** Send notification to main group that messages were dropped, suggest manual re-send.

### Task Run Log Orphans

**Problem:** If task is deleted (line 427-429 in `src/db.ts`), foreign key cascade deletes run_logs automatically. But if deletion fails partway, logs are orphaned (no task_id reference).

**Files:** `src/db.ts` (lines 426-430)

**Current:** SQLite with FOREIGN KEY pragmas enabled prevents inconsistency. But edge case if pragma is disabled.

**Recommendation:** Verify PRAGMA foreign_keys = ON in `createSchema()`.

## Test Coverage Gaps

### Container Timeout After Output

**What's not tested:** Container times out AFTER sending output (idle cleanup). The code handles this correctly (lines 494-506 in `src/container-runner.ts`) but no test verifies the timeout doesn't also trigger error resolution.

**Files:** `src/container-runner.ts` (lines 471-520)

**Risk:** If timeout logic changes, silent failures possible.

### Message Cursor Rollback

**What's not tested:**
- Cursor rollback when output sent vs. not sent (see Fragile Areas)
- Concurrent message arrival during cursor advance
- Database corruption/constraint violations during state save

**Files:** `src/index.ts` (lines 137-244)

**Risk:** Data loss on crash between cursor advance and message send.

### IPC Task Authorization

**What's not tested:** Non-main group attempting to schedule task for different group (should be blocked). Authorization checks exist (line 209 in `src/ipc.ts`) but no test coverage.

**Files:** `src/ipc.ts` (lines 187-276)

**Risk:** Privilege escalation if check is accidentally removed.

### Mount Allowlist Validation

**What's not tested:**
- Symlink resolution edge cases (absolute symlinks, circular chains)
- Race between allowlist reload and mount validation
- Blocked patterns with wildcards

**Files:** `src/mount-security.ts`

**Risk:** Restrictive allowlist may reject valid mounts; permissive allowlist may allow unintended access.

## Missing Critical Features

### Graceful Shutdown of Long-Running Containers

**Problem:** `index.ts` shutdown handler calls `queue.shutdown()` which only detaches containers (lines 452-459 in `src/index.ts`). Containers continue running in background, consuming resources indefinitely.

**Files:** `src/index.ts` (lines 452-459), `src/group-queue.ts` (lines 343-360)

**Impact:** Multiple service restarts leave orphaned containers. User must manually `docker ps -a` and kill.

**Fix:** Implement graceful shutdown: send _close sentinel to active containers, wait for clean exit (with hard timeout).

### No Duplicate Message Detection

**Problem:** Message IDs are stored in DB but no deduplication check before processing. If the same message arrives twice (network retry, WhatsApp bug), agent processes it twice.

**Files:** `src/db.ts` (line 251-263), `src/index.ts` (lines 346-362)

**Current:** Timestamp ordering is used, but no constraint preventing duplicate inserts.

**Fix:** Upsert logic checks id+chat_jid PRIMARY KEY, so duplicates are idempotent. But add warning log if duplicate detected.

### No Health Check Endpoint

**Problem:** Service has no HTTP endpoint for health checks. External monitors cannot detect if NanoClaw is alive.

**Impact:** Load balancers or uptime monitors cannot detect hung state.

**Fix:** Add simple HTTP server with `/health` endpoint that checks DB connectivity and reports queue depth.

---

*Concerns audit: 2026-02-27*
