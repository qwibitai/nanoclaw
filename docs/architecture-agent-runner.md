# NanoClaw — Architecture: Agent Runner

## Executive Summary

The agent runner is a Node.js process that runs **inside a Docker (or Apple Container) container**, one instance per agent invocation. It receives a conversation context via stdin, runs the Claude Agent SDK query loop, exposes MCP tools for messaging and task scheduling, and streams responses back to the orchestrator via stdout.

Each invocation is ephemeral. The container starts, processes the input, and exits. Per-group state (agent memory) persists in the mounted `groups/{name}/CLAUDE.md` on the host filesystem.

**Language:** TypeScript (ESM)
**Runtime:** Node.js 22 (inside `node:22-slim` Docker image)
**SDK:** @anthropic-ai/claude-agent-sdk ^0.2.34
**MCP:** @modelcontextprotocol/sdk ^1.12.1

---

## Architecture Pattern

**Ephemeral subprocess with stdio I/O and MCP sidecar.**

```
Host (stdin) → ContainerInput JSON
                      ↓
              index.ts entry point
              ├── Parse input
              ├── Create MessageStream (AsyncIterable)
              ├── Spawn MCP server process (ipc-mcp-stdio.ts via stdio)
              └── Run query() SDK loop
                      ↓
              Claude API (via SDK)
                      ↓
              Agent calls MCP tools
                      ↓
              ipc-mcp-stdio.ts writes IPC files to /ipc/
                      ↓
              OUTPUT_START_MARKER
              <response text>
              OUTPUT_END_MARKER → stdout (host reads)
```

---

## Technology Stack

| Category | Technology | Version | Role |
|----------|-----------|---------|------|
| Runtime | Node.js | 22 (container) | Process host |
| Language | TypeScript | (compiled at start) | Agent runner source |
| Agent SDK | @anthropic-ai/claude-agent-sdk | ^0.2.34 | Claude Agent query loop |
| MCP SDK | @modelcontextprotocol/sdk | ^1.12.1 | MCP stdio server |
| Scheduling | cron-parser | ^5.5.0 | Cron expression validation in MCP tools |
| Validation | zod | ^4.3.6 | Input schema validation |
| Browser | Chromium (system) + agent-browser | via Dockerfile | Browser automation capability |
| Claude Code | @anthropic-ai/claude-code | global in image | Available as a Bash tool |

---

## Module Overview

### `container/agent-runner/src/index.ts` — Entry Point

Main process. Reads `ContainerInput` from stdin, runs the Claude Agent SDK, streams output.

**Startup sequence:**
1. Read and parse `ContainerInput` from stdin (until EOF)
2. Load session ID from `/db/sessions` (or create new session)
3. Start MCP server process (`ipc-mcp-stdio.ts`) as a stdio subprocess
4. Create `MessageStream` with initial messages
5. Register lifecycle hooks: `createPreCompactHook()`, `createSanitizeBashHook()`
6. Run `query()` SDK loop
7. For each assistant response: write `OUTPUT_START_MARKER / text / OUTPUT_END_MARKER` to stdout
8. Poll `/ipc/input/` for follow-up messages from the orchestrator
9. Exit when stdin closes and no more messages

**Session management:**
- Sessions mapped by `groupFolder` → `session_id` in SQLite (mounted read-write at `/db/`)
- Sessions persist conversation context across container invocations
- For `contextMode == "isolated"` scheduled tasks, sessions are not persisted

### `MessageStream` — Push-based AsyncIterable

A custom AsyncIterable that feeds messages to the SDK's `query()` function. Supports:
- Initial batch of messages from `ContainerInput`
- Follow-up messages pushed from the IPC input poller
- Graceful close signal (`{ type: "_close" }`)

This enables multi-turn conversations within a single container invocation — the orchestrator pushes new user messages while the SDK is still processing.

### `createPreCompactHook()` — Transcript Archival

A pre-compact hook registered with the SDK. Before context compaction, the current conversation transcript is archived to `conversations/{timestamp}.json` in the group's workspace (`/workspace/conversations/`).

This preserves conversation history across compactions, enabling long-term memory via the filesystem.

### `createSanitizeBashHook()` — Secret Sanitization

A tool call hook that intercepts Bash tool invocations and removes sensitive environment variables (API keys, tokens, credentials) from the subprocess environment before execution.

### `container/agent-runner/src/ipc-mcp-stdio.ts` — MCP Server

A Model Context Protocol server running on stdio (launched as a child process by `index.ts`). Exposes tools to the Claude agent.

**Exposed MCP tools:**

