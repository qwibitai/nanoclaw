---
name: add-codex-engine
description: Add OpenAI Codex as an alternative AI engine. Introduces an Engine abstraction layer so NanoClaw can switch between Claude (container-based) and Codex (local SDK) via the AI_ENGINE env var. Existing Claude functionality is preserved. Triggers on "codex engine", "openai codex", "add codex", "switch to codex", "use codex".
---

# Add Codex Engine

This skill adds OpenAI Codex SDK as an alternative AI engine to NanoClaw. It introduces an Engine interface abstraction, wraps the existing Claude container system as one engine implementation, and adds Codex as a second.

**What this changes:**
- Adds `src/engine.ts` — Engine interface + factory function
- Adds `src/engines/claude.ts` — wraps existing container-runner (no behavior change)
- Adds `src/engines/codex.ts` — new Codex SDK implementation
- Modifies `src/index.ts` — uses Engine interface instead of direct container-runner calls
- Modifies `src/config.ts` — adds `AI_ENGINE` and `CODEX_WORKING_DIR` config
- Modifies `src/task-scheduler.ts` — uses Engine interface
- Modifies `src/group-queue.ts` — supports null process (Codex has no ChildProcess)
- Modifies `src/health-monitor.ts` — engine-level health check replaces Docker-specific check

**What stays the same:**
- All existing Claude/container functionality (`AI_ENGINE=claude`, the default)
- All channel code (WhatsApp, Telegram, Slack, etc.)
- Database, router, IPC, group management
- Container image, Dockerfile, agent-runner

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-codex-engine` is in `applied_skills`, skip to Phase 3 (Setup).

### Ask the user

1. **Do they have an OpenAI API key?** If yes, collect it. If no, they'll need one from [platform.openai.com](https://platform.openai.com).

2. **Working directory**: Codex SDK needs a directory to operate in (ideally a Git repo). Ask where their code project lives.

## Phase 2: Apply Code Changes

### Install dependency

```bash
npm install @openai/codex-sdk
```

### Create `src/engine.ts` — Engine interface and factory

Create the Engine abstraction interface. This is the core of the multi-engine architecture.

```typescript
import { ChildProcess } from 'child_process';
import { RegisteredGroup } from './types.js';

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface Engine {
  name: string;
  init(): Promise<void>;
  runAgent(
    group: RegisteredGroup,
    input: AgentInput,
    onProcess: (proc: ChildProcess | null, containerName: string) => void,
    onOutput?: (output: AgentOutput) => Promise<void>,
  ): Promise<AgentOutput>;
  writeTasksSnapshot?(groupFolder: string, isMain: boolean, tasks: any[]): void;
  writeGroupsSnapshot?(groupFolder: string, isMain: boolean, groups: any[], registeredJids: Set<string>): void;
  healthCheck(): Promise<'ok' | 'error'>;
  shutdown(): Promise<void>;
}
```

Add a factory function at the bottom:

```typescript
import { AI_ENGINE } from './config.js';
import { logger } from './logger.js';

