# State — NanoClaw Concurrent Sessions

## Project Reference

- **Core value:** Messages never blocked by running containers
- **Current focus:** WhatsApp voice note sending infrastructure
- **Airtable record:** `recFADjzpnBY8NHh4`

## Current Position

- **Phase:** 04-whatsapp-voice-notes (Plan 2 of 2 complete)
- **Plan:** 04-02 complete — phase done
- **Status:** Complete
- **Progress:** [██████████] 100%

## Performance Metrics

| Metric          | Value |
| --------------- | ----- |
| Phases total    | 4     |
| Phases complete | 4     |
| Plans total     | 9     |
| Plans complete  | 9     |
| Tasks total     | 22    |
| Tasks complete  | 22    |

| Phase | Plan | Duration | Tasks | Files |
| ----- | ---- | -------- | ----- | ----- |
| 01    | 01   | 308s     | 2     | 1     |
| 01    | 02   | 268s     | 2     | 3     |
| 01    | 03   | 128s     | 1     | 1     |
| 02    | 01   | 188s     | 2     | 4     |
| 02    | 02   | 170s     | 1     | 4     |
| 04    | 01   | 151s     | 2     | 7     |
| 04    | 02   | 110s     | 2     | 3     |

## Accumulated Context

### Key Decisions

- Callbacks on GroupQueue (not direct import) — keeps GroupQueue decoupled from session-awareness
- onContainerStart fires in registerProcess (not runForGroup) — both containerId and groupFolder known
- onContainerExit fires before containers.delete in finally — slot data still available
- readActiveSessionsFile validates JSON shape, returns empty on corrupt — defensive for container-side readers
- ContainerSlot map replaces active boolean for multi-container support
- pendingRegistrations map bridges containerId from runForGroup to registerProcess
- containerId parameter made optional on public API for backward compatibility
- Idle container reuse checked before global cap (no new slot cost)
- Extract containerId from processMessagesFn mock calls for precise slot targeting in tests
- Use completion callback arrays for concurrent container control in tests
- Fresh session per container (sessionId=undefined) for CONC-02 — idle-reuse containers already have session internally
- Task session logic preserved — context_mode 'group' resumes group session, 'isolated' fresh
- QueuedTask.fn receives containerId from GroupQueue.runTask for explicit threading
- containerId added to ContainerInput interface — container needs it to filter self from active sessions
- Session awareness read once on startup, not per query — point-in-time snapshot is sufficient
- XML <active-sessions> block prepended to prompt — matches existing Claude context block convention
- No retry/queuing for audio — large and ephemeral, caller can retry (unlike text messages)
- Same authorisation rules for send_audio as send_message — isMain or same group folder
- Audio files cleaned up immediately after sending to avoid disk accumulation
- Container send_audio MCP tool copies audio (not moves) so original remains for retry
- No WAV→OGG conversion in MCP tool — container agent responsible (ffmpeg available)

### Technical Notes

- `session-awareness.ts` writes `data/ipc/{group}/active_sessions.json` with atomic temp+rename
- GroupQueue has `onContainerStartFn` and `onContainerExitFn` optional callbacks
- index.ts wires callbacks at module level after `const queue = new GroupQueue()`
- 382/382 tests pass (371 existing + 11 new session-awareness tests)
- GroupQueue now uses `containers: Map<string, ContainerSlot>` per group — multi-slot
- The `activeCount` tracks global container count against `MAX_CONCURRENT_CONTAINERS`
- `waitingGroups` is a FIFO queue for groups that couldn't get a slot
- `sendMessage()` finds any idle non-task container and pipes to it
- `closeStdin()` can target a specific container via containerId or first idle
- `registerProcess()` uses pendingRegistrations bridge for containerId flow
- Session IDs stored per group folder in SQLite (`sessions` table)
- Task containers (`type: 'task'`) reject `sendMessage()` — this stays
- `setProcessMessagesFn` callback now includes `containerId` parameter
- 382/382 tests pass (was 371, +11 session-awareness)
- Test suite covers: CONC-01, CONC-04, CONC-05, COMPAT-01 + all existing concepts
- processGroupMessages now receives containerId from GroupQueue, threads to all GroupQueue calls
- runAgent passes sessionId=undefined (CONC-02) and containerId to registerProcess
- SchedulerDependencies.onProcess includes containerId parameter
- QueuedTask.fn signature is (containerId: string) => Promise<void>
- Container reads /workspace/ipc/active_sessions.json via readSessionAwareness() on startup
- readSessionAwareness filters out own containerId, returns '' on missing/corrupt/empty
- ContainerInput now includes containerId (host-side and container-side)
- runAgent() and runTask() both pass containerId in ContainerInput

