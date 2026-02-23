# Multi-Provider Agent System

Design document for supporting multiple LLM providers (Claude, OpenAI, Grok/xAI) as worker agents behind a single lead agent. The user sees one assistant. The multi-agent orchestration is invisible.

**Status:** Proposed
**Date:** 2026-02-22

---

## Problem Statement

NanoClaw currently runs a single Claude agent per group. This works well, but limits what the assistant can do behind the scenes:

1. **Specialized capabilities** — Different models excel at different tasks. GPT for creative writing, Grok for real-time web knowledge, Claude for code and analysis.
2. **Multi-perspective analysis** — A council of agents can deliberate on a problem, each contributing a different angle.
3. **Cost optimization** — Route lightweight sub-tasks to cheaper models, reserve expensive models for what matters.
4. **Redundancy** — If one provider is down, the lead agent can delegate to another.

The user doesn't care about any of this. To them, it's one assistant in a chat. The multi-agent nature is an implementation detail — like how a brain has specialized regions but presents a unified consciousness.

### Architecture Analogy

```
cambot-core    = nervous system  (memory, telemetry, security, event bus)
lead container = the brain       (decides, delegates, synthesizes, responds)
worker agents  = specialized     (research, creative writing, analysis — called on demand)
channels       = senses          (WhatsApp, Telegram, Discord — input/output)
```

### Design Philosophy

NanoClaw's security model (container isolation, stdin-only secrets, per-group IPC namespaces) is a direct advantage over OpenClaw's single-process plugin architecture. Multi-provider support must preserve this:

- **Each provider runs in its own container image** — no shared process, no plugin hot-loading
- **Secrets are scoped per-agent** — an OpenAI container never sees Anthropic keys
- **The container protocol is the abstraction boundary** — not a runtime SDK adapter

---

## Current State

### Anthropic-Coupled (Inside the Container)

These components are tightly coupled to the Anthropic/Claude ecosystem:

| Component | File | Coupling |
|-----------|------|----------|
| Agent runner | `container/agent-runner/src/index.ts` | Imports `query` from `@anthropic-ai/claude-agent-sdk`, uses Claude-specific options (`resume`, `resumeSessionAt`, `systemPrompt`, `allowedTools`, `permissionMode`, `hooks`) |
| Secret injection | `src/container-runner.ts:184-186` | `readSecrets()` reads `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` |
| Container image | `src/config.ts:37-38` | Single global `CONTAINER_IMAGE = 'cambot-agent-agent:latest'` |
| Session management | `container/agent-runner/src/index.ts:416-456` | `query()` call with Claude SDK session resume semantics |
| Secret stripping | `container/agent-runner/src/index.ts:190` | `SECRET_ENV_VARS` hardcodes `['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']` |
| SDK settings | `src/container-runner.ts:107-121` | Writes `.claude/settings.json` with Claude Code environment variables |

### Already Generic (Host-Side)

These components have zero provider awareness and work with any container that speaks the stdin/stdout JSON protocol:

| Component | File | Why It's Generic |
|-----------|------|-----------------|
| Group queue | `src/group-queue.ts` | Manages `ChildProcess` instances. Knows nothing about what runs inside. |
| IPC watcher | `src/ipc.ts` | Reads JSON files from per-group IPC directories. Provider-agnostic. |
| MCP server | `container/agent-runner/src/ipc-mcp-stdio.ts` | Pure file-based IPC. No SDK imports. Any agent runtime can spawn it. |
| Container runner protocol | `src/container-runner.ts:29-44` | `ContainerInput`/`ContainerOutput` are plain JSON — no provider types. |
| Volume mounts | `src/container-runner.ts:52-177` | Builds mounts from group config. Provider-irrelevant. |
| Database | `src/db.ts` | `registered_groups.container_config` is a JSON blob — already extensible. |
| Scheduler | `src/task-scheduler.ts` | Triggers container runs by group. Doesn't know what's inside. |
| Router | `src/router.ts` | Formats messages, strips tags, dispatches to channels. |
| Channels | `src/types.ts:81-98` | `Channel` interface is fully abstract. |