export async function createEngine(): Promise<Engine> {
  if (AI_ENGINE === 'codex') {
    const { CodexEngine } = await import('./engines/codex.js');
    logger.info('Loading Codex engine');
    return new CodexEngine();
  }
  const { ClaudeEngine } = await import('./engines/claude.js');
  logger.info('Loading Claude engine');
  return new ClaudeEngine();
}
```

Dynamic imports ensure only the selected engine's dependencies are loaded.

### Create `src/engines/claude.ts` — Claude engine adapter

Wraps existing `container-runner.ts` functions behind the Engine interface. **Does not change any existing behavior.**

Implementation requirements:
- Import `runContainerAgent`, `writeTasksSnapshot`, `writeGroupsSnapshot` from `../container-runner.js`
- Import `ensureContainerRuntimeRunning`, `cleanupOrphans` from `../container-runtime.js`
- `init()` calls `ensureContainerRuntimeRunning()` and `cleanupOrphans()`
- `runAgent()` delegates to `runContainerAgent()`, mapping `AgentInput` → `ContainerInput` and `ContainerOutput` → `AgentOutput`
- `writeTasksSnapshot` and `writeGroupsSnapshot` delegate directly to the existing functions
- `healthCheck()` runs `docker info` (or `container system status` for Apple Container) via `execSync`, returns `'ok'` or `'error'`
- `shutdown()` is a no-op

The `AgentInput`/`AgentOutput` types map 1:1 to existing `ContainerInput`/`ContainerOutput`:
- `AgentInput.sessionId` → `ContainerInput.sessionId`
- `AgentOutput.newSessionId` → `ContainerOutput.newSessionId`

### Create `src/engines/codex.ts` — Codex engine implementation

Implementation requirements:
- Import `Codex` from `@openai/codex-sdk`
- Maintain a `Map<string, Thread>` for per-group threads (keyed by groupFolder)
- `init()` creates the `Codex` instance with `OPENAI_API_KEY` from env (use `readEnvFile` pattern)
- `runAgent()`:
  1. Call `onProcess(null, codex-${group.folder}-${Date.now()})` — Codex has no ChildProcess
  2. Get or create thread: if `input.sessionId` exists → `codex.resumeThread(sessionId)`, else → `codex.startThread({ workingDirectory, skipGitRepoCheck: true })`
  3. Prepend `[SCHEDULED TASK]\n\n` if `input.isScheduledTask`
  4. Call `thread.runStreamed(prompt)`, iterate events
  5. On `item.completed` events: extract text, call `onOutput` if provided
  6. On `turn.completed`: capture `finalResponse`
  7. Return `{ status: 'success', result: finalResult, newSessionId: thread.id }`
  8. On error: return `{ status: 'error', result: null, error: message }`
- `writeTasksSnapshot` / `writeGroupsSnapshot` — do NOT implement (Codex doesn't need filesystem snapshots)
- `healthCheck()` checks that `OPENAI_API_KEY` is configured, returns `'ok'` or `'error'`
- `shutdown()` clears the threads map

Working directory: `path.join(CODEX_WORKING_DIR, groupFolder)`. Each group gets its own subdirectory.

### Modify `src/config.ts` — Add engine config

Read the intent file `modify/src/config.ts.intent.md` for detailed invariants.

Add to the `readEnvFile` keys array:
```
'AI_ENGINE',
'CODEX_WORKING_DIR',
```

Add exports:
```typescript
export const AI_ENGINE = process.env.AI_ENGINE || envConfig.AI_ENGINE || 'claude';
export const CODEX_WORKING_DIR = process.env.CODEX_WORKING_DIR || envConfig.CODEX_WORKING_DIR || '';
```

**Note**: `OPENAI_API_KEY` is NOT read here. It is read by the Codex engine directly via `readEnvFile()` to keep secrets off the config module (same pattern as `ANTHROPIC_API_KEY` in container-runner.ts).

### Modify `src/index.ts` — Use Engine interface

Read the intent file `modify/src/index.ts.intent.md` for detailed invariants.

Key changes:
1. **Imports**: Add `createEngine`, `Engine`, `AgentInput`, `AgentOutput` from `./engine.js`. Keep existing container-runner import for `AvailableGroup` type only.
2. **Module state**: Add `let engine: Engine`
3. **`main()` function**: Replace `ensureContainerSystemRunning()` with `engine = await createEngine(); await engine.init();`
4. **Agent invocation**: Where `runContainerAgent()` is called, replace with `engine.runAgent()`. Map the existing input object to `AgentInput` format.
5. **Snapshot writes**: Wrap `writeTasksSnapshot()` / `writeGroupsSnapshot()` calls with `if (engine.writeTasksSnapshot)` / `if (engine.writeGroupsSnapshot)` guards.
6. **Shutdown**: Add `await engine.shutdown()` to the shutdown handler.
7. **Health monitor deps**: Pass `engineHealthCheck: () => engine.healthCheck()` instead of the Docker-specific check.

### Modify `src/group-queue.ts` — Support null process

Read the intent file `modify/src/group-queue.ts.intent.md` for detailed invariants.

Key change: `registerProcess` currently requires a `ChildProcess`. Change to accept `ChildProcess | null`:

```typescript
registerProcess(
  groupJid: string,
  proc: ChildProcess | null,  // was: ChildProcess
  containerName: string,
  groupFolder?: string,
): void
```

Guard all `proc` property accesses (`.pid`, `.on('exit', ...)`, etc.) with null checks. When `proc` is null (Codex engine), the queue still tracks the group as active but skips process-level event listeners.

Also add a `sendMessageFn` callback for engines that don't use file-based IPC:

```typescript
private sendMessageFn: ((groupFolder: string, text: string) => boolean) | null = null;

setSendMessageFn(fn: (groupFolder: string, text: string) => boolean): void {
  this.sendMessageFn = fn;
}
```

In `sendMessage()`, try `sendMessageFn` first, fall back to existing file-based IPC.

### Modify `src/task-scheduler.ts` — Use Engine interface

Read the intent file `modify/src/task-scheduler.ts.intent.md` for detailed invariants.

Key changes:
1. Add `engine: Engine` to `SchedulerDependencies` interface
2. Replace `runContainerAgent()` call with `deps.engine.runAgent()`
3. Wrap `writeTasksSnapshot()` call with `if (deps.engine.writeTasksSnapshot)` guard

### Modify `src/health-monitor.ts` — Engine health check

Read the intent file `modify/src/health-monitor.ts.intent.md` for detailed invariants.

Key changes:
1. Add `engineHealthCheck: () => Promise<'ok' | 'error'>` to `HealthMonitorDeps`
2. Replace `checkDockerHealth()` (which runs `docker info`) with `deps.engineHealthCheck()`
3. Update alert messages: replace "Docker" with "AI engine" in health check alerts

### Update `.env.example`

Add:
```bash
# AI Engine: 'claude' (default) or 'codex'
# AI_ENGINE=claude

