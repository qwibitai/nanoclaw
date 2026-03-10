## MODIFIED Requirements

### Requirement: Cursor CLI Runner Implementation
`container/agent-runner/src/cursor-runner.ts` SHALL implement the Cursor backend using the ACP (Agent Client Protocol) persistent daemon via `@agentclientprotocol/sdk`.

The runner SHALL:
- Spawn `agent acp` once per conversation (not per message)
- Establish a `ClientSideConnection` over the subprocess stdio using `acp.ndJsonStream()`
- Call `connection.initialize()` after connection is established
- Create a new session via `connection.newSession({ workingDirectory: groupDir, mcpServers: [...] })` when no `sessionId` is provided, or restore via `connection.loadSession({ sessionId })` when one exists
- Register the nanoclaw IPC MCP server in `newSession()` params (not via file writes)
- Send each message via `connection.prompt({ sessionId, prompt: [{ type: 'text', text }] })`
- Receive streaming output via `client.sessionUpdate()` callback and forward to `writeOutput()`
- Auto-approve permission requests by returning `{ response: 'allow-once' }` from `requestPermission()`
- Kill the `agent acp` process in a `finally` block when the conversation ends

The runner SHALL NOT:
- Write to `~/.cursor/mcp.json` or any global Cursor configuration file
- Spawn `agent --print` or use `--output-format stream-json`
- Parse NDJSON output line-by-line

#### Scenario: New conversation
- **WHEN** `cursor-runner.ts` starts with no `sessionId` in `ContainerInput`
- **THEN** `agent acp` is spawned, `initialize()` is called, `newSession()` creates a session with `workingDirectory` set to `groupDir` and `mcpServers` containing the nanoclaw IPC server
- **AND** the resulting `sessionId` is included in the first `writeOutput()` call as `newSessionId`

#### Scenario: Resumed conversation
- **WHEN** `cursor-runner.ts` starts with an existing `sessionId` in `ContainerInput`
- **THEN** `loadSession({ sessionId })` is called instead of `newSession()`
- **AND** the same `sessionId` is used for subsequent `prompt()` calls

#### Scenario: Streaming output
- **WHEN** the agent generates a text response
- **THEN** each text chunk is received via `client.sessionUpdate()` and forwarded to `writeOutput()` with `status: 'success'`
- **AND** the final `writeOutput()` call includes `newSessionId` and `result: null` to signal completion

#### Scenario: Follow-up IPC message
- **WHEN** a follow-up message arrives via the IPC input directory after the first prompt completes
- **THEN** `connection.prompt()` is called on the same `agent acp` process with the same `sessionId`
- **AND** no new `agent acp` process is spawned

#### Scenario: Conversation close
- **WHEN** the `_close` sentinel is written to the IPC input directory
- **THEN** the IPC message loop exits and `agentProc.kill()` is called in the `finally` block
- **AND** no Cursor configuration files are left modified on disk

#### Scenario: Agent error
- **WHEN** `connection.prompt()` throws or the ACP process exits unexpectedly
- **THEN** `writeOutput({ status: 'error', error: message })` is called
- **AND** the process exits with code 1

## REMOVED Requirements

### Requirement: Cursor MCP Config File Management
**Reason**: MCP servers are now registered via `connection.newSession({ mcpServers })` params. No global file writes are needed.
**Migration**: Delete `writeConfigs()`, `cleanupConfigs()`, `previousMcpContent`, and all associated signal handlers from `cursor-runner.ts`.

### Requirement: Cursor CLI NDJSON Stream Parsing
**Reason**: `@agentclientprotocol/sdk` handles JSON-RPC framing and event dispatch. The `handleEvent()` function and `lineBuffer` accumulation are no longer needed.
**Migration**: Delete `spawnAgent()`, `handleEvent()`, and all NDJSON parsing logic. Replace with `client.sessionUpdate()` callback.
