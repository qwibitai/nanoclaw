# Claude Agent SDK Deep Dive

Findings from reverse-engineering `@anthropic-ai/claude-agent-sdk` v0.2.29–0.2.34 to understand how `query()` works, why agent teams subagents were being killed, and how to fix it. Supplemented with official SDK reference docs.

## Architecture

```
Agent Runner (our code)
  └── query() → SDK (sdk.mjs)
        └── spawns CLI subprocess (cli.js)
              └── Claude API calls, tool execution
              └── Task tool → spawns subagent subprocesses
```

The SDK spawns `cli.js` as a child process with `--output-format stream-json --input-format stream-json --print --verbose` flags. Communication happens via JSON-lines on stdin/stdout.

`query()` returns a `Query` object extending `AsyncGenerator<SDKMessage, void>`. Internally:

- SDK spawns CLI as a child process, communicates via stdin/stdout JSON lines
- SDK's `readMessages()` reads from CLI stdout, enqueues into internal stream
- `readSdkMessages()` async generator yields from that stream
- `[Symbol.asyncIterator]` returns `readSdkMessages()`
- Iterator returns `done: true` only when CLI closes stdout

Both V1 (`query()`) and V2 (`createSession`/`send`/`stream`) use the exact same three-layer architecture:

```
SDK (sdk.mjs)           CLI Process (cli.js)
--------------          --------------------
XX Transport  ------>   stdin reader (bd1)
  (spawn cli.js)           |
$X Query      <------   stdout writer
  (JSON-lines)             |
                        EZ() recursive generator
                           |
                        Anthropic Messages API
```

## The Core Agent Loop (EZ)

Inside the CLI, the agentic loop is a **recursive async generator called `EZ()`**, not an iterative while loop:

```
EZ({ messages, systemPrompt, canUseTool, maxTurns, turnCount=1, ... })
```

Each invocation = one API call to Claude (one "turn").

### Flow per turn:

1. **Prepare messages** — trim context, run compaction if needed
2. **Call the Anthropic API** (via `mW1` streaming function)
3. **Extract tool_use blocks** from the response
4. **Branch:**
   - If **no tool_use blocks** → stop (run stop hooks, return)
   - If **tool_use blocks present** → execute tools, increment turnCount, recurse

All complex logic — the agent loop, tool execution, background tasks, teammate orchestration — runs inside the CLI subprocess. `query()` is a thin transport wrapper.

## query() Options

Full `Options` type from the official docs:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `abortController` | `AbortController` | `new AbortController()` | Controller for cancelling operations |
| `additionalDirectories` | `string[]` | `[]` | Additional directories Claude can access |
| `agents` | `Record<string, AgentDefinition>` | `undefined` | Programmatically define subagents (not agent teams — no orchestration) |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | Required when using `permissionMode: 'bypassPermissions'` |
| `allowedTools` | `string[]` | All tools | List of allowed tool names |
| `betas` | `SdkBeta[]` | `[]` | Beta features (e.g., `['context-1m-2025-08-07']` for 1M context) |
| `canUseTool` | `CanUseTool` | `undefined` | Custom permission function for tool usage |
| `continue` | `boolean` | `false` | Continue the most recent conversation |
| `cwd` | `string` | `process.cwd()` | Current working directory |
| `disallowedTools` | `string[]` | `[]` | List of disallowed tool names |
| `enableFileCheckpointing` | `boolean` | `false` | Enable file change tracking for rewinding |
| `env` | `Dict<string>` | `process.env` | Environment variables |
| `executable` | `'bun' \| 'deno' \| 'node'` | Auto-detected | JavaScript runtime |
| `fallbackModel` | `string` | `undefined` | Model to use if primary fails |
| `forkSession` | `boolean` | `false` | When resuming, fork to a new session ID instead of continuing original |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `{}` | Hook callbacks for events |
| `includePartialMessages` | `boolean` | `false` | Include partial message events (streaming) |
| `maxBudgetUsd` | `number` | `undefined` | Maximum budget in USD for the query |
| `maxThinkingTokens` | `number` | `undefined` | Maximum tokens for thinking process |
| `maxTurns` | `number` | `undefined` | Maximum conversation turns |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP server configurations |
| `model` | `string` | Default from CLI | Claude model to use |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | `undefined` | Structured output format |
| `pathToClaudeCodeExecutable` | `string` | Uses built-in | Path to Claude Code executable |
| `permissionMode` | `PermissionMode` | `'default'` | Permission mode |
| `plugins` | `SdkPluginConfig[]` | `[]` | Load custom plugins from local paths |
| `resume` | `string` | `undefined` | Session ID to resume |
| `resumeSessionAt` | `string` | `undefined` | Resume session at a specific message UUID |
| `sandbox` | `SandboxSettings` | `undefined` | Sandbox behavior configuration |
| `settingSources` | `SettingSource[]` | `[]` (none) | Which filesystem settings to load. Must include `'project'` to load CLAUDE.md |
| `stderr` | `(data: string) => void` | `undefined` | Callback for stderr output |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined` | System prompt. Use preset to get Claude Code's prompt, with optional `append` |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | `undefined` | Tool configuration |

### PermissionMode

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
```

