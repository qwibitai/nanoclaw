# NanoClaw E2E Testing Results

Date: 2026-03-08 (session 4: remaining tests — 7.8, 9.3, 9.4, 9.5)

## Unit Tests

347/347 pass (all passing as of session 2).

---

## Section 1: Startup & Channel Registration

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1.1 | Clean startup | ✅ | "Connected to 1 channel, 2 groups loaded" |
| 1.2 | Missing credentials | N/A | CLI channel requires no credentials; untestable without a credential-gated channel |
| 1.3 | Zero channels fatal exit | N/A | Would require removing CLI channel from source; untestable in this config |
| 1.4 | State recovery after SIGKILL | ✅ | Orphan cleanup logged at next startup |

## Section 2: Message Processing Pipeline

| # | Test | Result | Notes |
|---|------|--------|-------|
| 2.1 | Basic trigger | ✅ | `@Andy hello` → container spawns, agent responds |
| 2.2 | No trigger (non-main) | ✅ | Plain message to Telegram group (requires_trigger=1) → no response |
| 2.3 | Case-insensitive trigger | ✅ | Unit tested (`TRIGGER_PATTERN /^@Andy\b/i`) |
| 2.4 | Trigger at end invalid | ✅ | Unit tested (prefix match only) |
| 2.5 | Main group no trigger | ✅ | "hello there" triggered agent without `@Andy` |
| 2.6 | Context accumulation | ✅ | 3 msgs batched; agent acknowledged all three |
| 2.7 | Bot message filtering | ✅ | CLI `sendMessage` prints to console only — no bot messages stored in DB; confirmed `is_bot_message` flag via IPC path; no re-processing possible |
| 2.8 | Unregistered group | ✅ | Unit tested; confirmed "No channel" warning |

## Section 3: Container Lifecycle

| # | Test | Result | Notes |
|---|------|--------|-------|
| 3.1 | Container spawn | ✅ | `nanoclaw-cli-main-<ts>` visible in `docker ps` |
| 3.2 | Main mount verification | ✅ | project root (ro), `.env`→`/dev/null`, group (rw), `.claude` (rw) |
| 3.3 | Non-main mount verification | ✅ | mountCount=4, no project root, no .env shadow; `/workspace/extra` is an intentional placeholder for additional mounts |
| 3.4 | Output streaming | ✅ | Incremental output appeared |
| 3.5 | Internal tag stripping | ✅ | `<internal>this is hidden</internal>` → empty on delivery |
| 3.6 | Container cleanup | 🐛 | Bug found and fixed (see below) |
| 3.7 | Follow-up via IPC | ✅ | All messages piped to single container ("Piping input into active query") |
| 3.8 | Idle timeout | ✅ | With `IDLE_TIMEOUT=20000`: agent responded, idle timer fired 20s later, container closed gracefully (status: success) |

## Section 4: IPC & Authorization

| # | Test | Result | Notes |
|---|------|--------|-------|
| 4.1 | Send message (own group) | ✅ | Agent sent to `cli@local` — delivered |
| 4.2 | Send message (cross-group, non-main) | ✅ | Unit tested (33/33 ipc-auth tests pass) |
| 4.3 | Send message (cross-group, main) | ✅ | Unit tested |
| 4.4 | Register group (main) | ✅ | Unit tested |
| 4.5 | Register group (non-main) | ✅ | Unit tested |
| 4.6 | Unregister main group | ✅ | Unit tested |
| 4.7 | List groups (main) | ✅ | Unit tested |
| 4.8 | List groups (non-main) | ✅ | Unit tested |

## Section 5: Task Scheduling

