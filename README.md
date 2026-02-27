# Sovereign

Self-governing AI agents with memory, tools, money, and delegation.

Deploy an autonomous AI agent on any VPS for $4/month. It has its own memory, can spawn sub-agents, make payments, and gets smarter over time.

## What It Does

- **Always-on agent** — lives on Discord (Slack coming), responds to messages, runs scheduled tasks
- **Memory that learns** — BM25 search over workspace files, observational compression, auto-learning from corrections
- **Delegation** — agents spawn sub-agents in isolated Docker containers for parallel work
- **Payments** — x402 protocol lets agents pay for web services (private keys never enter containers)
- **Multi-model** — routes tasks to the right model (smart models for thinking, cheap models for grunt work)
- **Security** — credential scrubbing, DM allowlists, container isolation, tool guards

## Architecture

```
Discord/Slack ──> Host (Sovereign)
                    ├── SQLite (messages, tasks, sessions)
                    ├── Cron scheduler (recurring jobs)
                    ├── Delegation handler (spawns workers)
                    ├── x402 handler (signs payments)
                    └── Credential scrubber
                          │
                          ▼
                   Docker Container (per conversation/task)
                    ├── Claude Code (Agent SDK)
                    ├── MCP Tools (recall, remember, delegate, pay, sms, call)
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
node dist/index.js
```

For VPS deployment, see [docs/quickstart.md](docs/quickstart.md) (coming soon).

## What's Built (v0.1.0)

| Feature | Status |
|---------|--------|
| Discord channel | Done |
| Delegation (multi-agent via IPC) | Done |
| BM25 memory search (pure JS, zero deps) | Done |
| x402 payments (host-side, key isolation) | Done |
| Credential scrubbing (logs + outbound messages) | Done |
| DM allowlist + stale message skip | Done |
| Per-task model override | Done |
| Cron auto-pause (5 consecutive failures) | Done |
| Agent OS template (universal agent config) | Done |
| Expanded container (python3, ffmpeg, 15+ npm packages) | Done |

## Roadmap

### v0.2.0 — Observational Memory
Inspired by [Mastra](https://mastra.ai/blog/observational-memory) and [OpenClaw-RL](https://github.com/Gen-Verse/OpenClaw-RL).

- [ ] **Observer agent** — compress conversations into prioritized observations ([#1](../../issues/1))
- [ ] **Reflector agent** — intelligent garbage collection for memory ([#2](../../issues/2))
- [ ] **Structured memory** — split into operational/people/incidents/decisions ([#3](../../issues/3))
- [ ] **Auto-learning loop** — detect corrections, update knowledge automatically ([#4](../../issues/4))
- [ ] **Hindsight learnings** — auto post-mortem on failed conversations ([#5](../../issues/5))
- [ ] **Conversation quality tracker** — JSONL audit trail with implicit scoring ([#6](../../issues/6))
- [ ] **Evaluation gate** — self-check quality before delivering responses ([#8](../../issues/8))

### v0.3.0 — Security & Deploy
Inspired by [baudbot](https://github.com/modem-dev/baudbot) and [Perplexity Computer](https://perplexity.ai).

- [ ] **Smart model routing** — auto-pick best model by task type ([#7](../../issues/7))
- [ ] **Task templates** — reusable structured prompts with anti-pattern guardrails ([#9](../../issues/9))
- [ ] **Tool guard** — pre-execution security layer ([#10](../../issues/10))
- [ ] **Atomic rollback deploys** — symlink-based releases ([#11](../../issues/11))
- [ ] **CLI** — `sovereign init/deploy/status/logs/rollback` ([#12](../../issues/12))

### v0.4.0 — Multi-agent & Channels
- [ ] **Multi-repo workspaces** — per-task git worktrees ([#13](../../issues/13))
- [ ] **Slack channel** ([#14](../../issues/14))
- [ ] **Sentry agent** — automated incident triage ([#15](../../issues/15))

### v1.0.0 — Production Ready
- [ ] **Clean codebase** — proper TypeScript, no monkey-patches ([#16](../../issues/16))
- [ ] **Plugin system** — drop-in MCP tools ([#17](../../issues/17))
- [ ] **Documentation** — README, quickstart, architecture guide ([#18](../../issues/18))

## Key Concepts

**Agent = disposable worker.** Each conversation or task runs in its own Docker container. Containers are ephemeral — they spin up, do work, and exit. No persistent state inside containers.

**Host = command center.** The host process holds all secrets (API keys, wallet keys, tokens). Containers never see them. Communication happens via filesystem IPC.

**Memory = workspace files.** Agents read/write to their workspace (knowledge/, daily/, projects/, etc.). BM25 search finds relevant information. Observer compression keeps memory bounded and high-signal.

**Delegation = agents spawning agents.** An agent can call `delegate_task` to spawn a worker container for parallel work. Workers are isolated — no access to the parent's chat history.

## Forked From

[NanoClaw](https://github.com/qwibitai/nanoclaw) by Gavriel — a lightweight, secure AI assistant framework. Sovereign adds delegation, memory intelligence, payments, and self-improvement on top.

## License

MIT
