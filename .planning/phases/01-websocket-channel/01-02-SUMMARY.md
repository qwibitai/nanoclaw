---
phase: 01-websocket-channel
plan: "02"
subsystem: channels
tags: [websocket, ws, channel, protocol, buffer, heartbeat, typescript]

requires:
  - phase: 01-01
    provides: "ws ^8.19.0 as direct dependency, WEBSOCKET_PORT from src/config.ts"

provides:
  - "WebSocketChannel class implementing Channel interface in src/channels/websocket.ts"
  - "WebSocketChannelOpts interface exported from src/channels/websocket.ts"
  - "Inbound protocol: chat -> NewMessage, system -> [SYSTEM] prefix NewMessage, PARSE_ERROR on invalid JSON"
  - "Disconnect buffer: max 50 messages, drop-oldest overflow, flush with buffered_start/buffered_end on reconnect"
  - "Heartbeat: native ws.ping() every 30s, pong timeout 10s, zombie termination"
  - "25 behavior tests covering all CHAN-* and PROTO-* requirements"

affects:
  - "src/index.ts — will instantiate WebSocketChannel and pass it to channel array"
  - "01-websocket-channel (plans 03+)"

tech-stack:
  added: []
  patterns:
    - "WS_JID constant 'ws:better-work' for channel identity"
    - "ownsJid: jid.startsWith('ws:') pattern"
    - "onChatMetadata called in connect() (not on first message) to satisfy SQLite FK constraint"
    - "Disconnect buffer: array of {content, timestamp} with max 50 cap and shift-oldest overflow"
    - "Heartbeat: isAlive flag toggled by pong event, native ws.ping(), pong timeout to terminate zombies"

key-files:
  created:
    - "src/channels/websocket.ts"
    - "src/channels/websocket.test.ts"
  modified: []

key-decisions:
  - "onChatMetadata called immediately in connect() (not deferred to first message) to prevent SQLite FK constraint failures"
  - "Buffer flush sends buffered_start/buffered_end system events around buffered chat messages, preserving original timestamps"
  - "ws.terminate() used for zombie connections (not ws.close()) — matches RESEARCH.md anti-pattern guidance"
  - "sendMessage silently buffers when no client instead of throwing — avoids error propagation to agent"

patterns-established:
  - "WebSocket mock pattern: WSS as vi.fn().mockImplementation(function WSS()) with connectionHandler capture"
  - "Fake client: EventEmitter-based with readyState=1, send/terminate/ping as vi.fn(), _emit helper"

requirements-completed: [CHAN-01, CHAN-02, CHAN-03, CHAN-04, CHAN-05, CHAN-06, PROTO-01, PROTO-02, PROTO-03, PROTO-04, PROTO-05]

duration: 10min
completed: "2026-03-01"
---

# Phase 01 Plan 02: WebSocketChannel Implementation Summary

**WebSocket channel with disconnect buffering, heartbeat zombie detection, and 25 passing behavior tests covering all CHAN-* and PROTO-* requirements**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-03-01T19:40:00Z
- **Completed:** 2026-03-01T19:50:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- WebSocketChannel class implementing Channel interface: connect, sendMessage, isConnected, ownsJid, setTyping, disconnect
- Inbound message protocol: `{type:"chat"}` -> NewMessage, `{type:"system"}` -> NewMessage with `[SYSTEM] action: payload` prefix, invalid JSON -> PARSE_ERROR response
- Disconnect buffer: stores up to 50 messages with timestamps, flushes on reconnect with `buffered_start`/`buffered_end` envelope
- Heartbeat: native `ws.ping()` every 30s, 10s pong timeout, `ws.terminate()` for zombie connections
- 25 behavior tests covering channel properties, connect/state, inbound protocol, sendMessage/buffer, setTyping, onChatMetadata, disconnect, and client close

## Task Commits

Each task was committed atomically:

1. **Task 1: Implementar WebSocketChannel** - `934670f` (feat)
2. **Task 2: Tests de WebSocketChannel** - `1b5d50c` (test)

**Plan metadata:** (pending docs commit)

## Files Created/Modified

- `src/channels/websocket.ts` - WebSocketChannel class implementing Channel interface with full protocol, buffer, and heartbeat
- `src/channels/websocket.test.ts` - 25 behavior tests covering all CHAN-* and PROTO-* requirements

## Decisions Made

- `onChatMetadata` is called immediately in `connect()` rather than deferred to the first message. This prevents SQLite FK constraint failures since the chat row must exist before any message is inserted.
- `ws.terminate()` used for zombie termination (not `ws.close()`), per RESEARCH.md anti-patterns guidance. `close()` does a handshake that will block indefinitely on an unresponsive connection.
- `sendMessage` silently buffers when no client is connected instead of throwing an error. This avoids error propagation to the agent and is the intended behavior for a buffering channel.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed WebSocketServer mock constructor pattern**
- **Found during:** Task 2 (test execution)
- **Issue:** `vi.fn().mockImplementation(() => ({...}))` with arrow function cannot be used as a constructor via `new WebSocketServer(...)`, causing "is not a constructor" TypeError in all tests
- **Fix:** Changed mock to use a regular named function: `vi.fn().mockImplementation(function WSS() { return {...} })` which supports `new` invocation
- **Files modified:** `src/channels/websocket.test.ts`
- **Verification:** All 25 tests pass after fix
- **Committed in:** 1b5d50c (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug in test mock)
**Impact on plan:** Fix required for tests to run at all. No scope creep.

## Issues Encountered

- Vitest mock of `WebSocketServer` required using a regular function (not arrow function) as the mock implementation because the production code uses `new WebSocketServer()`. Arrow functions cannot be used as constructors in JavaScript.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `WebSocketChannel` is complete and ready to be instantiated in `src/index.ts`
- Both `WebSocketChannel` and `WebSocketChannelOpts` are exported from `src/channels/websocket.ts`
- Next step: wire the channel into the orchestrator (src/index.ts) with WEBSOCKET_ENABLED/WEBSOCKET_PORT from config

## Self-Check: PASSED

- src/channels/websocket.ts: FOUND
- src/channels/websocket.test.ts: FOUND
- Commit 934670f (Task 1): FOUND
- Commit 1b5d50c (Task 2): FOUND
- Build: PASSES (no TypeScript errors)
- Tests: 25/25 passing

---
*Phase: 01-websocket-channel*
*Completed: 2026-03-01*