| # | Test | Result | Notes |
|---|------|--------|-------|
| 5.1 | Create cron task | ✅ | Task created via `schedule_task` JSON-RPC |
| 5.2 | Create interval task | ✅ | Interval task ran and sent messages on schedule |
| 5.3 | Create one-shot task | ✅ | Fired once, did not repeat; required timezone fix first (see bugs) |
| 5.4 | Pause/resume task | ✅ | Task skipped while paused, resumed correctly |
| 5.5 | Cancel task | ✅ | Task deleted, stopped firing |
| 5.6 | Task result logging | ✅ | `task_run_logs` has `duration_ms`, `status`, `result` |
| 5.7 | Group context mode | ✅ | Scheduled task with `context_mode='group'` ran with group's existing session ID (`a0850c0e-...`); same ID confirmed in `newSessionId` on completion |
| 5.8 | Isolated context mode | ✅ | Task used fresh session each run |
| 5.9 | Invalid cron expression error | 🐛 | `cron-parser` accepts under-specified expressions (e.g. `* * *`, `* * * ?`) and non-standard field counts silently; produces wrong schedules with no error (see bugs) |

## Section 6: Concurrency & Queueing

| # | Test | Result | Notes |
|---|------|--------|-------|
| 6.1 | Concurrent limit | ✅ | Two Telegram groups triggered simultaneously — both containers spawned concurrently |
| 6.2 | Queue drain | ✅ | Both groups responded independently; no cross-group blocking |
| 6.3 | Task priority over messages | ✅ | Unit tested (group-queue.test.ts: "drains tasks before messages for same group") |
| 6.4 | Retry on failure | ✅ | Unit tested (group-queue.test.ts: "retries with exponential backoff on failure"); also confirmed live via 9.1 test |
| 6.5 | Max retries | ✅ | Unit tested (group-queue.test.ts: "stops retrying after MAX_RETRIES and resets") |
| 6.6 | Graceful shutdown (SIGTERM) | ✅ | SIGTERM during active container: "Shutdown signal received", "GroupQueue shutting down (containers detached, not killed)", channels disconnected, exit 0 |

## Section 7: Security & Isolation

| # | Test | Result | Notes |
|---|------|--------|-------|
| 7.1 | Group folder isolation | ✅ | Non-main group agent sees only `/workspace/group`, `/workspace/global`, `/workspace/extra` — no access to main group files |
| 7.2 | Project root read-only | ✅ | Main agent confirmed "Failed — file system is read-only" when attempting `echo test > /workspace/project/readonly-test.txt` |
| 7.3 | Global memory read-only | ✅ | Debug mount log shows `/workspace/global (ro)` for non-main groups; mount config confirmed during session 3 startup |
| 7.4 | `.env` shadow | ✅ | `/dev/null` mounted over `.env` (confirmed via `docker inspect`) |
| 7.5 | Secret handling | ✅ | No secrets in container env vars (`docker inspect`) |
| 7.6 | Path traversal rejection | ✅ | Regex + `ensureWithinBase` block `../etc` etc. |
| 7.7 | Mount allowlist | ✅ | No allowlist file = all additional mounts blocked |
| 7.8 | Sender allowlist (drop mode) | ✅ | Configured `cli@local` to drop all but `allowed-user`; temporarily set `is_from_me: false` in CLI channel; debug log confirmed "dropping message (drop mode)" for `cli-user`; DB count unchanged (52→52) |

## Section 8: State Persistence

| # | Test | Result | Notes |
|---|------|--------|-------|
| 8.1 | Cursor persistence | ✅ | After restart, only new message processed (messageCount: 1) |
| 8.2 | Session persistence | ✅ | Same session IDs for both groups after restart |
| 8.3 | Group registration persistence | ✅ | Both Telegram groups still registered after multiple restarts |
| 8.4 | Corrupted router state recovery | ✅ | Manually corrupted `last_agent_timestamp` to invalid JSON; startup logged `WARN: Corrupted last_agent_timestamp in DB, resetting`; state reset to `{}`; server continued normally |

## Section 9: Error Handling & Edge Cases