### SettingSource

```typescript
type SettingSource = 'user' | 'project' | 'local';
// 'user'    → ~/.claude/settings.json
// 'project' → .claude/settings.json (version controlled)
// 'local'   → .claude/settings.local.json (gitignored)
```

When omitted, SDK loads NO filesystem settings (isolation by default). Precedence: local > project > user. Programmatic options always override filesystem settings.

### AgentDefinition

Programmatic subagents (NOT agent teams — these are simpler, no inter-agent coordination):

```typescript
type AgentDefinition = {
  description: string;  // When to use this agent
  tools?: string[];     // Allowed tools (inherits all if omitted)
  prompt: string;       // Agent's system prompt
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

### McpServerConfig

```typescript
type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sdk'; name: string; instance: McpServer }  // in-process
```

### SdkBeta

```typescript
type SdkBeta = 'context-1m-2025-08-07';
// Enables 1M token context window for Opus 4.6, Sonnet 4.5, Sonnet 4
```

### CanUseTool

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

## SDKMessage Types

`query()` can yield 16 message types. The official docs show a simplified union of 7, but `sdk.d.ts` has the full set:

| Type | Subtype | Purpose |
|------|---------|---------|
| `system` | `init` | Session initialized, contains session_id, tools, model |
| `system` | `task_notification` | Background agent completed/failed/stopped |
| `system` | `compact_boundary` | Conversation was compacted |
| `system` | `status` | Status change (e.g. compacting) |
| `system` | `hook_started` | Hook execution started |
| `system` | `hook_progress` | Hook progress output |
| `system` | `hook_response` | Hook completed |
| `system` | `files_persisted` | Files saved |
| `assistant` | — | Claude's response (text + tool calls) |
| `user` | — | User message (internal) |
| `user` (replay) | — | Replayed user message on resume |
| `result` | `success` / `error_*` | Final result of a prompt processing round |
| `stream_event` | — | Partial streaming (when includePartialMessages) |
| `tool_progress` | — | Long-running tool progress |
| `auth_status` | — | Authentication state changes |
| `tool_use_summary` | — | Summary of preceding tool uses |

### SDKTaskNotificationMessage (sdk.d.ts:1507)

```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  uuid: UUID;
  session_id: string;
};
```

### SDKResultMessage (sdk.d.ts:1375)

Two variants with shared fields:

```typescript
// Shared fields on both variants:
// uuid, session_id, duration_ms, duration_api_ms, is_error, num_turns,
// total_cost_usd, usage: NonNullableUsage, modelUsage, permission_denials

// Success:
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  result: string;
  structured_output?: unknown;
  // ...shared fields
};

// Error:
type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  errors: string[];
  // ...shared fields
};
```

Useful fields on result: `total_cost_usd`, `duration_ms`, `num_turns`, `modelUsage` (per-model breakdown with `costUSD`, `inputTokens`, `outputTokens`, `contextWindow`).

### SDKAssistantMessage

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  uuid: UUID;
  session_id: string;
  message: APIAssistantMessage; // From Anthropic SDK
  parent_tool_use_id: string | null; // Non-null when from subagent
};
```

