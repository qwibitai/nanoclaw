# Design: Replace Cursor per-request spawn with ACP

**Date:** 2026-03-10
**Status:** Approved
**Risk:** MEDIUM (contained within cursor-runner.ts)

## Goal

Replace the current Cursor backend implementation — which spawns a new `agent --print` process for every message — with ACP (Agent Client Protocol) using a persistent `agent acp` daemon per conversation. This improves response latency, eliminates a concurrency bug in MCP configuration, and replaces ad-hoc NDJSON parsing with a typed SDK.

## Motivation

- **Performance**: No per-message agent process startup overhead
- **Stability**: Eliminates the `~/.cursor/mcp.json` global file race condition when multiple groups run concurrently
- **Architectural cleanliness**: JSON-RPC 2.0 via `@agentclientprotocol/sdk` replaces hand-rolled NDJSON stream parsing

---

## Architecture

### Before

```
process-runner.ts: runContainerAgent()
  └─ spawn(node, [cursor-runner/dist/index.js])
       └─ cursor-runner.ts: main() while loop
            ├─ writeConfigs() → writes ~/.cursor/mcp.json (global, race condition)
            ├─ per message: spawn('agent', ['--print', '--output-format', 'stream-json', ...])
            │    └─ manual NDJSON line parsing → handleEvent() → writeOutput()
            └─ waitForIpcMessage() → repeat
```

### After

```
process-runner.ts: runContainerAgent()           ← zero changes
  └─ spawn(node, [cursor-runner/dist/index.js])
       └─ cursor-runner.ts: main()
            ├─ spawn('agent', ['acp'])            ← one persistent daemon
            ├─ ClientSideConnection(stream)       ← @agentclientprotocol/sdk
            ├─ connection.initialize()
            ├─ connection.newSession({ workingDirectory, mcpServers })
            │    └─ MCP registered here, no files written
            ├─ per message: connection.prompt({ sessionId, prompt })
            │    └─ client.sessionUpdate() → writeOutput()  (streaming)
            └─ waitForIpcMessage() → repeat (same session, same ACP process)
```

---

## Key Design Decisions

### ACP daemon lifecycle: per cursor-runner invocation

`agent acp` is spawned once when `cursor-runner.ts` starts, and killed when the conversation ends (close sentinel received). This matches the existing process lifecycle and requires the smallest change.

No persistent per-group daemon manager is introduced.

### MCP registration: via newSession() params

MCP servers are passed directly in `connection.newSession({ mcpServers: [...] })`. This eliminates all file I/O for MCP configuration:

- `writeConfigs()` — deleted entirely
- `cleanupConfigs()` — deleted entirely
- `previousMcpContent` state variable — deleted
- Signal handlers for config cleanup — deleted

Per-workspace `.cursor/mcp.json` is not written. The nanoclaw IPC MCP server is registered in-process per session.

### Session management

- First message (no existing sessionId): `connection.newSession()` → returns `sessionId`
- Subsequent conversation (existing sessionId): `connection.loadSession({ sessionId })`
- `sessionId` is returned to `process-runner.ts` via `writeOutput({ newSessionId })` — same IPC field as before, zero changes upstream

### Permission requests

Cursor's `session/request_permission` events are auto-approved via the client object:

```typescript
requestPermission(_req) {
  return { response: 'allow-once' };
}
```

This replaces the `--force --trust --approve-mcps` CLI flags.

---

## Implementation

### New cursor-runner.ts structure (~180 lines)