| # | Test | Result | Notes |
|---|------|--------|-------|
| 9.1 | Missing container image | ✅ | `CONTAINER_IMAGE=totally-fake-image-abc123:notreal`; spawn failed (code 125, "pull access denied"); cursor rolled back; retried with backoff (5s, 10s, 20s) |
| 9.2 | Container crash | ✅ | Injected `process.exit(1)` in agent-runner-src; container exited code 1, "Container exited with error" logged, cursor rolled back, retry scheduled |
| 9.3 | Timeout (no output) | ✅ | Agent hung after init with no output; `CONTAINER_GRACE_PERIOD_MS=3000 CONTAINER_TIMEOUT=5000` → timeout fired at 5s; "Container timed out with no output" logged; error result; cursor rolled back; retry with backoff scheduled |
| 9.4 | Timeout (after output) | ✅ | Agent sent `output` RPC then hung; same short timeout settings → "Container timed out after output (idle cleanup)" logged as INFO (not error); success result; cursor advanced (not rolled back) |
| 9.5 | Output truncation | ✅ | `CONTAINER_MAX_OUTPUT_SIZE=200`; normal agent response triggered both "Container stdout truncated due to size limit" and "Container stderr truncated due to size limit" WARN logs; container run continued to completion |
| 9.6 | Invalid JSON-RPC from container | ✅ | Injected `\0THIS IS NOT VALID JSON {{{` line; host logged it at DEBUG level and ignored it; valid RPC on next line processed correctly; no crash |

---

## Bugs Found & Fixed

### Bug: Container doesn't exit after close signal

**Symptom:** After receiving a `close` JSON-RPC notification, the container agent runner
logged "Close received during query, exiting" but the process never actually exited. The
`runContainerAgent` promise never resolved, blocking the GroupQueue from draining. Scheduled
tasks queued while a container was idle-waiting would never run.

**Root cause:** `main()` in `container/agent-runner/src/index.ts` returned normally after
receiving `close` but never called `process.exit()`. The `process.stdin.on('data')` listener
and the in-process MCP server kept the Node.js event loop alive indefinitely.

**Fix:**
```diff
-main();
+main().then(() => process.exit(0));
```

Applied to:
- `container/agent-runner/src/index.ts`
- `data/sessions/cli-main/agent-runner-src/index.ts`
- `data/sessions/cli-test/agent-runner-src/index.ts`
- Container image rebuilt

### Bug: Scheduled tasks with tool-call-only output idle-wait indefinitely

**Symptom:** A scheduled task that delivered output exclusively via `send_message` (a tool
call) left its container alive for the full 30-minute idle timeout after completing, blocking
the group queue from processing user messages.

**Root cause:** `scheduleClose()` in `task-scheduler.ts` and `resetIdleTimer()` in
`message-processor.ts` were gated on `result.result` being truthy. Tasks that used only tool
calls produced `result: null`, so neither timer was ever started.

**Fix:** Move timer starts to the `status === 'success'` block so they fire regardless of
output type. Committed as `947d06f`.

---

### Bug: `once` scheduled tasks fire at wrong time on non-UTC hosts

