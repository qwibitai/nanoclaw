# Intent: src/index.ts modifications

## What changed
Refactored from direct `container-runner` calls to Engine interface, enabling pluggable AI backends.

## Key sections

### Imports (top of file)
- Added: `createEngine`, `Engine`, `AgentInput`, `AgentOutput` from `./engine.js`
- Kept: `AvailableGroup` from `./container-runner.js` (type-only import, still needed for `getAvailableGroups`)
- Removed from direct use: `runContainerAgent`, `writeTasksSnapshot`, `writeGroupsSnapshot` — now accessed through engine

### Module-level state
- Added: `let engine: Engine`
- All other state (`registeredGroups`, `sessions`, `channels`, etc.) unchanged

### main()
- Replaced: `ensureContainerSystemRunning()` → `engine = await createEngine(); await engine.init();`
- The engine's `init()` handles runtime-specific setup (Docker check for Claude, SDK init for Codex)
- Channel initialization (WhatsApp, Telegram, Slack) is completely unchanged
- Scheduler deps: add `engine` to the deps object
- Health monitor deps: replace Docker health check with `engineHealthCheck: () => engine.healthCheck()`

### Agent invocation (runAgent / processGroupMessages)
- Where `runContainerAgent(group, {...}, onProcess, onOutput)` is called, replace with `engine.runAgent(group, {...}, onProcess, onOutput)`
- Input mapping: existing fields map 1:1 to `AgentInput` (prompt, sessionId, groupFolder, chatJid, isMain, isScheduledTask, assistantName)
- Output mapping: `ContainerOutput` fields map 1:1 to `AgentOutput` (status, result, newSessionId, error)

### Snapshot writes
- Wrap `writeTasksSnapshot(...)` with `if (engine.writeTasksSnapshot) { engine.writeTasksSnapshot(...); }`
- Wrap `writeGroupsSnapshot(...)` with `if (engine.writeGroupsSnapshot) { engine.writeGroupsSnapshot(...); }`
- Claude engine implements these (delegates to existing functions). Codex engine does not.

### Shutdown handler
- Added: `await engine.shutdown()` alongside channel disconnects

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- Channel handling (WhatsApp, Telegram, Slack) is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- IPC watcher and task scheduler setup is unchanged (except passing engine in deps)
- The `onProcess` callback signature changes to accept `ChildProcess | null` (Codex passes null)

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The outgoing queue flush and reconnection logic
- The `getAvailableGroups()` export
