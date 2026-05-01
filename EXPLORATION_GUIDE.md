# NanoClaw Exploration Guide

A structured study path for understanding the NanoClaw codebase from scratch. Follow the phases in order — each one builds on the last.

---

## The Core Insight

> **Everything is a message, and the two session DBs are the only IO surface.**

The host and the container never talk directly. The host writes to `inbound.db`, the container reads it and writes back to `outbound.db`, and the host reads that and delivers. This single design decision shapes the entire system.

---

## Phase 1 — Mental Model

Read these before touching any code. They give you the architecture at a high level.

1. `docs/architecture.md` — full system writeup
2. `docs/architecture-diagram.md` — visual map
3. `CLAUDE.md` — Quick Context and Entity Model sections

**Goal:** Be able to draw the end-to-end flow on paper:

```
message arrives → adapter → router → inbound.db → container wakes
    → agent runs → outbound.db → delivery poll → adapter → delivered
```

---

## Phase 2 — The Entity Model

Understanding the data model unlocks everything else in the system.

1. `docs/db.md` — three-DB overview (central + two per-session DBs)
2. `docs/db-central.md` — the central `v2.db`: users, groups, sessions, wiring
3. `docs/db-session.md` — the per-session `inbound.db` / `outbound.db` schemas
4. `src/db/` — browse the actual table definitions and migrations

**Goal:** Know what a `session`, `agent_group`, `messaging_group`, and `user` are and how they relate to each other.

Key entities:

| Entity | What it represents |
|--------|--------------------|
| `users` | A person on a platform, identified as `<channel>:<handle>` |
| `messaging_groups` | One chat/channel on one platform |
| `agent_groups` | A configured Claude agent (workspace, memory, personality) |
| `sessions` | One active container: `agent_group + messaging_group + thread` |

---

## Phase 3 — The Host Process

The host is a single Node process. Read these files in order — each one calls the next.

| File | What it does |
|------|-------------|
| `src/index.ts` | Boot sequence: init DB, load channel adapters, start delivery polls, start sweep |
| `src/router.ts` | Inbound routing: messaging group → agent group → session → writes to `inbound.db` |
| `src/session-manager.ts` | Resolves or creates sessions; opens `inbound.db` and `outbound.db` |
| `src/container-runner.ts` | Spawns a Docker/Apple container per session with the session DBs mounted |
| `src/delivery.ts` | Polls `outbound.db`, delivers the agent's response back via the channel adapter |
| `src/host-sweep.ts` | 60s background sweep: stale session detection, scheduled message wake-ups |

**Goal:** Trace one message from arrival to delivery by reading the actual source.

---

## Phase 4 — The Container / Agent Runner

The agent runs inside a container on **Bun** (separate runtime from the Node host).

1. `docs/agent-runner-details.md` — agent-runner internals overview
2. `container/agent-runner/src/` — the poll loop, Claude API call, MCP tools, response formatter
3. `docs/build-and-runtime.md` — why the Node/Bun split exists and what it means for builds

**Goal:** Understand what runs inside the container on each wake-up, and how it communicates results back.

Key flow inside the container:

```
poll inbound.db → format messages → call Claude API → write to outbound.db → sleep
```

---

## Phase 5 — Channels, Skills, and Extensibility

Once you understand the core loop, explore how the system is extended.

1. `src/channels/` — the channel adapter interface (how a new platform plugs in)
2. `container/skills/` — skills that run inside every agent session at runtime
3. `docs/isolation-model.md` — the three channel isolation levels (`agent-shared`, `shared`, separate)
4. `CONTRIBUTING.md` — the four skill types and how they're structured
5. `src/modules/` — approvals, permissions, self-modification

---

## Key Files at a Glance

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point |
| `src/router.ts` | Inbound routing |
| `src/delivery.ts` | Outbound delivery |
| `src/session-manager.ts` | Session lifecycle |
| `src/container-runner.ts` | Container spawning |
| `src/host-sweep.ts` | Background sweep |
| `src/command-gate.ts` | Admin command gate |
| `src/db/` | All DB access (central DB) |
| `src/channels/` | Channel adapter registry |
| `src/modules/permissions/access.ts` | Access control |
| `src/modules/approvals/primitive.ts` | Approval routing |
| `container/agent-runner/src/` | Agent-runner (Bun) |
| `container/skills/` | Container-side skills |
| `groups/<folder>/` | Per-agent-group filesystem |

---

## Docs Index

| Doc | Purpose |
|-----|---------|
| `docs/architecture.md` | Full architecture writeup |
| `docs/api-details.md` | Host API + DB schema details |
| `docs/db.md` | Three-DB model overview |
| `docs/db-central.md` | Central DB tables + migration system |
| `docs/db-session.md` | Per-session inbound/outbound schemas |
| `docs/agent-runner-details.md` | Agent-runner internals + MCP tool interface |
| `docs/isolation-model.md` | Three-level channel isolation model |
| `docs/build-and-runtime.md` | Node host + Bun container split, CI, invariants |
| `docs/setup-wiring.md` | Setup flow wiring |

---

## Suggested Reading Order (TL;DR)

```
CLAUDE.md (Quick Context only)
  → docs/architecture.md
  → docs/db.md + docs/db-central.md + docs/db-session.md
  → src/index.ts → src/router.ts → src/session-manager.ts
     → src/container-runner.ts → src/delivery.ts
  → docs/agent-runner-details.md → container/agent-runner/src/
  → docs/isolation-model.md → src/channels/ → CONTRIBUTING.md
```
