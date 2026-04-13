# Claude Agent SDK Deep Dive

Findings from reverse-engineering `@anthropic-ai/claude-agent-sdk` v0.2.29–0.2.76 to understand how `query()` works, why agent teams subagents were being killed, and how to fix it. Supplemented with official SDK reference docs.

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

Full `Options` type from sdk.d.ts (v0.2.76):

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `abortController` | `AbortController` | `new AbortController()` | Controller for cancelling operations |
| `additionalDirectories` | `string[]` | `[]` | Additional directories Claude can access |
| `agent` | `string` | `undefined` | Agent name for the main thread (like `--agent` CLI flag). Must be defined in `agents` option or settings. |
| `agents` | `Record<string, AgentDefinition>` | `undefined` | Programmatically define subagents (not agent teams — no orchestration) |
| `agentProgressSummaries` | `boolean` | `false` | Enable periodic AI-generated progress summaries for running subagents (~30s). Emitted on `task_progress` events via `summary` field. |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | Required when using `permissionMode: 'bypassPermissions'` |
| `allowedTools` | `string[]` | All tools | List of allowed tool names |
| `betas` | `SdkBeta[]` | `[]` | Beta features (e.g., `['context-1m-2025-08-07']` for 1M context) |
| `canUseTool` | `CanUseTool` | `undefined` | Custom permission function for tool usage |
| `continue` | `boolean` | `false` | Continue the most recent conversation |
| `cwd` | `string` | `process.cwd()` | Current working directory |
| `disallowedTools` | `string[]` | `[]` | List of disallowed tool names |
| `effort` | `'low' \| 'medium' \| 'high' \| 'max'` | `'high'` | Controls reasoning effort. Works with adaptive thinking to guide depth. `'max'` is Opus 4.6 only. |
| `enableFileCheckpointing` | `boolean` | `false` | Enable file change tracking for rewinding |
| `env` | `Dict<string>` | `process.env` | Environment variables. Set `CLAUDE_AGENT_SDK_CLIENT_APP` for User-Agent identification. |
| `executable` | `'bun' \| 'deno' \| 'node'` | Auto-detected | JavaScript runtime |
| `executableArgs` | `string[]` | `[]` | Additional arguments to pass to the runtime executable |
| `extraArgs` | `Record<string, string \| null>` | `undefined` | Additional CLI args (keys without `--`, `null` for boolean flags) |
| `fallbackModel` | `string` | `undefined` | Model to use if primary fails |
| `forkSession` | `boolean` | `false` | When resuming, fork to a new session ID instead of continuing original |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `{}` | Hook callbacks for events (22 event types) |
| `includePartialMessages` | `boolean` | `false` | Include `SDKPartialAssistantMessage` (stream_event) during streaming — token-by-token deltas |
| `maxBudgetUsd` | `number` | `undefined` | Maximum budget in USD for the query |
| `maxThinkingTokens` | `number` | `undefined` | *Deprecated: use `thinking` instead.* On Opus 4.6, treated as on/off. |
| `maxTurns` | `number` | `undefined` | Maximum conversation turns |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP server configurations |
| `model` | `string` | Default from CLI | Claude model to use |
| `onElicitation` | `OnElicitation` | `undefined` | Callback for MCP elicitation requests (auth, forms) not handled by hooks |
| `outputFormat` | `OutputFormat` | `undefined` | Structured output format (JSON schema) |
| `pathToClaudeCodeExecutable` | `string` | Uses built-in | Path to Claude Code executable |
| `permissionMode` | `PermissionMode` | `'default'` | Permission mode |
| `permissionPromptToolName` | `string` | `undefined` | MCP tool name to route permission prompts through |
| `persistSession` | `boolean` | `true` | When `false`, disables session persistence to disk. Sessions cannot be resumed later. Useful for ephemeral workflows. |
| `plugins` | `SdkPluginConfig[]` | `[]` | Load custom plugins from local paths |
| `promptSuggestions` | `boolean` | `false` | Emit `prompt_suggestion` after each turn with predicted next user prompt |
| `resume` | `string` | `undefined` | Session ID to resume |
| `resumeSessionAt` | `string` | `undefined` | Resume session at a specific message UUID |
| `sandbox` | `SandboxSettings` | `undefined` | Sandbox behavior configuration |
| `sessionId` | `string` | auto-generated UUID | Use a specific session ID. Cannot combine with `continue`/`resume` unless `forkSession` is set. |
| `settings` | `string \| object` | `undefined` | Additional settings (path to file or inline). Loaded as highest-priority "flag settings" layer. |
| `settingSources` | `SettingSource[]` | `[]` (none) | Which filesystem settings to load. Must include `'project'` to load CLAUDE.md |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined` | System prompt. Use preset to get Claude Code's prompt, with optional `append` |
| `thinking` | `ThinkingConfig` | `{ type: 'adaptive' }` for supported models | Controls thinking behavior: `{type:'adaptive'}` (Opus 4.6+), `{type:'enabled', budgetTokens:N}`, or `{type:'disabled'}` |
| `toolConfig` | `ToolConfig` | `undefined` | Per-tool configuration (e.g., `{askUserQuestion: {previewFormat:'html'}}`) |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | `undefined` | Tool configuration |

### PermissionMode

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
// 'dontAsk' — Don't prompt for permissions, deny if not pre-approved
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
  description: string;        // When to use this agent
  prompt: string;             // Agent's system prompt
  tools?: string[];           // Allowed tools (inherits all if omitted)
  disallowedTools?: string[]; // Explicitly disallowed tools
  model?: string;             // Model alias ('sonnet', 'opus', 'haiku') or full ID. Omit to inherit.
  mcpServers?: AgentMcpServerSpec[];  // MCP servers for this agent
  skills?: string[];          // Skill names to preload
  maxTurns?: number;          // Max agentic turns before stopping
  criticalSystemReminder_EXPERIMENTAL?: string;  // Critical reminder in system prompt
}
```

