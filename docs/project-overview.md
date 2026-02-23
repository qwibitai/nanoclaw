# NanoClaw — Project Overview

## Summary

NanoClaw is a self-hosted personal Claude assistant that connects to WhatsApp (and optionally other messaging channels). It runs Claude Agent SDK instances inside isolated containers, one per chat group, with persistent per-group memory and full tool access (filesystem, browser, code execution, scheduling).

**Version:** 1.1.0
**Package name:** `nanoclaw`
**License:** Personal use

---

## Purpose

> Run your own Claude assistant on your own phone number — with full agent capabilities, isolated per-group contexts, and no third-party services except the Claude API.

Key design goals:
- **Personal**: Responds only in registered groups; no public bot
- **Isolated**: Each group gets its own container, filesystem, and memory
- **Capable**: Full Claude Agent SDK — not just Q&A, but file manipulation, browser automation, scheduled tasks, and custom skills
- **Secure**: Allowlist-based filesystem access, IPC authorization, secret sanitization
- **Upgradable**: Upstream NanoClaw updates apply without overwriting customizations

---

## Architecture Type

**Multi-part backend** — two distinct runtimes communicating via process I/O and filesystem:

| Part | Location | Description |
|------|----------|-------------|
| Orchestrator | `src/` (Node.js on host) | Message ingestion, routing, IPC, scheduling |
| Agent Runner | `container/` (Node.js in container) | Claude Agent SDK, MCP tools, browser |

See [integration-architecture.md](./integration-architecture.md) for how they communicate.

---

## Technology Stack

### Orchestrator (host)

| Category | Technology |
|----------|-----------|
| Runtime | Node.js 22 |
| Language | TypeScript 5.9 (ESM, strict) |
| WhatsApp | @whiskeysockets/baileys v7 |
| Database | SQLite via better-sqlite3 |
| Logging | pino |
| Service | launchd (macOS) / systemd (Linux) |

### Agent Runner (container)

| Category | Technology |
|----------|-----------|
| Runtime | Node.js 22 (Docker/Apple Container) |
| AI | Claude Agent SDK (Anthropic) |
| Tools | MCP (Model Context Protocol) |
| Browser | Chromium + agent-browser |
| Base image | node:22-slim |

---

## Repository Structure

```
nanoclaw/
├── src/              Orchestrator source (TypeScript)
├── container/        Agent runner + Dockerfile
├── groups/           Per-group filesystems (runtime, git-ignored)
├── store/            SQLite DB + WhatsApp auth (runtime, git-ignored)
├── data/             IPC files + snapshots (runtime, git-ignored)
├── setup/            Setup wizard
├── skills-engine/    Skills management
├── docs/             Project documentation
└── .github/          CI (GitHub Actions)
```

See [source-tree-analysis.md](./source-tree-analysis.md) for full annotated tree.

---

## Key Capabilities

### Message Processing
- Responds to WhatsApp messages in registered groups
- Configurable trigger pattern (`@Andy` or all messages)
- Per-group conversation memory via Claude Code sessions
- Multi-turn conversations within a single container run

### Agent Tools (inside container)
- Bash execution (arbitrary commands)
- File read/write in group workspace
- Browser automation (Chromium)
- Web search
- Claude Code CLI

### Scheduling
- Create tasks that run on cron, interval, or one-time schedules
- Tasks run as isolated agent invocations
- Results sent back to the originating WhatsApp chat

### Skills
- Installable Claude Code skills extend agent behavior
- Built-in skills: `/setup`, `/debug`, `/update`, `/customize`
- Skills can add Telegram, Gmail, Twitter/X, voice transcription, and more

---

## Registered Groups

NanoClaw operates on "registered groups" — WhatsApp groups (or DMs) that have been explicitly registered with:
- A folder name (for filesystem isolation)
- A trigger pattern (e.g., `@Andy`)
- Container config (optional additional mounts)
- `requires_trigger` flag (respond to all vs. trigger-only)

Groups are stored in the `registered_groups` SQLite table and can be added via `/setup` or the `register_group` MCP tool.

---

## Data Storage

All state is in a single SQLite database (`store/messages.db`):

| Table | Contents |
|-------|---------|
| `chats` | WhatsApp chat metadata |
| `messages` | Message content (registered groups only) |
| `scheduled_tasks` | All tasks with schedule and status |
| `task_run_logs` | Append-only task execution history |
| `router_state` | Polling cursors (last processed message timestamp) |
| `sessions` | Claude Agent SDK session IDs per group |
| `registered_groups` | Group registration records |

See [data-models.md](./data-models.md) for full schema.

---

## Getting Started

1. **Install**: `npm install`
2. **Configure**: Copy `.env.example` → `.env`, add `ANTHROPIC_API_KEY`
3. **Authenticate WhatsApp**: `npm run auth`
4. **Build container**: `./container/build.sh`
5. **Run setup wizard**: `npm run setup` (or `/setup` in Claude Code)
6. **Start**: Managed by launchd/systemd after setup

Or use the `/setup` skill for a fully guided walkthrough.

Full instructions: [development-guide.md](./development-guide.md) | [deployment-guide.md](./deployment-guide.md)

---

## Channels

NanoClaw supports multiple messaging channels. The default is WhatsApp. Additional channels can be added via skills:

| Channel | Skill | Status |
|---------|-------|--------|
| WhatsApp | built-in | Default |
| Telegram | `/add-telegram` | Installable |
| Gmail | `/add-gmail` | Installable |
| X (Twitter) | `/x-integration` | Installable |

---

## Security Model

- Containers are isolated via Docker/Apple Container with minimal mounts
- Mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) controls filesystem access
- IPC messages are authorized by group identity
- WhatsApp auth stored locally (never sent to Anthropic)
- Bash environment sanitized before subprocess calls inside containers

See [docs/SECURITY.md](./SECURITY.md) for the full security model.
