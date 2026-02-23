# NanoClaw — Documentation Index

> **Primary AI context source.** When working on NanoClaw features, start here to locate the right reference document.

**Generated:** 2026-02-23
**Version:** 1.1.0
**Repository type:** Multi-part (orchestrator + agent-runner)

---

## Project Overview

- **Type:** Multi-part backend
- **Primary Language:** TypeScript (Node.js 22)
- **Architecture:** Event-driven polling pipeline (WhatsApp → SQLite → poll loop → Docker container → response)
- **Parts:**
  - **orchestrator** — Main host process (`src/`)
  - **agent-runner** — Claude agent inside container (`container/agent-runner/`)

---

## Quick Reference

### Orchestrator (`src/`)
- **Entry point:** `src/index.ts`
- **Tech stack:** Node.js 22, Baileys (WhatsApp), better-sqlite3, pino
- **Service:** launchd (macOS) / systemd (Linux)

### Agent Runner (`container/agent-runner/`)
- **Entry point:** `container/agent-runner/src/index.ts`
- **Tech stack:** Claude Agent SDK, MCP, Node.js 22 in Docker/Apple Container
- **Image:** `nanoclaw-agent:latest`

---

## Generated Documentation

### Core

| Document | Description |
|----------|-------------|
| [Project Overview](./project-overview.md) | Purpose, capabilities, architecture summary |
| [Source Tree Analysis](./source-tree-analysis.md) | Annotated directory tree, entry points, integration map |
| [Integration Architecture](./integration-architecture.md) | How orchestrator and agent-runner communicate |

### Per-Part Architecture

| Document | Description |
|----------|-------------|
| [Architecture — Orchestrator](./architecture-orchestrator.md) | Full orchestrator design, modules, patterns |
| [Architecture — Agent Runner](./architecture-agent-runner.md) | Container agent design, SDK integration, MCP tools |

### API & Data

| Document | Description |
|----------|-------------|
| [API Contracts — Orchestrator](./api-contracts-orchestrator.md) | Container I/O protocol, IPC filesystem protocol, MCP tool schemas |
| [Data Models](./data-models.md) | SQLite schema — all 7 tables, indexes, migrations |

### Development & Operations

| Document | Description |
|----------|-------------|
| [Development Guide](./development-guide.md) | Local setup, hot reload, testing, common tasks |
| [Deployment Guide](./deployment-guide.md) | Service management, container runtime, environment config |

---

## Existing Documentation

| Document | Description |
|----------|-------------|
| [REQUIREMENTS.md](./REQUIREMENTS.md) | Philosophy, architecture decisions, integration points |
| [SECURITY.md](./SECURITY.md) | Security model and threat considerations |
| [SPEC.md](./SPEC.md) | Detailed functional specification |
| [DEBUG_CHECKLIST.md](./DEBUG_CHECKLIST.md) | Debugging checklist for common issues |
| [APPLE-CONTAINER-NETWORKING.md](./APPLE-CONTAINER-NETWORKING.md) | Apple Container networking specifics |
| [nanoclaw-architecture-final.md](./nanoclaw-architecture-final.md) | Earlier architecture reference |
| [nanorepo-architecture.md](./nanorepo-architecture.md) | Repo structure notes |
| [SDK_DEEP_DIVE.md](./SDK_DEEP_DIVE.md) | Claude Agent SDK deep dive notes |

---

## Reference Material

| Document | Description |
|----------|-------------|
| [references/researchs/nanoclaw-technical-handoff-report.md](./references/researchs/nanoclaw-technical-handoff-report.md) | Technical handoff report |
| [references/researchs/nanoclaw-memory-design.md](./references/researchs/nanoclaw-memory-design.md) | Memory system design research |
| [references/openclaw-memory/](./references/openclaw-memory/) | OpenClaw memory system reference |

---

## Getting Started

### First-time setup

```bash
npm install                      # Install dependencies
cp .env.example .env             # Configure API key
npm run auth                     # WhatsApp authentication
./container/build.sh             # Build agent container
npm run setup                    # Interactive setup wizard
```

### Development

```bash
npm run dev          # Run orchestrator with hot reload
npm run typecheck    # TypeScript check (no output)
npm test             # Vitest unit tests
```

### Service management

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw    # Restart
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist  # Stop

# Linux
systemctl --user restart nanoclaw
systemctl --user status nanoclaw
```

### Key Claude Code skills

| Skill | Purpose |
|-------|---------|
| `/setup` | First-time installation and configuration |
| `/debug` | Troubleshoot container and service issues |
| `/update` | Pull upstream changes, run migrations |
| `/customize` | Add channels and integrations |

---

## Navigation by Task

| Task | Start here |
|------|-----------|
| Understand how messages are processed | [architecture-orchestrator.md](./architecture-orchestrator.md) → `src/index.ts` |
| Add a new MCP tool | [api-contracts-orchestrator.md](./api-contracts-orchestrator.md) + [architecture-agent-runner.md](./architecture-agent-runner.md) |
| Understand the database schema | [data-models.md](./data-models.md) |
| Debug a container issue | [DEBUG_CHECKLIST.md](./DEBUG_CHECKLIST.md) + `/debug` skill |
| Set up scheduled tasks | [api-contracts-orchestrator.md](./api-contracts-orchestrator.md) → `schedule_task` |
| Add a new channel | `/customize` skill |
| Understand IPC flow | [integration-architecture.md](./integration-architecture.md) |
| Configure mount security | [deployment-guide.md](./deployment-guide.md) → Mount allowlist |
| Deploy to a new machine | [deployment-guide.md](./deployment-guide.md) |