### The Seam

The container boundary (stdin JSON in, stdout JSON out) is the natural abstraction point. The host already treats containers as black boxes. The only host-side coupling is:

1. `readSecrets()` — which secrets to inject
2. `CONTAINER_IMAGE` — which image to spawn
3. `buildVolumeMounts()` — `.claude/settings.json` creation (Claude-specific)

---

## Proposed Design

### Lead/Worker Architecture

The user talks to one assistant. Always. Every group has a **lead agent** that:

- Receives all inbound messages
- Maintains conversation context and session history
- Decides when to delegate sub-tasks to workers
- Synthesizes worker results into a single response
- Is the only agent that talks to the user (unless it explicitly delegates via `send_message`)

The lead is designated in config — not hardcoded to any provider. Today it's Claude (best tool-use, session resume, agent teams). Tomorrow it could be any provider that supports the required capabilities. Swapping the lead is a config change, not a code change.

**Worker agents** are invisible to the user. They:

- Are spawned on-demand by the lead (via MCP tool or workflow)
- Get a specific prompt and return a result
- Run in their own isolated container (different provider, different secrets)
- Have no conversation history — they get what the lead gives them
- Don't talk to the user directly (their output goes back to the lead)

```
User ↔ Channel ↔ Lead Container (designated in config)
                       │
                       │ delegates when it decides to
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
           Worker    Worker   Worker
           (any)     (any)    (any)
              │        │        │
              └────────┼────────┘
                       │
                       ▼
                 Lead synthesizes
                 and responds
```

The user never configures which worker to use for what. The lead agent makes that call based on its instructions and the task at hand. The `agents.yaml` is a menu the brain can choose from.

### Three-Layer Model

1. **Provider images** (few, generic) — One container image per LLM SDK. Built once. Contains the SDK, agent-runner, and MCP server. Knows how to talk to a provider's API. No opinion about personality or use case.

2. **Worker definitions** (unlimited, configurable) — Lightweight config entries that reference a provider image and add model selection, personality, and secret requirements. Create as many as you want without building anything.

3. **Lead agent** (one per group, designated in config) — The existing NanoClaw agent. Gains a new MCP tool (`delegate_to_worker`) that lets it invoke worker definitions. Everything else about the lead stays the same. Currently Claude (best tool-use ecosystem), but the designation is a config field, not a hardcoded assumption.

```
Provider Images (build once):
  cambot-agent-claude:latest    ← Anthropic SDK
  cambot-agent-openai:latest    ← OpenAI SDK
  cambot-agent-grok:latest      ← OpenAI SDK + xAI base URL

Worker Definitions (unlimited):
  claude-deep        → claude image, claude-opus-4-6, "Think deeply..."
  claude-fast        → claude image, claude-haiku-4-5, "Be concise..."
  gpt-creative       → openai image, gpt-4o, "Vivid, expressive..."
  gpt-mini           → openai image, gpt-4o-mini
  grok-researcher    → grok image, grok-3, "Data-driven, cites sources..."
  grok-casual        → grok image, grok-3, "Casual and witty..."
  ...any combination

Lead Agent (per group, designated in config):
  Default: claude-default. Can be any agent definition.
  Knows about available workers. Decides when to delegate.
```

### Worker Definition Model

```typescript
interface WorkerDefinition {
  id: string;               // e.g., "gpt-creative", "grok-researcher", "claude-deep"
  provider: string;         // References a provider image key
  model: string;            // e.g., "gpt-4o", "grok-3", "claude-opus-4-6"
  personality?: string;     // System prompt for the worker
  secretKeys: string[];     // Which env vars to inject
}
```

### The `delegate_to_worker` MCP Tool

The lead agent gets a new MCP tool:

