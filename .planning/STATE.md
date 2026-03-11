# State — NanoClaw Concurrent Sessions

## Project Reference

- **Core value:** Messages never blocked by running containers
- **Current focus:** Phase 1 — Multi-Container GroupQueue (Plans 01 + 02 + 03 complete)
- **Airtable record:** `recFADjzpnBY8NHh4`

## Current Position

- **Phase:** 1 — Multi-Container GroupQueue
- **Plan:** 3 of 3 (all complete)
- **Status:** Phase Complete
- **Progress:** █████░░░░░ 50%

## Performance Metrics

| Metric | Value |
|--------|-------|
| Phases total | 2 |
| Phases complete | 0 |
| Plans total | 6 |
| Plans complete | 3 |
| Tasks total | 5 |
| Tasks complete | 5 |

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01 | 01 | 308s | 2 | 1 |
| 01 | 02 | 268s | 2 | 3 |
| 01 | 03 | 128s | 1 | 1 |

## Accumulated Context

### Key Decisions
- ContainerSlot map replaces active boolean for multi-container support
- pendingRegistrations map bridges containerId from runForGroup to registerProcess
- containerId parameter made optional on public API for backward compatibility
- Idle container reuse checked before global cap (no new slot cost)
- Extract containerId from processMessagesFn mock calls for precise slot targeting in tests
- Use completion callback arrays for concurrent container control in tests
- Fresh session per container (sessionId=undefined) for CONC-02 — idle-reuse containers already have session internally
- Task session logic preserved — context_mode 'group' resumes group session, 'isolated' fresh
- QueuedTask.fn receives containerId from GroupQueue.runTask for explicit threading

### Technical Notes
- GroupQueue now uses `containers: Map<string, ContainerSlot>` per group — multi-slot
- The `activeCount` tracks global container count against `MAX_CONCURRENT_CONTAINERS`
- `waitingGroups` is a FIFO queue for groups that couldn't get a slot
- `sendMessage()` finds any idle non-task container and pipes to it
- `closeStdin()` can target a specific container via containerId or first idle
- `registerProcess()` uses pendingRegistrations bridge for containerId flow
- Session IDs stored per group folder in SQLite (`sessions` table)
- Task containers (`type: 'task'`) reject `sendMessage()` — this stays
- `setProcessMessagesFn` callback now includes `containerId` parameter
- 371/371 tests pass (was 366/367, now all green after test rewrite)
- Test suite covers: CONC-01, CONC-04, CONC-05, COMPAT-01 + all existing concepts
- processGroupMessages now receives containerId from GroupQueue, threads to all GroupQueue calls
- runAgent passes sessionId=undefined (CONC-02) and containerId to registerProcess
- SchedulerDependencies.onProcess includes containerId parameter
- QueuedTask.fn signature is (containerId: string) => Promise<void>

### Blockers
- (none)

### TODOs
- (none)

## Session Continuity

### Last Session
- 2026-03-11T20:51:27Z

### Handover Notes
- Phase 01 complete: All 3 plans done (01-01, 01-02, 01-03)
- Plan 01-02 complete: Callers updated for multi-container containerId flow
- Fresh sessions per container (CONC-02), per-container idle timeouts (CONC-03)
- Next: Phase 02 — End-to-End Validation
