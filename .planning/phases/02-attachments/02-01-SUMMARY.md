---
phase: 02-attachments
plan: "01"
subsystem: api
tags: [websocket, http, attachments, file-server, base64]

requires:
  - phase: 01-websocket-channel
    provides: WebSocketChannel base implementation with connect/disconnect/sendMessage/handleInboundMessage

provides:
  - WEBSOCKET_FILES_PORT constant exported from config.ts (env var, default 3002)
  - saveInboundAttachment(): saves base64 files from WS messages to inbox/attachments/
  - startFileServer(): HTTP static server serving groups/better-work/files/ with path traversal protection
  - extractOutboundAttachments(): detects files/ refs in agent text and builds attachments[] array
  - Bidirectional attachment support in WebSocketChannel

affects:
  - 02-02 (if exists) — any additional attachment phases
  - Panel web integration — can now send files (base64) and receive file URLs

tech-stack:
  added: [node:http, node:fs, node:path (native Node modules, no new npm packages)]
  patterns:
    - HTTP static server on separate port from WSS (filesPort vs port)
    - vi.hoisted() pattern for mock objects referenced in vi.mock() factories
    - Path traversal protection via path.resolve() + startsWith check

key-files:
  created: []
  modified:
    - src/config.ts
    - src/channels/websocket.ts
    - src/channels/websocket.test.ts

key-decisions:
  - "vi.hoisted() required for mock objects referenced inside vi.mock() factories (hoisting order issue)"
  - "HTTP file server starts in connect() before WSS — independent lifecycle"
  - "Attachment save failures are caught per-file and logged as warn (message still delivered)"
  - "extractOutboundAttachments checks fs.existsSync — only real files become attachments"

patterns-established:
  - "vi.hoisted() for top-level mock objects in vitest test files"
  - "startsWith(path.resolve(dir) + path.sep) for path traversal protection"

requirements-completed: [ATT-01, ATT-02, ATT-03, CONF-03]

duration: 5min
completed: 2026-03-01
---

# Phase 02 Plan 01: Attachments Summary

**Bidirectional attachment support for WebSocketChannel: inbound base64 file saving, HTTP static server on port 3002, outbound files/ reference detection with path traversal protection**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-01T19:48:28Z
- **Completed:** 2026-03-01T19:53:19Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- WEBSOCKET_FILES_PORT configurable via env var, exported from config.ts with default 3002
- Inbound attachments: base64 data saved to groups/better-work/inbox/attachments/, path appended to message content
- HTTP file server: serves groups/better-work/files/ with path traversal protection (403 on escape), CORS headers, EADDRINUSE handled as warn
- Outbound attachments: agent text scanned for files/ and /workspace/group/files/ refs, existing files included as attachments[{name, url}]
- 35 tests pass (25 original Phase 1 + 10 new ATT-01/ATT-02/ATT-03)

## Task Commits

Each task was committed atomically:

1. **Task 1: Añadir WEBSOCKET_FILES_PORT a config** - `ab94d75` (feat)
2. **Task 2: Implementar adjuntos entrantes + HTTP estático + adjuntos salientes** - `b72b5db` (feat)
3. **Task 3: Tests para ATT-01, ATT-02, ATT-03** - `0f65c39` (test)

## Files Created/Modified

- `src/config.ts` - Added WEBSOCKET_FILES_PORT to readEnvFile keys and exported constant
- `src/channels/websocket.ts` - Added saveInboundAttachment, startFileServer, getMimeType, extractOutboundAttachments; modified connect, handleInboundMessage, sendMessage, flushBuffer, disconnect
- `src/channels/websocket.test.ts` - Fixed config mock, added vi.hoisted() for fs/http mocks, added 10 new tests

## Decisions Made

- Used `vi.hoisted()` for `mockFs` and `mockHttpServer` because `vi.mock()` factories are hoisted to top of file — variables defined after hoisting are not yet initialized when the factory runs.
- Config mock updated from `() => ({})` to include `GROUPS_DIR` and `WEBSOCKET_FILES_PORT` — required by new WebSocketChannel constructor.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed config.js mock missing GROUPS_DIR and WEBSOCKET_FILES_PORT**
- **Found during:** Task 3 (test execution)
- **Issue:** `vi.mock('../config.js', () => ({}))` returned empty object; new WebSocketChannel constructor references both constants causing "No export defined" error in all 25 existing tests
- **Fix:** Updated mock to `() => ({ GROUPS_DIR: '/fake/groups', WEBSOCKET_FILES_PORT: 3002 })`
- **Files modified:** src/channels/websocket.test.ts
- **Verification:** All 35 tests pass
- **Committed in:** 0f65c39 (Task 3 commit)

**2. [Rule 1 - Bug] Fixed vi.mock() hoisting issue with mockHttpServer**
- **Found during:** Task 3 (test execution)
- **Issue:** `Cannot access 'mockHttpServer' before initialization` — variable declared after vi.mock() call but factory runs first due to hoisting
- **Fix:** Used `vi.hoisted()` to declare both `mockFs` and `mockHttpServer` before hoisting occurs
- **Files modified:** src/channels/websocket.test.ts
- **Verification:** All 35 tests pass
- **Committed in:** 0f65c39 (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 - Bug, both in Task 3)
**Impact on plan:** Both fixes required for test infrastructure correctness. No scope creep. Code changes (Tasks 1+2) executed exactly as planned.

## Issues Encountered

None beyond the test mock issues documented above.

## Next Phase Readiness

- ATT-01, ATT-02, ATT-03, CONF-03 requirements complete
- WebSocketChannel ready for panel web integration
- HTTP file server serves files on port 3002, panel can fetch via GET /files/{name}

## Self-Check: PASSED

All files found. All commits verified: ab94d75, b72b5db, 0f65c39.

---
*Phase: 02-attachments*
*Completed: 2026-03-01*