```
delegate_to_worker
  worker_id: string     — which worker definition to use
  prompt: string        — what to ask the worker
  context?: string      — optional context from the conversation
```

When invoked:
1. Host resolves `worker_id` → `WorkerDefinition` → provider image
2. Host spawns a worker container (uses a slot from the pool of 5)
3. Worker receives prompt via stdin, runs to completion, returns result via stdout
4. Result is returned to the lead agent as the tool response
5. Lead incorporates the result into its response to the user

The worker container is ephemeral — it starts, does its job, exits. No session, no history, no direct user communication.

### Container Protocol (Unchanged)

The existing stdin/stdout JSON protocol is the contract. Both lead and worker containers use it:

**Input** (stdin, single JSON blob):
```json
{
  "prompt": "Research the latest developments in quantum computing",
  "groupFolder": "dev-team",
  "chatJid": "120363...@g.us",
  "isMain": false,
  "isScheduledTask": false,
  "secrets": { "OPENAI_API_KEY": "sk-..." }
}
```

Workers don't get `sessionId` (they're stateless). The lead gets `sessionId` as it does today.

**Output** (stdout, wrapped in sentinel markers):
```
---CAMBOT_AGENT_OUTPUT_START---
{"status":"success","result":"Worker's response text","newSessionId":"sess-abc"}
---CAMBOT_AGENT_OUTPUT_END---
```

**IPC** (file-based, unchanged):
- `/workspace/ipc/messages/` — outbound messages
- `/workspace/ipc/tasks/` — task management
- `/workspace/ipc/input/` — inbound follow-up messages, `_close` sentinel

Workers can use `send_message` IPC if the lead explicitly wants them to post to the group (e.g., a research agent posting its findings directly). But by default, worker output flows back to the lead.

### One Container Image Per Provider (Open-Closed Principle)

Each provider gets its own container image. Adding a new provider means building a new image — not modifying existing ones. Adding a new *worker* (different model, different personality) is just a config entry.

```
container/
  agent-runner-claude/     # Existing agent-runner (renamed)
    src/index.ts           # Uses @anthropic-ai/claude-agent-sdk
    src/ipc-mcp-stdio.ts   # Shared (symlinked or copied)
    Dockerfile
  agent-runner-openai/     # New
    src/index.ts           # Uses openai SDK
    src/ipc-mcp-stdio.ts   # Same MCP server
    Dockerfile
  agent-runner-grok/       # New (thin wrapper — Grok uses OpenAI-compatible API)
    src/index.ts           # Uses openai SDK with xAI base URL
    src/ipc-mcp-stdio.ts   # Same MCP server
    Dockerfile
```

---

## Configuration

Configuration follows NanoClaw's existing patterns. The user configures *what's available*. The lead agent decides *when to use it*.

### 1. Secrets (`.env`)

Add provider API keys alongside the existing Anthropic key:

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
XAI_API_KEY=xai-...
```

### 2. Provider Images and Worker Definitions (`agents.yaml`)

A single config file defines available images and worker definitions:

```yaml
# Provider images — one per SDK, built once via ./container/build.sh
images:
  claude: cambot-agent-claude:latest
  openai: cambot-agent-openai:latest
  grok: cambot-agent-grok:latest

# Lead agent — the one the user talks to. Can be any agent definition.
# Change this to swap the lead to a different provider/model.
lead: claude-default

# Agent definitions — used for both the lead and workers.
# Same pool. The lead is just the one designated above.
agents:
  claude-default:
    provider: claude
    model: claude-sonnet-4-6
    secrets: [ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN]

  claude-deep:
    provider: claude
    model: claude-opus-4-6
    personality: "Take your time. Think deeply. Be thorough and analytical."
    secrets: [ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN]

  claude-fast:
    provider: claude
    model: claude-haiku-4-5
    personality: "Be concise. Short answers. No unnecessary detail."
    secrets: [ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN]

  gpt-creative:
    provider: openai
    model: gpt-4o
    personality: "Creative and expressive. Vivid language, storytelling focus."
    secrets: [OPENAI_API_KEY]

  gpt-mini:
    provider: openai
    model: gpt-4o-mini
    secrets: [OPENAI_API_KEY]

  grok-researcher:
    provider: grok
    model: grok-3
    personality: "Data-driven researcher. Cite sources. Check facts."
    secrets: [XAI_API_KEY]

  grok-casual:
    provider: grok
    model: grok-3
    personality: "Casual, witty, irreverent. Keep it fun."
    secrets: [XAI_API_KEY]
