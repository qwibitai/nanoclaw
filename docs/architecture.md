# Architecture

## Overview

Sovereign is a single Node.js host process that manages AI agent conversations in isolated Docker containers. The host handles channels (Discord, Slack, WhatsApp), scheduling, delegation, payments, and security. Each conversation runs in its own container with only its workspace mounted.

```
Discord/Slack/WhatsApp ──> Host Process
                            ├── Channel handlers (receive messages)
                            ├── Group queue (per-group message ordering)
                            ├── Container runner (spawn/manage containers)
                            ├── Task scheduler (cron jobs)
                            ├── Delegation handler (spawn worker containers)
                            ├── x402 handler (sign payments)
                            ├── Relay handler (agent-to-agent messaging)
                            ├── Elicitation handler (structured questions)
                            ├── Observer (conversation compression)
                            ├── Reflector (memory garbage collection)
                            ├── Auto-learner (correction detection)
                            ├── Quality tracker (JSONL audit trail)
                            └── Credential scrubber (outbound filtering)
                                  │
                                  ▼
                           Docker Container (per conversation/task)
                            ├── Claude Code (Agent SDK)
                            ├── MCP Server (tool plugins)
                            ├── Workspace (/workspace/group/)
                            └── IPC (/workspace/ipc/)
```

## Host ↔ Container Communication

All communication uses **filesystem IPC** — JSON files written to shared directories.

| Direction | Path | Purpose |
|-----------|------|---------|
| Host → Container | `/workspace/ipc/input/*.json` | Follow-up messages |
| Container → Host | `/workspace/ipc/messages/*.json` | Outbound messages |
| Container → Host | `/workspace/ipc/tasks/*.json` | Schedule/pause/cancel tasks |
| Bidirectional | `/workspace/ipc/delegate-{requests,responses}/` | Delegation |
| Bidirectional | `/workspace/ipc/x402-{requests,responses}/` | Payments |
| Bidirectional | `/workspace/ipc/elicitation-{requests,responses}/` | Structured questions |
| Bidirectional | `/workspace/ipc/relay-{outbox,inbox,receipts}/` | Agent relay |
| Container → Host | `/workspace/ipc/tool-calls-*.jsonl` | Tool observability logs |

## Sessions

Each group gets a persistent session directory at `data/sessions/{group}/.claude/`. The container mounts this as its Claude Code project directory, providing session continuity across container restarts.

## Plugin System

MCP tools are organized as plugins in `container/agent-runner/src/tools/`:

```
tools/
├── index.ts          — registerAllTools() entry point
├── messaging.ts      — send_message
├── scheduling.ts     — schedule/list/pause/resume/cancel_task
├── groups.ts         — register_group
├── memory.ts         — recall, recall_detail, remember (BM25)
├── signalwire.ts     — send_sms, check_messages, make_call, check_calls
├── payments.ts       — x402_fetch
├── delegation.ts     — delegate_task
├── elicitation.ts    — ask_structured
├── self-knowledge.ts — self_knowledge
└── relay.ts          — send_relay, check_relay
```

Each plugin exports a `register(server, ctx)` function. The shared `ToolContext` provides IPC helpers, rate limiting, and spend tracking.

The MCP server (`ipc-mcp-stdio.ts`) wraps all tools with:
- **Observability** — JSONL logging of every tool call (duration, args, success/failure)
- **Tool guard** — pre-execution security layer (block dangerous patterns)
- **Credential scrubbing** — redact API keys and tokens from logged args

## Memory

Agents use a workspace directory structure:

```
groups/{name}/
├── CLAUDE.md           — agent identity and instructions
├── knowledge/          — persistent knowledge files
│   ├── patterns.md     — lessons learned
│   ├── preferences.md  — user preferences
│   └── capabilities.json — self-knowledge
├── daily/              — daily notes (YYYY-MM-DD.md)
├── projects/           — project-specific notes
├── conversations/      — archived conversation transcripts
└── learnings/          — auto-extracted learnings
```

The `recall` tool uses BM25 search across all workspace files. The `remember` tool writes to workspace files. Observer and reflector agents compress and curate memory over time.

## Security

- **Container isolation** — each conversation runs in its own Docker container
- **Secret isolation** — API keys, wallet keys, and tokens stay on the host; containers never see them
- **Credential scrubbing** — outbound messages and logs are filtered for API key patterns
- **Tool guard** — configurable block/pause/allow lists for MCP tools
- **DM allowlist** — restrict who can DM the bot
- **Bash sanitization** — secret env vars unset before shell commands in containers
