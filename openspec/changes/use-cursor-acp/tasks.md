## 1. Dependency

- [x] 1.1 Verify `add-cursor-agent` is applied (or apply it first) — `cursor-runner.ts` and `shared.ts` must exist

## 2. SDK Setup

- [x] 2.1 Add `@agentclientprotocol/sdk` to `container/agent-runner/package.json` dependencies
- [x] 2.2 Run `npm install` inside `container/agent-runner/` and verify TypeScript types resolve (`ClientSideConnection`, `ndJsonStream`, `SessionUpdate`)

## 3. Rewrite cursor-runner.ts

- [x] 3.1 Replace `spawnAgent()` with `spawnAcp()`: spawn `agent acp`, create `acp.ndJsonStream()` from subprocess stdio, return `ClientSideConnection`
- [x] 3.2 Implement `client` object with `sessionUpdate()` (forward text chunks to `writeOutput()`) and `requestPermission()` (return `allow-once`)
- [x] 3.3 Replace `main()` session setup: call `connection.initialize()`, then `connection.newSession()` (no sessionId) or `connection.loadSession()` (existing sessionId)
- [x] 3.4 Pass MCP server config in `newSession({ mcpServers })` params using existing `mcpServerPath` and `mcpEnv` values
- [x] 3.5 Replace per-message `spawnAgent()` calls in the while loop with `connection.prompt({ sessionId, prompt: [{ type: 'text', text }] })`
- [x] 3.6 Add `finally { agentProc.kill() }` block
- [x] 3.7 Delete `writeConfigs()`, `cleanupConfigs()`, `previousMcpContent`, `GLOBAL_MCP_PATH`, signal handlers, `spawnAgent()`, `handleEvent()`, `lineBuffer` NDJSON parsing

## 4. Validation

- [x] 4.1 Run `npm run build` (or `npm run build:agent-runner`) — zero TypeScript errors
- [ ] 4.2 Send a test message via Zoom with `AGENT_BACKEND=cursor` — verify response arrives and `sessionId` is persisted in SQLite
- [ ] 4.3 Send a follow-up message — verify same `agent acp` session is reused (check logs: single `Spawning agent acp` line per conversation)
- [ ] 4.4 Run two groups concurrently — verify no `~/.cursor/mcp.json` conflicts in logs
- [ ] 4.5 Confirm `~/.cursor/mcp.json` is untouched after a conversation completes