```

The `lead` field points to an agent definition. All other definitions are available as workers. Swapping the lead to a different provider is one line: `lead: gpt-creative`.

Loaded at startup, seeded into the DB. The lead agent can also create new definitions at runtime (e.g., user says "Create a worker called poet using OpenAI gpt-4o with personality 'Write everything as poetry'").

### 3. Lead Agent Awareness

At startup, the list of available workers is written to each group's workspace as `available_workers.json` (similar to existing `current_tasks.json` and `available_groups.json` patterns). The lead agent reads this to know what it can delegate to.

The lead's `CLAUDE.md` (per-group or global) can include instructions about when to delegate:

```markdown
## Available Workers

You have access to specialized workers via the `delegate_to_worker` tool.
Use them when a task would benefit from a different model's strengths:

- `gpt-creative` — Use for creative writing, storytelling, marketing copy
- `grok-researcher` — Use for research requiring real-time web data
- `claude-deep` — Use for complex analysis requiring deep reasoning
- `claude-fast` — Use for quick, low-cost sub-tasks

You decide when delegation is useful. For most requests, handle them yourself.
Only delegate when a worker's specialization would meaningfully improve the result.
```

### 4. Building Provider Images

```bash
./container/build.sh claude    # builds cambot-agent-claude:latest (already exists)
./container/build.sh openai    # builds cambot-agent-openai:latest
./container/build.sh grok      # builds cambot-agent-grok:latest
./container/build.sh all       # builds all provider images
```

Users only build images for providers they actually use. If you only want Claude workers with different personalities, you don't need to build anything — just add worker definitions pointing to the existing Claude image.

### 5. User Interaction

The user doesn't configure workers or delegation. They just chat:

> "Research quantum computing and write a creative summary"

The lead agent decides internally: *"I'll delegate the research to grok-researcher for real-time data, then delegate the summary to gpt-creative for better prose, then synthesize both into my response."*

The user sees one reply. The multi-agent orchestration is invisible.

If the user wants to manage workers explicitly (power user), they can talk to the main agent:

> "What workers are available?"
> "Add a new worker called 'translator' using gpt-4o with personality 'Professional translator'"
> "Remove the grok-casual worker"

---

## Host-Side Changes Summary

### 1. Types (`src/types.ts`)

Add `WorkerDefinition` interface.

### 2. Database (`src/db.ts`)

New table for worker definitions (seeded from `agents.yaml`, also writable at runtime):
```sql
CREATE TABLE IF NOT EXISTS worker_definitions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  personality TEXT,
  secret_keys TEXT NOT NULL  -- JSON array
);
```

New table mapping provider keys to container images:
```sql
CREATE TABLE IF NOT EXISTS provider_images (
  provider TEXT PRIMARY KEY,
  container_image TEXT NOT NULL
);
```

### 3. Config (`src/config.ts`)

Remove `CONTAINER_IMAGE` global constant. All images (lead and workers) resolve via `agent.provider → provider_images.container_image`. The lead agent ID is loaded from `agents.yaml` at startup.

### 4. Container Runner (`src/container-runner.ts`)

- `readSecrets()` becomes `readSecrets(secretKeys: string[])` — reads only the keys the agent needs.
- `buildContainerArgs()` takes `containerImage: string` parameter instead of using the global.
- `buildVolumeMounts()` — workers get minimal mounts (no `.claude/` settings, no project root). Just the IPC directory and a temp workspace.
- New `runWorkerAgent()` function — simplified version of `runContainerAgent()` for stateless workers (no session, no idle timeout, no follow-up messages).

### 5. MCP Server (`container/agent-runner/src/ipc-mcp-stdio.ts`)

New tool: `delegate_to_worker`. Writes an IPC file that the host picks up, spawns the worker container, waits for the result, and writes it back as another IPC file the lead reads.

### 6. IPC (`src/ipc.ts`)

New IPC message type: `delegate_worker`. The host processes it by:
1. Looking up the `WorkerDefinition`
2. Resolving provider → container image
3. Spawning the worker container with `runWorkerAgent()`
4. Writing the result back to the lead's IPC input directory

### 7. Orchestrator (`src/index.ts`)

Minimal changes. The lead container is still spawned exactly as today. Worker delegation happens through IPC, which the existing watcher already handles.

---

## Provider Containers

### Claude (Existing — Minimal Changes)

Rename `container/agent-runner/` to `container/agent-runner-claude/`. The existing code is nearly unchanged:

- `index.ts` — already correct. Uses `@anthropic-ai/claude-agent-sdk`.
- `SECRET_ENV_VARS` — stays `['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']`.
- Session resume — uses SDK's `resume`/`resumeSessionAt` (provider-specific feature).
- Hooks — `PreCompact` and `PreToolUse` hooks remain.
- Tools — full Claude Code toolset (`Bash`, `Read`, `Write`, `Edit`, etc.).

Used for both lead and worker roles. When used as lead, gets full session management and idle-wait loop. When used as a worker, runs stateless (no session resume, no idle timeout).

### OpenAI (New Image, ~200 Lines)

New `container/agent-runner-openai/src/index.ts`:

```typescript
// Pseudocode — same stdin/stdout protocol, different SDK
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: secrets.OPENAI_API_KEY });