**Symptom:** Asking the agent to schedule a task "in 5 minutes" resulted in it firing ~8
hours later (the host's UTC offset). One-shot worked correctly once the agent was explicitly
told the local time.

**Root cause:** Message timestamps are stored and formatted as UTC ISO strings
(e.g. `2026-03-07T20:50:11.865Z`). The agent anchors its sense of "now" to these timestamps,
calculates future times in UTC, strips the `Z` because the tool's validator rejects timezone
suffixes, and passes a bare UTC timestamp. The host-side scheduler interprets bare timestamps
as local time, producing an offset by the UTC difference.

**Fix:** Normalize message timestamps to local time in `formatMessages()` using
`toLocalISOString()`. Committed as `bccf10c`.

---

### Change: `CONTAINER_GRACE_PERIOD_MS` made configurable

The hard timeout floor (`IDLE_TIMEOUT + 30_000`) was previously hardcoded, making timeout tests impractical (minimum 30s wait per test). A new `CONTAINER_GRACE_PERIOD_MS` env var (default `30000`) was added in `config.ts` and used in `container-runner.ts`. Setting it to `3000` in combination with short `IDLE_TIMEOUT` and `CONTAINER_TIMEOUT` values allows timeout tests to complete in ~5s rather than 30s+.

---

### Known Limitation: `cron-parser` accepts invalid expressions silently

`cron-parser` v5 accepts under-specified cron expressions (e.g. `* * *`, `* * * ?`) and
non-standard field counts without error, mapping fields to unexpected positions and producing
wrong schedules. The `?` day-of-week wildcard is also accepted despite not being standard
POSIX cron. Consider switching to a stricter parser or adding pre-validation against a known
field count.

---

### Known Limitation: Sub-minute cron schedules silently capped at once per minute

The scheduler polls every 60 seconds (`SCHEDULER_POLL_INTERVAL`). Tasks with schedules faster
than once per minute (e.g. `* * * * * *` every second) will only fire once per poll cycle
with no warning. The missed runs are silently dropped.

---

## Observations

### Agent sub-agents create duplicate scheduled tasks

Observed during testing with Haiku (`claude-haiku-4-5-20251001`): the model over-delegated
simple single-tool requests to sub-agents via the agent teams feature, causing each sub-agent
to independently call `schedule_task` and creating 3-4 identical tasks. Not a code bug —
expected to be a non-issue with Sonnet/Opus.

### CLI channel only owns a single JID

The CLI channel hardcodes `CLI_JID = 'cli@local'`, so it can only be used to test one group.
Tests requiring a second group (non-main trigger logic, cross-group IPC, mount isolation,
concurrency) need a real messaging channel (WhatsApp, Telegram, Slack) or a CLI channel
extended to support multiple JIDs. Session 2 used the Telegram channel with two chats to
cover these cases.

### Telegram group privacy mode must be disabled

By default, Telegram bots have group privacy mode enabled, which blocks the bot from
receiving @mentions and regular messages in groups (only commands like `/chatid` get through).
Privacy mode must be disabled via BotFather for non-main group testing to work. Re-adding the
bot to the group is required after changing the setting.

### Session 3: automated testing via CLI channel

Session 3 used the CLI channel with a registered `cli@local` group (`is_main=1`) to automate tests without manual message entry. Messages were piped to the server via stdin (`printf "..." | node dist/index.js`). For tests requiring deliberate container failures, the per-group `agent-runner-src` at `data/sessions/cli-test/agent-runner-src/index.ts` was temporarily modified (the mount makes it writable) and restored afterwards. Scheduler-based tests used past-due tasks inserted directly into the DB; the scheduler fires immediately on startup so no 60s wait was required.

### Session 4: remaining tests via CLI channel

Session 4 covered the four previously untested cases. Tests 9.3 and 9.4 required a configurable grace period (previously hardcoded at 30s as `IDLE_TIMEOUT + 30_000`). `CONTAINER_GRACE_PERIOD_MS` was added as an env var to `config.ts` and `container-runner.ts`, making the floor testable in seconds. The agent-runner-src was temporarily replaced with minimal stubs (hang-only for 9.3; send-output-then-hang for 9.4) and restored afterwards. Test messages for 9.3–9.5 were inserted directly into the DB rather than piped via stdin (stdin-piped messages are stored before the message loop starts, but the process exits on EOF before the polling loop can pick them up). Test 7.8 required `is_from_me: false` on CLI messages temporarily, since the drop-mode check only applies to non-own messages.

### `send_message` tool target JID is not agent-configurable

The `mcp__nanoclaw__send_message` tool only exposes `text` and `sender` parameters — the
target JID is baked in at container startup from `context.chatJid`. Agents cannot attempt
cross-group message delivery via this tool, making tests 4.2/4.3 (cross-group send
authorization) not exercisable through normal agent interaction. The authorization logic is
covered by unit tests (33/33 ipc-auth tests pass).