### SDKSystemMessage (init)

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: UUID;
  session_id: string;
  apiKeySource: ApiKeySource;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
};
```

## Turn Behavior: When the Agent Stops vs Continues

### When the Agent STOPS (no more API calls)

**1. No tool_use blocks in response (THE PRIMARY CASE)**

Claude responded with text only — it decided it has completed the task. The API's `stop_reason` will be `"end_turn"`. The SDK does NOT make this decision — it's entirely driven by Claude's model output.

**2. Max turns exceeded** — Results in `SDKResultError` with `subtype: "error_max_turns"`.

**3. Abort signal** — User interruption via `abortController`.

**4. Budget exceeded** — `totalCost >= maxBudgetUsd` → `"error_max_budget_usd"`.

**5. Stop hook prevents continuation** — Hook returns `{preventContinuation: true}`.

### When the Agent CONTINUES (makes another API call)

**1. Response contains tool_use blocks (THE PRIMARY CASE)** — Execute tools, increment turnCount, recurse into EZ.

**2. max_output_tokens recovery** — Up to 3 retries with a "break your work into smaller pieces" context message.

**3. Stop hook blocking errors** — Errors fed back as context messages, loop continues.

**4. Model fallback** — Retry with fallback model (one-time).

### Decision Table

| Condition | Action | Result Type |
|-----------|--------|-------------|
| Response has `tool_use` blocks | Execute tools, recurse into `EZ` | continues |
| Response has NO `tool_use` blocks | Run stop hooks, return | `success` |
| `turnCount > maxTurns` | Yield max_turns_reached | `error_max_turns` |
| `totalCost >= maxBudgetUsd` | Yield budget error | `error_max_budget_usd` |
| `abortController.signal.aborted` | Yield interrupted msg | depends on context |
| `stop_reason === "max_tokens"` (output) | Retry up to 3x with recovery prompt | continues |
| Stop hook `preventContinuation` | Return immediately | `success` |
| Stop hook blocking error | Feed error back, recurse | continues |
| Model fallback error | Retry with fallback model (one-time) | continues |

## Subagent Execution Modes

### Case 1: Synchronous Subagents (`run_in_background: false`) — BLOCKS

Parent agent calls Task tool → `VR()` runs `EZ()` for subagent → parent waits for full result → tool result returned to parent → parent continues.

The subagent runs the full recursive EZ loop. The parent's tool execution is suspended via `await`. There is a mid-execution "promotion" mechanism: a synchronous subagent can be promoted to background via `Promise.race()` against a `backgroundSignal` promise.

### Case 2: Background Tasks (`run_in_background: true`) — DOES NOT WAIT

- **Bash tool:** Command spawned, tool returns immediately with empty result + `backgroundTaskId`
- **Task/Agent tool:** Subagent launched in fire-and-forget wrapper (`g01()`), tool returns immediately with `status: "async_launched"` + `outputFile` path

Zero "wait for background tasks" logic before emitting the `type: "result"` message. When a background task completes, an `SDKTaskNotificationMessage` is emitted separately.

### Case 3: Agent Teams (TeammateTool / SendMessage) — RESULT FIRST, THEN POLLING

The team leader runs its normal EZ loop, which includes spawning teammates. When the leader's EZ loop finishes, `type: "result"` is emitted. Then the leader enters a post-result polling loop:

```javascript
while (true) {
    // Check if no active teammates AND no running tasks → break
    // Check for unread messages from teammates → re-inject as new prompt, restart EZ loop
    // If stdin closed with active teammates → inject shutdown prompt
    // Poll every 500ms
}
```

From the SDK consumer's perspective: you receive the initial `type: "result"`, but the AsyncGenerator may continue yielding more messages as the team leader processes teammate responses and re-enters the agent loop. The generator only truly finishes when all teammates have shut down.

## The isSingleUserTurn Problem

From sdk.mjs:

```javascript
QK = typeof X === "string"  // isSingleUserTurn = true when prompt is a string
```

When `isSingleUserTurn` is true and the first `result` message arrives:

```javascript
if (this.isSingleUserTurn) {
  this.transport.endInput();  // closes stdin to CLI
}
```

This triggers a chain reaction:

1. SDK closes CLI stdin
2. CLI detects stdin close
3. Polling loop sees `D = true` (stdin closed) with active teammates
4. Injects shutdown prompt → leader sends `shutdown_request` to all teammates
5. **Teammates get killed mid-research**

The shutdown prompt (found via `BGq` variable in minified cli.js):

```
You are running in non-interactive mode and cannot return a response
to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user
```

### The practical problem

With V1 `query()` + string prompt + agent teams:

1. Leader spawns teammates, they start researching
2. Leader's EZ loop ends ("I've dispatched the team, they're working on it")
3. `type: "result"` emitted
4. SDK sees `isSingleUserTurn = true` → closes stdin immediately
5. Polling loop detects stdin closed + active teammates → injects shutdown prompt
6. Leader sends `shutdown_request` to all teammates
7. **Teammates could be 10 seconds into a 5-minute research task and they get told to stop**

## The Fix: Streaming Input Mode

Instead of passing a string prompt (which sets `isSingleUserTurn = true`), pass an `AsyncIterable<SDKUserMessage>`:

```typescript
// Before (broken for agent teams):
query({ prompt: "do something" })