// Read ContainerInput from stdin (identical to Claude runner)
// Start MCP server (identical — same ipc-mcp-stdio.ts)
// Convert MCP tools to OpenAI function-calling format
// Run completion loop with tool calls
// Write ContainerOutput to stdout with sentinel markers
```

Key differences from the Claude runner:
- No session resume (workers are stateless).
- Tool calling uses OpenAI's function-calling API instead of Claude's tool_use blocks.
- System prompt is passed directly (no `systemPrompt.preset`).
- No hooks system — bash sanitization is done inline.

### Grok/xAI (OpenAI-Compatible, Trivial Delta)

Grok's API is OpenAI-compatible. The Grok runner is a thin wrapper:

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: secrets.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

// Everything else identical to OpenAI runner
```

### Shared MCP Server

`ipc-mcp-stdio.ts` is already provider-agnostic. Each provider runner spawns it identically. For providers without native MCP support (OpenAI, Grok), the runner converts MCP tool definitions to the provider's function-calling format and bridges calls.

---

## Use Case Walkthroughs

### 1. Simple Request (No Delegation)

User: *"What's the weather like today?"*

The lead agent handles it directly. No workers involved. Identical to today.

### 2. Creative Writing Task

User: *"Write me a short story about a time-traveling cat"*

The lead agent decides GPT is better for creative prose:
1. Lead calls `delegate_to_worker(worker_id: "gpt-creative", prompt: "Write a short story about a time-traveling cat. Make it vivid and whimsical.")`
2. Host spawns `cambot-agent-openai:latest` with the gpt-creative personality
3. Worker writes the story, returns it via stdout
4. Lead receives the result, optionally polishes or frames it, sends to user

The user sees one story from their assistant.

### 3. Research + Analysis (Multi-Delegation)

User: *"Should I invest in quantum computing stocks?"*