### Blockers

- (none)

### TODOs

- (none)

## Session Continuity

### Last Session

- 2026-03-28T14:40:00Z

### Stopped At

- Completed 04-02-PLAN.md (Container send_audio MCP tool and tests) — Phase 04 complete

### Handover Notes

- Phase 01 complete: All 3 plans done (01-01, 01-02, 01-03)
- Phase 02 complete: All 2 plans done (02-01, 02-02)
- Phase 03 complete: All 2 plans done (03-01, 03-02) — OAuth auto-refresh
- **Phase 04 COMPLETE (2026-03-28):** WhatsApp voice note sending
  - Plan 01: Host-side infrastructure — Channel interface, WhatsApp ptt:true, IPC handler, media staging
  - Plan 02: Container-side — send_audio MCP tool, 6 new tests (sendAudio + IPC auth)
  - End-to-end pipeline: container agent → MCP tool → IPC media + JSON → host handler → Baileys ptt
  - 358 tests passing, clean build
- **Google Chat context loss bug FIXED** — Holly now remembers conversation history
  - Root cause: every Google Chat message spawned a fresh container with zero history
  - Fix: store inbound/outbound messages in DB, prepend last 20 as <conversation-history> XML
  - trigger-writer passes senderName/senderEmail/messageText in task JSON
  - ipc.ts stores inbound, calls storeChatMetadata for FK constraint, fetches history
  - task-scheduler.ts stores Holly's outbound responses after sendMessage
  - db.ts: new getRecentMessages() — includes bot messages (unlike getMessagesSince)
  - 12 new tests (416 total), deployed and verified working
- Google Chat threaded replies also shipped (separate earlier commit)
- OAuth auto-refresh live — token refreshes automatically when near expiry
- Passwordless deploy configured via sudoers (craig → nanoclaw)
- **Google Chat thread isolation FIXED (2026-03-12)** — 5 PRs merged (#3–#7):
  - PR #3: Warm container reuse bug — outbound messages tagged with wrong thread_id
  - PR #4: Reply routing — threadId threaded through Channel.sendMessage so replies go to correct thread (not just last-seen thread from file map). Also prevents one-shot task re-execution.
  - PR #5: MAX_WARM_PER_GROUP capped to 1 — shared IPC input directory caused race condition where multiple warm containers picked up each other's messages
  - PR #6: Task queue replaces single-entry containerCurrentTask Map — FIFO queue ensures streaming callback reads the correct task when multiple tasks are piped sequentially
  - PR #7: Thread isolation directive — warm containers retain Claude session memory; new-thread-message framing tells Claude to ignore prior session context from other threads
  - Root causes: (1) sendMessage had no threadId param, (2) shared IPC dir race, (3) containerCurrentTask overwrite race, (4) Claude session memory bleed across threads
  - 428 tests passing
  - Known limitation: MAX_WARM_PER_GROUP=1 means sequential processing. Per-container IPC directories needed to restore parallelism (backlog item).
- **[SILENT] message suppression (2026-03-12, PR #8):**
  - Holly's `[SILENT]`-prefixed messages (internal actions like Airtable writes) were leaking to Google Chat — no filtering existed anywhere in NanoClaw
  - Added `[SILENT]` detection to `formatOutbound()` in `router.ts`
  - Unified all three outbound paths to use `formatOutbound()`: user-message streaming, scheduler, and IPC send_message (which previously had NO filtering)
  - 432 tests passing
- **PM Agent MCP tools deployed (2026-03-12):** `create_goal` and `create_risk` tools were built in gos-pm-agent but the compiled `dist/` in VPS group folders was stale. Rebuilt and deployed to both google-chat and whatsapp group folders. Holly verified working — created R026 and G018 via Google Chat.