// After (keeps CLI alive):
query({ prompt: asyncIterableOfMessages })
```

When prompt is an `AsyncIterable`:
- `isSingleUserTurn = false`
- SDK does NOT close stdin after first result
- CLI stays alive, continues processing
- Background agents keep running
- `task_notification` messages flow through the iterator
- We control when to end the iterable

### Additional Benefit: Streaming New Messages

With the async iterable approach, we can push new incoming WhatsApp messages into the iterable while the agent is still working. Instead of queuing messages until the container exits and spawning a new container, we stream them directly into the running session.

### Intended Lifecycle with Agent Teams

With the async iterable fix (`isSingleUserTurn = false`), stdin stays open so the CLI never hits the teammate check or shutdown prompt injection:

```
1. system/init          → session initialized
2. assistant/user       → Claude reasoning, tool calls, tool results
3. ...                  → more assistant/user turns (spawning subagents, etc.)
4. result #1            → lead agent's first response (capture)
5. task_notification(s) → background agents complete/fail/stop
6. assistant/user       → lead agent continues (processing subagent results)
7. result #2            → lead agent's follow-up response (capture)
8. [iterator done]      → CLI closed stdout, all done
```

All results are meaningful — capture every one, not just the first.

## V1 vs V2 API

### V1: `query()` — One-shot async generator

```typescript
const q = query({ prompt: "...", options: {...} });
for await (const msg of q) { /* process events */ }
```

- When `prompt` is a string: `isSingleUserTurn = true` → stdin auto-closes after first result
- For multi-turn: must pass an `AsyncIterable<SDKUserMessage>` and manage coordination yourself

### V2: `createSession()` + `send()` / `stream()` — Persistent session

```typescript
await using session = unstable_v2_createSession({ model: "..." });
await session.send("first message");
for await (const msg of session.stream()) { /* events */ }
await session.send("follow-up");
for await (const msg of session.stream()) { /* events */ }
```

- `isSingleUserTurn = false` always → stdin stays open
- `send()` enqueues into an async queue (`QX`)
- `stream()` yields from the same message generator, stopping on `result` type
- Multi-turn is natural — just alternate `send()` / `stream()`
- V2 does NOT call V1 `query()` internally — both independently create Transport + Query

### Comparison Table

| Aspect | V1 | V2 |
|--------|----|----|
| `isSingleUserTurn` | `true` for string prompt | always `false` |
| Multi-turn | Requires managing `AsyncIterable` | Just call `send()`/`stream()` |
| stdin lifecycle | Auto-closes after first result | Stays open until `close()` |
| Agentic loop | Identical `EZ()` | Identical `EZ()` |
| Stop conditions | Same | Same |
| Session persistence | Must pass `resume` to new `query()` | Built-in via session object |
| API stability | Stable | Unstable preview (`unstable_v2_*` prefix) |

**Key finding: Zero difference in turn behavior.** Both use the same CLI process, the same `EZ()` recursive generator, and the same decision logic.

## Hook Events

```typescript
type HookEvent =
  | 'PreToolUse'         // Before tool execution
  | 'PostToolUse'        // After successful tool execution
  | 'PostToolUseFailure' // After failed tool execution
  | 'Notification'       // Notification messages
  | 'UserPromptSubmit'   // User prompt submitted
  | 'SessionStart'       // Session started (startup/resume/clear/compact)
  | 'SessionEnd'         // Session ended
  | 'Stop'               // Agent stopping
  | 'SubagentStart'      // Subagent spawned
  | 'SubagentStop'       // Subagent stopped
  | 'PreCompact'         // Before conversation compaction
  | 'PermissionRequest'; // Permission being requested