```typescript
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'stream';

async function main(): Promise<void> {
  const containerInput: ContainerInput = JSON.parse(await readStdin());
  const groupDir = process.env.NANOCLAW_GROUP_DIR ?? containerInput.groupFolder;
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  const spawnEnv = { ...process.env, ...(containerInput.secrets ?? {}) };

  // Drain pending IPC messages into initial prompt
  const pending = drainIpcInput(IPC_INPUT_DIR);
  let currentPromptText = containerInput.prompt;
  if (pending.length > 0) {
    currentPromptText += '\n' + pending.join('\n');
  }

  // Spawn persistent ACP daemon
  const agentProc = spawn('agent', ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv as NodeJS.ProcessEnv,
  });

  agentProc.stderr.on('data', (chunk: Buffer) => {
    log(`stderr: ${chunk.toString().trim()}`);
  });

  // Build ACP connection
  const stream = acp.ndJsonStream(
    Readable.toWeb(agentProc.stdout!),
    Writable.toWeb(agentProc.stdin!),
  );

  let sessionId = containerInput.sessionId;

  const client = {
    sessionUpdate(update: acp.SessionUpdate) {
      if (update.type === 'text' && update.text) {
        writeOutput({ status: 'success', result: update.text, newSessionId: sessionId });
      }
    },
    requestPermission(_req: unknown) {
      return { response: 'allow-once' as const };
    },
  };

  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  try {
    await connection.initialize({});

    // Create or restore session
    if (sessionId) {
      await connection.loadSession({ sessionId });
    } else {
      const mcpEnv = {
        NANOCLAW_IPC_DIR: process.env.NANOCLAW_IPC_DIR ?? '',
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      };
      const r = await connection.newSession({
        workingDirectory: groupDir,
        mcpServers: [{ command: 'node', args: [mcpServerPath], env: mcpEnv }],
      });
      sessionId = r.sessionId;
    }

    // First prompt
    const prompt = buildPrompt(containerInput, currentPromptText);
    await connection.prompt({ sessionId, prompt: [{ type: 'text', text: prompt }] });
    writeOutput({ status: 'success', result: null, newSessionId: sessionId });

    // IPC follow-up message loop
    while (true) {
      const next = await waitForIpcMessage(IPC_INPUT_DIR, IPC_INPUT_CLOSE_SENTINEL);
      if (next === null) break;
      await connection.prompt({ sessionId, prompt: [{ type: 'text', text: next }] });
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${msg}`);
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: msg });
    process.exit(1);
  } finally {
    agentProc.kill();
  }
}
```

---

## Files Changed

| File | Change |
|------|--------|
| `container/agent-runner/src/cursor-runner.ts` | Rewrite (~300 lines → ~180 lines) |
| `container/agent-runner/package.json` | Add `@agentclientprotocol/sdk` dependency |
| `src/process-runner.ts` | **Zero changes** |
| `src/index.ts` | **Zero changes** |
| `src/task-scheduler.ts` | **Zero changes** |
| SQLite schema | **Zero changes** |

---

## Deleted Code

| Symbol | Reason |
|--------|--------|
| `writeConfigs()` | MCP now registered via `newSession()` params |
| `cleanupConfigs()` | No files written, nothing to clean up |
| `previousMcpContent` | Global MCP file no longer touched |
| `GLOBAL_MCP_PATH` constant | Unused |
| `spawnAgent()` | Replaced by `connection.prompt()` |
| `handleEvent()` | Replaced by `client.sessionUpdate()` |
| `lineBuffer` / NDJSON parsing | SDK handles framing |
| Signal handlers for cleanup | No longer needed |

---

## Risks & Unknowns

| Risk | Mitigation |
|------|-----------|
| `@agentclientprotocol/sdk` is v0.12.0, relatively new | Cursor joined ACP Registry in March 2026; protocol is stable |
| `newSession()` MCP param schema may differ from docs | Verify against SDK types before implementation |
| `loadSession()` behavior when session is expired | Fall back to `newSession()` on error |
| ACP streaming `sessionUpdate` format may differ | Verify `update.type === 'text'` field name against SDK types |
| `agent acp` auth requires prior `agent login` | Same requirement as current `--print` mode, no change |

---

## Implementation Order

1. Add `@agentclientprotocol/sdk` to `container/agent-runner/package.json`, verify types compile
2. Rewrite `cursor-runner.ts`: scaffold new `main()` with ACP connection, stub out `sessionUpdate`
3. Implement `newSession()` / `loadSession()` with correct params
4. Wire `connection.prompt()` + IPC message loop
5. Verify streaming output reaches `process-runner.ts` via OUTPUT_START/END markers
6. Test with a real Zoom message end-to-end
7. Delete old dead code (`writeConfigs`, `cleanupConfigs`, `spawnAgent`, `handleEvent`)