### McpServerConfig

```typescript
type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sdk'; name: string; instance: McpServer }         // in-process
  | { type: 'claude_ai_proxy'; name: string; url: string }     // claude.ai proxy
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
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;        // File path that triggered the request
    decisionReason?: string;     // Why this permission request was triggered
    toolUseID: string;           // Unique ID for this tool call
    agentID?: string;            // Sub-agent ID if running in sub-agent context
  }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

## SDKMessage Types

`query()` can yield 21 message types (v0.2.76). The `SDKMessage` discriminated union from `sdk.d.ts`:

| Type | Subtype | Purpose |
|------|---------|---------|
| `assistant` | — | Claude's response (text + tool_use + thinking content blocks) |
| `user` | — | User message echo |
| `user` (replay) | — | Replayed user messages on session resume |
| `result` | `success` | Turn complete — result text, cost, usage, duration, model breakdown |
| `result` | `error_during_execution` | Error during execution |
| `result` | `error_max_turns` | Hit max turns limit |
| `result` | `error_max_budget_usd` | Hit budget limit |
| `result` | `error_max_structured_output_retries` | Structured output retries exhausted |
| `stream_event` | — | Token-by-token deltas wrapping `BetaRawMessageStreamEvent` (requires `includePartialMessages: true`) |
| `tool_progress` | — | Long-running tool heartbeat (tool_name, elapsed_time_seconds) |
| `tool_use_summary` | — | AI summary of preceding tool uses |
| `system` | `init` | Session initialized: version, model, tools, MCP servers, skills, plugins |
| `system` | `status` | Status change (e.g. `'compacting'`) |
| `system` | `task_started` | Subagent spawned (task_id, description, task_type, prompt) |
| `system` | `task_progress` | Subagent progress (usage, last_tool_name, summary) |
| `system` | `task_notification` | Subagent completed/failed/stopped (summary, output_file, usage) |
| `system` | `compact_boundary` | Context compaction occurred |
| `system` | `local_command_output` | Slash command output (e.g. /voice, /cost) |
| `system` | `hook_started` | Hook execution started |
| `system` | `hook_progress` | Hook progress output |
| `system` | `hook_response` | Hook completed |
| `system` | `files_persisted` | File checkpoints saved |
| `system` | `elicitation_complete` | MCP elicitation resolved |
| `auth_status` | — | Authentication state changes |
| `rate_limit_event` | — | Rate limit info (status, utilization, resets, overage) |
| `prompt_suggestion` | — | Predicted next user prompt (requires `promptSuggestions: true`) |

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
// Three V2 entry points (all unstable/alpha):
unstable_v2_createSession(options: SDKSessionOptions): SDKSession
unstable_v2_resumeSession(sessionId: string, options: SDKSessionOptions): SDKSession
unstable_v2_prompt(message: string, options: SDKSessionOptions): Promise<SDKResultMessage>  // one-shot

// SDKSession interface:
interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;  // async using support
}

// Usage:
await using session = unstable_v2_createSession({ model: "claude-sonnet-4-6" });
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
- Supports `Symbol.asyncDispose` for automatic cleanup

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

22 hook event types (v0.2.76):

```typescript
type HookEvent =
  | 'PreToolUse'         // Before tool execution (can modify/block)
  | 'PostToolUse'        // After successful tool execution
  | 'PostToolUseFailure' // After failed tool execution
  | 'PreCompact'         // Before conversation compaction
  | 'PostCompact'        // After conversation compaction
  | 'PermissionRequest'  // Permission being requested
  | 'UserPromptSubmit'   // User prompt submitted
  | 'SessionStart'       // Session started (startup/resume/clear/compact)
  | 'SessionEnd'         // Session ended
  | 'Stop'               // Agent stopping
  | 'SubagentStart'      // Subagent spawned
  | 'SubagentStop'       // Subagent stopped
  | 'TeammateIdle'       // Teammate agent idle
  | 'TaskCompleted'      // Task finished
  | 'Notification'       // Agent wants to notify user
  | 'Setup'              // First-time setup
  | 'Elicitation'        // MCP elicitation request
  | 'ElicitationResult'  // MCP elicitation resolved
  | 'ConfigChange'       // Settings file changed
  | 'WorktreeCreate'     // Git worktree created
  | 'WorktreeRemove'     // Git worktree removed
  | 'InstructionsLoaded'; // CLAUDE.md files loaded
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