| Tool | Description |
|------|-------------|
| `send_message` | Write a message IPC file → orchestrator sends WhatsApp message |
| `schedule_task` | Write a task IPC file → orchestrator creates scheduled task |
| `list_tasks` | Read `/tasks.json` snapshot → return task list |
| `pause_task` | Write a control IPC file → orchestrator pauses task |
| `resume_task` | Write a control IPC file → orchestrator resumes task |
| `cancel_task` | Write a control IPC file → orchestrator cancels task |
| `register_group` | Write a registration IPC file → orchestrator registers group |

**IPC file writing:** All writes are atomic (write to temp file, then rename) to prevent the orchestrator from reading incomplete files.

See [api-contracts-orchestrator.md](./api-contracts-orchestrator.md) for full MCP tool schemas.

---

## Container Image

Built from `container/Dockerfile`. Base: `node:22-slim`.

**Image contents:**
- Chromium and system dependencies for browser automation
- `agent-browser` skill (global npm install) — provides Bash-callable browser automation
- `@anthropic-ai/claude-code` (global npm install) — available as a Bash tool within the agent
- `nanoclaw-agent-runner` package (built into image at `/app/`)

**Startup entrypoint:**
1. Re-compile TypeScript: `tsc --project /app/tsconfig.json --outDir /tmp/dist`
   - This step happens at **every container start**, not just at image build
   - Purpose: allows per-group `groups/{name}/` to contain customized TypeScript if needed
2. Execute `/tmp/dist/index.js` via `node`

**Why recompile on start?** The agent runner TypeScript is compiled fresh from the mounted group workspace. This is currently a constant recompile but enables future per-group agent customization by placing TypeScript files in the workspace.

---

## Volume Mounts (at Runtime)

| Host Path | Container Path | Mode |
|-----------|---------------|------|
| `groups/{name}/` | `/workspace` | read-write |
| `data/ipc/{name}/` | `/ipc` | read-write |
| `data/tasks-{name}.json` | `/tasks.json` | read-only |
| `data/groups.json` | `/groups.json` | read-only |
| `store/messages.db` | `/db/messages.db` | read-only |

The agent's working directory is `/workspace`. `groups/{name}/CLAUDE.md` (mounted as `/workspace/CLAUDE.md`) serves as the agent's persistent memory — Claude Code reads this file as project instructions.

---

## Agent Capabilities

Inside the container, the Claude agent has access to:

| Capability | Tool/Method |
|-----------|------------|
| WhatsApp messaging | `send_message` MCP tool |
| Task scheduling | `schedule_task` MCP tool |
| Task management | `list_tasks`, `pause_task`, `resume_task`, `cancel_task` |
| Group registration | `register_group` MCP tool |
| Bash execution | Built-in Bash tool (Claude Agent SDK) |
| File I/O | Read/Write tools (in `/workspace`) |
| Browser automation | `agent-browser` via Bash |
| Claude Code | `claude` CLI via Bash |
| Web search | WebSearch tool (if enabled) |

---

## Security

**Container boundary:**
- The agent runs in an isolated container — no access to host filesystem except mounted paths
- Bash tool can execute arbitrary commands within the container
- No network restrictions by default (intentional — agent may need to fetch data)

**Secret sanitization:**
- `createSanitizeBashHook()` strips `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and similar variables from Bash subprocess environments
- Prevents accidental secret leakage to child processes

**IPC authorization:**
- All IPC files must include the correct `groupFolder` and `chatJid`
- The orchestrator rejects IPC messages that reference other groups

**Per-group isolation:**
- Each group has its own `/workspace` mount, `/ipc` mount, and session
- Groups cannot read each other's workspace or IPC directories

---

## Async / Event Patterns

| Pattern | Used For |
|---------|---------|
| Push-based AsyncIterable | Feed messages to SDK query loop |
| Filesystem polling (IPC input) | Receive follow-up messages while running |
| stdio subprocess (MCP server) | Agent ↔ tool communication |
| Pre-compact hook | Transcript archival before context compaction |
| Tool call hook | Sanitize Bash env before execution |

---

## Development

### Local testing

```bash
# Build the container image
./container/build.sh

# Run manually (test mode)
echo '{"messages":[],"groupFolder":"test","chatJid":"test@s.whatsapp.net","assistantName":"Andy"}' | \
  docker run -i nanoclaw-agent:latest
```

### Modify agent tools

1. Edit `container/agent-runner/src/ipc-mcp-stdio.ts` — add/modify MCP tools
2. Edit corresponding handler in `src/ipc.ts` — process new IPC files
3. Rebuild: `./container/build.sh`

### View container logs

Per-run logs at: `groups/{name}/logs/container-{timestamp}.log`

Or live:
```bash
docker logs -f <container_name>
```