```

### Hook Configuration

```typescript
interface HookCallbackMatcher {
  matcher?: string;      // Optional tool name matcher
  hooks: HookCallback[];
}

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### Hook Return Values

```typescript
type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

type AsyncHookJSONOutput = { async: true; asyncTimeout?: number };

type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow' | 'deny' | 'ask'; updatedInput?: Record<string, unknown> }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
    | { hookEventName: 'SessionStart'; additionalContext?: string }
    | { hookEventName: 'PostToolUse'; additionalContext?: string };
};
```

### Subagent Hooks (from sdk.d.ts)

```typescript
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
};

type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
};

// BaseHookInput = { session_id, transcript_path, cwd, permission_mode? }
```

## Query Interface Methods

The `Query` object (sdk.d.ts:931). Official docs list these public methods:

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;                     // Stop current execution (streaming input mode only)
  rewindFiles(userMessageUuid: string): Promise<void>; // Restore files to state at message (needs enableFileCheckpointing)
  setPermissionMode(mode: PermissionMode): Promise<void>; // Change permissions (streaming input mode only)
  setModel(model?: string): Promise<void>;        // Change model (streaming input mode only)
  setMaxThinkingTokens(max: number | null): Promise<void>; // Change thinking tokens (streaming input mode only)
  supportedCommands(): Promise<SlashCommand[]>;   // Available slash commands
  supportedModels(): Promise<ModelInfo[]>;         // Available models
  mcpServerStatus(): Promise<McpServerStatus[]>;  // MCP server connection status
  accountInfo(): Promise<AccountInfo>;             // Authenticated user info
}
```

Found in sdk.d.ts but NOT in official docs (may be internal):
- `streamInput(stream)` — stream additional user messages
- `close()` — forcefully end the query
- `setMcpServers(servers)` — dynamically add/remove MCP servers

## Sandbox Configuration

```typescript
type SandboxSettings = {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: {
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    httpProxyPort?: number;
    socksProxyPort?: number;
  };
  ignoreViolations?: {
    file?: string[];
    network?: string[];
  };
};
```

When `allowUnsandboxedCommands` is true, the model can set `dangerouslyDisableSandbox: true` in Bash tool input, which falls back to the `canUseTool` permission handler.

## MCP Server Helpers

### tool()

Creates type-safe MCP tool definitions with Zod schemas:

```typescript
function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>
): SdkMcpToolDefinition<Schema>
```

### createSdkMcpServer()

Creates an in-process MCP server (we use stdio instead for subagent inheritance):

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance
```

## Internals Reference

### Key minified identifiers (sdk.mjs)

| Minified | Purpose |
|----------|---------|
| `s_` | V1 `query()` export |
| `e_` | `unstable_v2_createSession` |
| `Xx` | `unstable_v2_resumeSession` |
| `Qx` | `unstable_v2_prompt` |
| `U9` | V2 Session class (`send`/`stream`/`close`) |
| `XX` | ProcessTransport (spawns cli.js) |
| `$X` | Query class (JSON-line routing, async iterable) |
| `QX` | AsyncQueue (input stream buffer) |

### Key minified identifiers (cli.js)

| Minified | Purpose |
|----------|---------|
| `EZ` | Core recursive agentic loop (async generator) |
| `_t4` | Stop hook handler (runs when no tool_use blocks) |
| `PU1` | Streaming tool executor (parallel during API response) |
| `TP6` | Standard tool executor (after API response) |
| `GU1` | Individual tool executor |
| `lTq` | SDK session runner (calls EZ directly) |
| `bd1` | stdin reader (JSON-lines from transport) |
| `mW1` | Anthropic API streaming caller |

## Key Files

- `sdk.d.ts` — All type definitions (1777 lines)
- `sdk-tools.d.ts` — Tool input schemas
- `sdk.mjs` — SDK runtime (minified, 376KB)
- `cli.js` — CLI executable (minified, runs as subprocess)