The lead decides this needs multiple perspectives:
1. Lead calls `delegate_to_worker(worker_id: "grok-researcher", prompt: "Research current state of quantum computing industry, recent breakthroughs, major players, stock performance 2025-2026. Cite sources.")`
2. Lead calls `delegate_to_worker(worker_id: "claude-deep", prompt: "Given this research: {grok's output}. Analyze the investment case. Consider risks, timeline to commercialization, and market dynamics.")`
3. Lead synthesizes both into a single, balanced response
4. User sees one thoughtful answer with research and analysis woven together

### 4. Council Mode (Parallel Perspectives)

User: *"I'm thinking about moving to Austin. What do you think?"*

The lead decides to get multiple angles:
1. Lead delegates in parallel:
   - `grok-researcher`: "Research Austin TX — cost of living, job market, climate, growth trends"
   - `gpt-creative`: "Write a vivid description of daily life in Austin — the culture, food, music scene"
   - `claude-deep`: "Analyze the practical trade-offs of relocating to Austin"
2. Lead synthesizes all three into one response: facts, vibes, and analysis

### 5. Workflow Integration (Future)

For complex multi-step tasks, the lead can trigger a `cambot-workflow`:

User: *"Generate my weekly newsletter"*

1. Lead triggers workflow `weekly-newsletter`
2. Workflow runs steps:
   - `grok-researcher` → gathers news from the week
   - `claude-deep` → analyzes and prioritizes stories
   - `gpt-creative` → writes engaging newsletter copy
   - `message` step → formats and sends via email
3. Lead confirms to user: "Newsletter sent"

The workflow runner handles sequencing, cost tracking, and policy enforcement. The lead just kicks it off.

---

## Concurrency and the Pool of 5

The `MAX_CONCURRENT_CONTAINERS = 5` limit is shared across leads and workers. Typical scenarios:

```
Slot 1: family-chat lead     (Claude, long-running session)
Slot 2: dev-team lead        (Claude, long-running session)
Slot 3: worker: grok-researcher (ephemeral, finishes in ~30s)
Slot 4: worker: gpt-creative    (ephemeral, finishes in ~20s)
Slot 5: [available]
```

Workers are short-lived — they don't hold IPC connections or idle-wait like leads. They start, process, return, exit. This means they free slots quickly.

If the pool is full, worker requests queue in `GroupQueue` and execute when a slot opens. The lead's IPC polling keeps it alive while waiting for the result.

---

## Implementation Sequence

### Phase 1: Foundation (No New Providers Yet)

1. Add `WorkerDefinition` type and `worker_definitions` DB table.
2. Add `provider_images` DB table.
3. Create `agents.yaml` loader — validates, seeds DB at startup.
4. Refactor `container-runner.ts`: parameterize `readSecrets()`, `buildContainerArgs()`.
5. Add `runWorkerAgent()` — simplified container runner for stateless workers.
6. Existing groups continue working identically — lead is still the only agent.

### Phase 2: Delegation MCP Tool

1. Add `delegate_to_worker` MCP tool to `ipc-mcp-stdio.ts`.
2. Add `delegate_worker` IPC message type to `src/ipc.ts`.
3. Host-side handler: resolve worker → spawn container → return result via IPC.
4. Write `available_workers.json` to each group's workspace at container start.
5. Test: lead agent can successfully delegate to a Claude worker (same provider, different model).

### Phase 3: OpenAI Provider Container

1. Create `container/agent-runner-openai/` with OpenAI SDK agent runner.
2. Implement the stdin/stdout contract with sentinel markers.
3. Bridge MCP tools to OpenAI function-calling format.
4. Build `cambot-agent-openai:latest` image.
5. Add OpenAI worker definitions to `agents.yaml`.

### Phase 4: Grok Provider Container

1. Fork OpenAI runner with xAI base URL.
2. Build `cambot-agent-grok:latest` image.
3. Add Grok worker definitions to `agents.yaml`.

### Phase 5: Worker Management

1. MCP tools for the lead to manage worker definitions (create, list, remove).
2. UI support in cambot-core-ui for viewing available workers and delegation history.

### Phase 6: Workflow Integration

