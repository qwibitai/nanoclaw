# Sovereign

Self-governing AI agents with memory, tools, money, and delegation.

Deploy an autonomous AI agent on any VPS for $4/month. It has its own memory, can spawn sub-agents, make payments, and gets smarter over time.

## What It Does

- **Always-on agent** — lives on Discord, Slack, or WhatsApp; responds to messages; runs scheduled tasks
- **Memory that learns** — BM25 search over workspace files, observational compression, auto-learning from corrections
- **Delegation** — agents spawn sub-agents in isolated Docker containers for parallel work
- **Payments** — x402 protocol lets agents pay for web services (private keys never enter containers)
- **Multi-model** — routes tasks to the right model (smart models for thinking, cheap models for grunt work)
- **Security** — credential scrubbing, DM allowlists, container isolation, tool guards
- **Plugin tools** — 20 MCP tools in modular files, one line to add a new plugin

## Architecture

```
Discord/Slack/WhatsApp ──> Host (Sovereign)
                            ├── SQLite (messages, tasks, sessions)
                            ├── Cron scheduler (recurring jobs)
                            ├── Delegation handler (spawns workers)
                            ├── x402 handler (signs payments)
                            ├── Observer + Reflector (memory intelligence)
                            └── Credential scrubber
                                  │
                                  ▼
                           Docker Container (per conversation/task)
                            ├── Claude Code (Agent SDK)
                            ├── MCP Tools (20 plugins: recall, delegate, pay, sms, relay...)
                            ├── Workspace (memory files, knowledge, daily notes)
                            └── IPC (filesystem-based, host ↔ container)
```

Single Node.js host process. Each agent conversation runs in an isolated Docker container with only its workspace mounted. Secrets stay on the host — containers communicate via IPC.

## Quick Start

```bash
git clone https://github.com/brandontan/sovereign.git
cd sovereign
cp .env.example .env
# Fill in: ANTHROPIC_API_KEY (or OpenRouter), DISCORD_BOT_TOKEN
npm install
npm run build
cd container && ./build.sh && cd ..
node dist/index.js
```

See [docs/quickstart.md](docs/quickstart.md) for the full deployment guide.

## Features

| Feature | Status |
|---------|--------|
| Discord channel | Done |
| Slack channel | Done |
| Delegation (multi-agent via IPC) | Done |
| BM25 memory search (pure JS, zero deps) | Done |
| x402 payments (host-side, key isolation) | Done |
| Credential scrubbing (logs + outbound messages) | Done |
| DM allowlist + stale message skip | Done |
| Per-task model override | Done |
| Cron auto-pause (5 consecutive failures) | Done |
| Agent OS template (universal agent config) | Done |
| Observer agent (conversation compression) | Done |
| Reflector agent (memory garbage collection) | Done |
| Structured memory (operational/people/incidents) | Done |
| Auto-learning loop (correction detection) | Done |
| Hindsight learnings (post-mortem on failures) | Done |
| Conversation quality tracker (JSONL audit) | Done |
| Evaluation gate (quality self-check) | Done |
| Smart model routing (task-based model selection) | Done |
| Task templates (structured prompts) | Done |
| Tool guard (pre-execution security) | Done |
| Atomic rollback deploys | Done |
| CLI (`sovereign init/deploy/status/logs/rollback`) | Done |
| Multi-repo workspaces (per-task worktrees) | Done |
| Sentry agent (incident triage) | Done |
| Plugin system (modular MCP tools) | Done |
| Agent relay (peer-to-peer messaging) | Done |

## Documentation

- [Quick Start](docs/quickstart.md) — 5-minute deploy guide
- [Architecture](docs/architecture.md) — host/container split, IPC, sessions, plugins, memory
- [Tools Reference](docs/tools.md) — all 20 MCP tools with parameters
- [Security](docs/SECURITY.md) — threat model and mitigations
- [SDK Deep Dive](docs/SDK_DEEP_DIVE.md) — Agent SDK internals

## Key Concepts

**Agent = disposable worker.** Each conversation or task runs in its own Docker container. Containers are ephemeral — they spin up, do work, and exit. No persistent state inside containers.

**Host = command center.** The host process holds all secrets (API keys, wallet keys, tokens). Containers never see them. Communication happens via filesystem IPC.

**Memory = workspace files.** Agents read/write to their workspace (knowledge/, daily/, projects/, etc.). BM25 search finds relevant information. Observer compression keeps memory bounded and high-signal.

**Delegation = agents spawning agents.** An agent can call `delegate_task` to spawn a worker container for parallel work. Workers are isolated — no access to the parent's chat history.

## Forked From

[NanoClaw](https://github.com/qwibitai/nanoclaw) by Gavriel — a lightweight, secure AI assistant framework. Sovereign adds delegation, memory intelligence, payments, multi-channel support, and self-improvement on top.

## License

MIT