The `Query` object extends `AsyncGenerator<SDKMessage, void>` with control methods:

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  // ── Execution control ──────────────────────────────────────
  interrupt(): Promise<void>;                       // Stop current execution
  close(): void;                                    // Kill query and all resources
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>; // Inject more user messages
  stopTask(taskId: string): Promise<void>;          // Stop a running subagent

  // ── Live configuration ─────────────────────────────────────
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(max: number | null): Promise<void>; // Deprecated: use thinking option

  // ── MCP server management ──────────────────────────────────
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  mcpServerStatus(): Promise<McpServerStatus[]>;

  // ── Introspection ──────────────────────────────────────────
  initializationResult(): Promise<SDKControlInitializeResponse>;
  supportedCommands(): Promise<SlashCommand[]>;     // Available skills/slash commands
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;           // Available subagents
  accountInfo(): Promise<AccountInfo>;

  // ── File management ────────────────────────────────────────
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
}
```

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

## Session Management APIs

Standalone functions for reading/managing session history (v0.2.76). These read from the JSONL transcript files on disk (`~/.claude/projects/`):

```typescript
// List all sessions — supports pagination
listSessions(options?: {
  dir?: string;       // Project directory (omit for all projects)
  limit?: number;
  offset?: number;
}): Promise<SDKSessionInfo[]>

// Get metadata for one session
getSessionInfo(sessionId: string, options?: {
  dir?: string;
}): Promise<SDKSessionInfo | undefined>

// Read full conversation — chain-resolved user/assistant messages
getSessionMessages(sessionId: string, options?: {
  dir?: string;
  limit?: number;     // Pagination
  offset?: number;
}): Promise<SessionMessage[]>

// Mutate sessions
renameSession(sessionId: string, title: string, options?: { dir?: string }): Promise<void>
tagSession(sessionId: string, tag: string | null, options?: { dir?: string }): Promise<void>
forkSession(sessionId: string, options?: {
  dir?: string;
  upToMessageId?: string;  // Branch at this message (inclusive)
  title?: string;
}): Promise<{ sessionId: string }>
```

### SDKSessionInfo

```typescript
type SDKSessionInfo = {
  sessionId: string;        // UUID
  summary: string;          // Display title
  lastModified: number;     // ms since epoch
  fileSize?: number;        // JSONL file size (bytes)
  customTitle?: string;     // User-set title via /rename
  firstPrompt?: string;     // First meaningful user prompt
  gitBranch?: string;       // Git branch at end of session
  cwd?: string;             // Working directory
  tag?: string;             // User-set tag
  createdAt?: number;       // ms since epoch
}
```

### SessionMessage

```typescript
type SessionMessage = {
  type: 'user' | 'assistant';
  uuid: string;
  session_id: string;
  message: unknown;           // Full API message (content blocks, tool_use, etc.)
  parent_tool_use_id: null;
}
```

These APIs are useful for **audit logging**: call `getSessionMessages()` from the host after each container run to read the full conversation without parsing JSONL yourself. The SDK handles chain resolution, compaction boundaries, and subagent merging internally.

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

- `sdk.d.ts` — All type definitions (~3500 lines, v0.2.76)
- `sdk-tools.d.ts` — Tool input schemas
- `browser-sdk.d.ts` — Browser API (WebSocket transport)
- `sdk.mjs` — SDK runtime (minified)
- `cli.js` — CLI executable (minified, runs as subprocess)
- `embed.js` — Exports CLI path for embedding