# OpenAI API Key (required when AI_ENGINE=codex)
# OPENAI_API_KEY=sk-...

# Codex working directory root (required when AI_ENGINE=codex)
# Each group gets a subdirectory under this path
# CODEX_WORKING_DIR=/path/to/your/project
```

### Validate code changes

```bash
npm run build
npm test
```

All tests must pass and build must be clean. The Claude engine path should be functionally identical to before.

## Phase 3: Setup

### Configure environment

Add to `.env`:

```bash
AI_ENGINE=codex
OPENAI_API_KEY=sk-your-key
CODEX_WORKING_DIR=/path/to/your/code/project
```

Sync to container environment (still needed for IPC and other subsystems):

```bash
mkdir -p data/env && cp .env data/env/env
```

### Prepare working directories

Codex SDK requires working directories to exist. For each registered group, ensure the directory exists:

```bash
mkdir -p $CODEX_WORKING_DIR/main
mkdir -p $CODEX_WORKING_DIR/<other-group-folders>
```

For best results, each group directory should be a Git repository (or git worktree). Codex works best when it can use git for change tracking.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test Claude engine (regression)

```bash
AI_ENGINE=claude npm run dev
```

Send a message. Verify the existing Claude/container flow works identically to before.

### Test Codex engine

```bash
AI_ENGINE=codex npm run dev
```

Send a message. Verify Codex receives the prompt and responds.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -E 'engine|codex|Codex'
```

Should see "Loading Codex engine" and "Codex engine initialized".

## Troubleshooting

### Codex SDK not found

```bash
npm ls @openai/codex-sdk
```

If not installed: `npm install @openai/codex-sdk`

### "OPENAI_API_KEY not configured"

Check `.env` has `OPENAI_API_KEY=sk-...` and sync: `mkdir -p data/env && cp .env data/env/env`

### Codex requires Git repository

If you see "Not inside a trusted directory", ensure `CODEX_WORKING_DIR/<group>` is a git repo:

```bash
cd $CODEX_WORKING_DIR/main && git init
```

Or the engine uses `skipGitRepoCheck: true` by default, which should avoid this error.

### Claude engine still works after changes?

The Engine abstraction is designed to be backward-compatible. With `AI_ENGINE=claude` (the default), the code path is identical to before — `ClaudeEngine` simply delegates to the existing `runContainerAgent()`.

## Switching Between Engines

Change `AI_ENGINE` in `.env` and restart:

```bash
# Switch to Codex
sed -i '' 's/AI_ENGINE=claude/AI_ENGINE=codex/' .env

# Switch back to Claude
sed -i '' 's/AI_ENGINE=codex/AI_ENGINE=claude/' .env

# Restart
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Architecture Reference

### Codex SDK API

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({ workingDirectory: "/path/to/project" });
const turn = await thread.run("Fix this bug");
console.log(turn.finalResponse);

// Streaming
const { events } = await thread.runStreamed("Analyze this code");
for await (const event of events) {
  // event.type: 'item.completed' | 'turn.completed'
}

// Resume session
const thread2 = codex.resumeThread(savedThreadId);
```

- SDK docs: https://developers.openai.com/codex/sdk/
- npm: https://www.npmjs.com/package/@openai/codex-sdk
- Requires Node.js 18+

### Engine Interface

```
AI_ENGINE=claude:  index.ts → engine.runAgent() → ClaudeEngine → container-runner → Docker → Claude SDK
AI_ENGINE=codex:   index.ts → engine.runAgent() → CodexEngine  → @openai/codex-sdk → Codex
```

Both engines expose identical `AgentInput` / `AgentOutput` interfaces. Callers don't know which engine is running.

## Known Limitations

- **Codex session persistence**: Thread IDs are stored in the same SQLite sessions table as Claude session IDs. Switching engines invalidates existing sessions (the old engine's session IDs won't work with the new engine).
- **No IPC for Codex**: Codex runs in-process, not in a container. The file-based IPC mechanism (`data/ipc/`) is not used for Codex message delivery. The `sendMessageFn` callback on `GroupQueue` handles this instead.
- **Codex sandbox limitations**: Codex SDK's sandbox may restrict network access. Tasks requiring external API calls may need configuration adjustments.
- **No hot-switching**: Changing `AI_ENGINE` requires a restart. Active agent sessions will be lost.