1. Wire `cambot-workflows` into the host as the orchestration layer for multi-step delegation.
2. Workflow `agent` step handler calls `runWorkerAgent()` with the step's worker ID.
3. Lead gains `run_workflow` MCP tool to trigger workflows.

---

## What Doesn't Change

These components require zero modifications:

| Component | Why |
|-----------|-----|
| **Group queue** (`src/group-queue.ts`) | Manages `ChildProcess` lifecycle. Provider-blind. Workers are just more processes. |
| **IPC MCP server** (`container/agent-runner/src/ipc-mcp-stdio.ts`) | Gains one new tool (`delegate_to_worker`), but the file-based IPC mechanism is unchanged. |
| **Router** (`src/router.ts`) | Formats and dispatches messages. Only talks to the lead. Provider-blind. |
| **Scheduler** (`src/task-scheduler.ts`) | Fires tasks by schedule. Provider-blind. |
| **Channels** (WhatsApp, Telegram, Discord) | Deliver messages. Only interact with the lead. |
| **Mount security** (`src/mount-security.ts`) | Validates mount paths. Provider-blind. |
| **Container runtime** (`src/container-runtime.ts`) | Detects Docker/Podman/Apple Container. Provider-blind. |
| **Logger, env, group-folder** | Infrastructure utilities. |
| **cambot-core** (memory, telemetry, security) | Operates on the host DB. No container awareness. |
| **User experience** | User talks to one assistant. Always. The delegation is invisible. |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Workers lack Claude's tool-use depth (no `Read`, `Write`, `Edit` built-ins) | Workers start with `Bash` + MCP tools only. The lead handles file operations. Workers are for thinking/generating, not acting. |
| Delegation latency (spawning a container for a sub-task) | Workers are lightweight — no session resume, no idle wait. Container startup is the main cost (~2-5s). Cache warm images. |
| Pool exhaustion (lead + multiple workers fill all 5 slots) | Workers are ephemeral and short-lived. Queue handles overflow. Consider raising `MAX_CONCURRENT_CONTAINERS` for power users. |
| Lead agent makes poor delegation decisions | Tunable via `CLAUDE.md` instructions. Start conservative — lead handles most things, only delegates when instructed or when clear benefit. |
| Secret sprawl (many API keys in `.env`) | `secretKeys` array ensures each worker only receives what it needs. Lead never sees worker secrets. Workers never see lead secrets. |
| MCP tool bridging complexity for non-Claude providers | Start with the 6 MCP tools (send_message, schedule_task, etc.). Workers mostly just need to think and respond — not manage tasks. |

---

## Resolved Decisions

1. **Lead/worker model** — The user sees one assistant. The lead orchestrates. Workers are invisible implementation details.
2. **Lead is provider-agnostic** — The lead is designated in `agents.yaml`, not hardcoded to Claude. Swapping the lead to a different provider is a one-line config change. Agent definitions are a single pool used for both lead and worker roles.
3. **Images vs. definitions** — Provider images are few and generic (one per SDK). Agent definitions are unlimited config entries. Adding a new agent never requires building a new image.
4. **Configuration UX** — Users configure *what's available* (`agents.yaml`) and designate the lead. The lead agent decides *when to delegate*. No per-group agent assignment needed.
5. **Security model** — Preserved from NanoClaw. One container image per provider. Secrets scoped per-agent. Container isolation between lead and workers.

## Open Questions

1. **Delegation protocol** — Synchronous (lead waits for worker result via IPC polling) vs. asynchronous (lead continues, gets notified when worker finishes)? Synchronous is simpler but blocks the lead.
2. **Worker tool access** — Should workers get MCP tools (send_message, schedule_task)? Or should they be pure think-and-respond agents with no side effects?
3. **Personality injection** — Append to system prompt, or use provider-specific mechanisms (Claude's `systemPrompt.append` vs. OpenAI's system message)?
4. **Workflow integration timing** — Wire in `cambot-workflows` as part of v1, or add it in a later phase after basic delegation is working?
