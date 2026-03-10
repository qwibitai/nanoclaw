# NanoClaw — Multi-Arm Assistant Architecture

## Vision

A personal AI infrastructure that operates across multiple domains — software
development, creative projects, daily life coordination — through a single
unified identity. One agent with many arms, powered by a single NanoClaw
instance accessible over messaging channels (Discord, WhatsApp, etc.).

The system compounds over time: development work improves tools, tool
improvements enable better workflows, accumulated knowledge makes everything
faster and more reliable.

---

## 1. Agent Identity: One Agent, Many Arms

The system should feel like a single intelligent assistant that happens to be
capable of many things. When you switch topics — from code to meals to project
planning — it should feel like the same entity shifting focus.

### Identity architecture

NanoClaw's `groups/global/CLAUDE.md` is mounted read-only into every container.
This is where the unified identity lives. Each group's local CLAUDE.md adds
only task-specific capabilities and data — not a separate personality.

```
groups/
├── global/
│   ├── CLAUDE.md              <- Shared identity (read by ALL groups)
│   ├── knowledge/             <- Shared knowledge files
│   │   ├── decisions.md       <- Major decisions and reasoning
│   │   ├── ideas-backlog.md   <- Ideas mentioned but not acted on
│   │   └── contacts.md        <- People and context
│   └── calendar.json          <- Sanitized schedule for all arms
├── main/
│   └── CLAUDE.md              <- Coordinator capabilities
├── domain_a/
│   └── CLAUDE.md              <- Domain A capabilities only
├── domain_b/
│   └── CLAUDE.md              <- Domain B capabilities only
└── shared_social/
    └── CLAUDE.md              <- Social mode constraints only
```

### Global CLAUDE.md — the soul

Defines core identity, communication style, knowledge about users,
cross-context awareness rules, and a periodically-updated summary of active
work across all domains. Key principles:

- Same voice everywhere: casual, competent, slightly dry
- Direct and efficient, no filler
- Proactive but not presumptuous
- Never shares information across domain boundaries

### Information isolation rules (strict)

**On the private server** (with the owner only): the agent can reference any
domain freely. Full cross-context awareness.

**On shared servers** (with other people): the agent has ZERO awareness of the
private server. It does not reference work from other domains — even vaguely.
As far as anyone on the shared server knows, the agent only does whatever that
server is for. Enforced at the CLAUDE.md level per group:

```markdown
## Absolute Boundaries

You have NO knowledge of any activity on the private server. You do not know
about: code projects, other domains, or any private activity. If asked, you
genuinely do not have access to that information from this context.
```

### Group CLAUDE.md files

Define what each arm CAN DO, not who it IS. Identity comes from global.
Capabilities come from local. The agent is the same entity everywhere, just
with different tools and data available per context — and strict isolation
rules about what it acknowledges per server.

---

## 2. Foundation: Container-Based Isolation on Linux/WSL2

NanoClaw runs on a Linux host (native or WSL2). Each agent group gets its own
Docker container with isolated filesystem, memory, and IPC namespace.

### Key infrastructure choices

- **Docker Engine** natively in WSL2 (not Docker Desktop) for stability
- **Process manager** (pm2 or systemd) for auto-restart and logging
- **Resource budgeting** — allocate CPU/RAM per container type, leave headroom

---

## 3. Multi-Channel Pattern

One bot identity across multiple messaging channels and servers. The agent
uses the same name everywhere, with strict information isolation between
contexts.

### Private server channels (example)

```
#command-center    ->  Coordinator (main group)
                      All human interaction for dev workflows.
                      Trigger: @Agent

#architect         ->  Architect (non-main group)
                      System evolution, infrastructure changes.
                      Trigger: @Agent

#domain-work       ->  Domain Supervisor (non-main group)
                      Domain-specific pipeline status.
```

### Shared server channels (example)

```
#planning          ->  Domain Coordinator (non-main group)
#feedback          ->  Post-activity feedback
#preferences       ->  Members update preferences
#general           ->  Social chat (separate sandboxed group)
```

### Group isolation

Each channel maps to an isolated NanoClaw group with its own container,
filesystem, CLAUDE.md, session persistence, and IPC namespace. Groups cannot
cross-communicate without coordinator mediation.

---

## 4. Memory Hierarchy & Information Flow

### Three tiers

**Tier 1: Global memory** (`groups/global/`)

- Shared identity, communication style, knowledge about users
- Cross-context status summaries (sanitized)
- Calendar/schedule awareness
- Updated by coordinator only

**Tier 2: Domain memory** (each group's folder)

- Task-specific capabilities, instructions, and accumulated knowledge
- Active state (workflows, current plans, progress)
- Updated by each group's container during operation

**Tier 3: Ephemeral context** (container session)

- Current conversation, in-progress reasoning
- Dies with the session, fresh start from Tier 1 + 2

### Cross-domain information flow

```
Global Memory --reads--> All groups
Coordinator --writes--> Global (updates summaries, calendar)
Coordinator --reads--> All group folders (main group privileges)
Group A --CANNOT read--> Group B's folder
Group A --CANNOT write--> Global (read-only mount)
```

The coordinator mediates all cross-domain information:

```
Domain A -> Domain B:  "Bug found in shared tool" -> Coordinator files issue
Domain B -> Global:    "v0.2.3 merged" -> Coordinator updates status
Shared -> Global:      "User preference changed" -> Coordinator updates if confirmed
```

---

## 5. Calendar Integration

### Setup

Google Calendar as the primary, subscribing to other calendar sources
(work calendar via ICS feed, phone sync). One unified calendar the agent
reads via Google Calendar API/MCP.

### Access model

The coordinator gets full read access: event titles, descriptions, attendees,
locations, times. This enables:

- Don't ping during meetings or focus blocks
- Batch non-urgent updates for after busy periods
- Automatically adjust behavior around travel
- Calendar-aware notification timing

### Information sharing

The coordinator writes a sanitized daily schedule to global memory. Other arms
see "user is busy until 3 PM" — not meeting details.

---

## 6. Code Orchestration Supervisor

### Purpose

Manage software development workflows for any GitHub project. Follows a
structured pipeline: shape spec -> implement -> audit -> demo -> walk -> PR.

### Components

**Coordinator container** (persistent, main group)

- All interactive phases (spec shaping, walkthrough) over messaging
- Workflow state management across all projects
- Dispatches autonomous work via IPC to worker manager
- Calendar-aware timing of notifications and requests

**Worker manager** (host-level service, not a NanoClaw group)

- Watches for dispatch files from coordinator's IPC directory
- Spawns the correct CLI per phase (different tools for implementation vs. audit)
- Manages git worktrees for parallel issue work
- Extracts completion signals from status files
- Writes results back to coordinator IPC
- Enforces per-subscription rate limits and concurrency caps

**Workflow monitor** (NanoClaw scheduled task, 60s cron)

- Checks worker status files for completed phases
- Advances workflow state machines
- Dispatches next phases
- Detects staleness and timeouts
- Reports significant events to messaging (calendar-aware timing)

### Workflow state machine

```
idle -> shaping -> await_confirm -> orchestrating -> walking -> pr_review -> completed
                                        |                        |
                                        |  (walk finds issues)   |
                                        +------------------------+
```

Each state persisted in `workflows.json`. Survives container restarts.

### Parallel execution

Git worktrees provide branch isolation per issue. Multiple parallel workers
can run on different issues using different tool subscriptions, avoiding rate
limit conflicts.

### Interactive phases

Spec shaping and walkthrough run inside the coordinator container. The
coordinator reads the command file, follows the steps, uses messaging for Q&A.
User replies pipe through NanoClaw's message loop.

Walkthrough continues through all demo steps on failure (doesn't stop at the
first broken step) so you get the full picture before deciding how to proceed.

---

## 7. Domain-Specific Pipeline Arms

NanoClaw's group architecture naturally supports domain-specific processing
pipelines. Each domain gets its own group with specialized CLAUDE.md,
knowledge base, and tooling.

### Pattern

```
User: "Process item X"

Domain Agent:
  Lookup metadata -> validate -> extract/transform -> process
  "Processing complete. Results ready."

Coordinator: Routes to next step or requests approval

Domain Agent: Post-processing, packaging, delivery

User: Review, provide feedback

Coordinator: Routes feedback to appropriate sub-step
```

### Container lifecycle

Fresh session per work item. No context bleed. But the group folder persists
(knowledge base, project directories, CLAUDE.md memories), so institutional
knowledge accumulates across sessions.

---

## 8. Agent Group Summary

### Coordinator (private server, main group)

**Container:** Persistent, main group
**Responsibilities:** All human interaction, interactive workflows, state
management, dispatch to workers, cross-domain mediation, daily briefings,
digest mode, calendar-aware notification timing

### Architect (private server, non-main)

**Container:** Non-main
**Responsibilities:** System evolution — NanoClaw modifications, agent design,
infrastructure changes. The meta-agent that understands the full system
architecture and can modify it. All infrastructure code changes go through
security audit before merging.

### Domain Arms (private server, non-main)

**Container:** Fresh per work item, non-main
**Responsibilities:** Domain-specific processing pipelines. Group folder
persists across sessions for knowledge accumulation.

### Shared Arms (shared servers, non-main)

**Container:** Non-main, trigger required, heavily sandboxed
**Responsibilities:** Shared activities (meal planning, social, accountability).
Zero awareness of private server activity. Same voice, limited capabilities.

### Worker Manager (host-level, not a NanoClaw group)

**Process:** Standalone service alongside NanoClaw
**Responsibilities:** Dispatch coding workers, manage git worktrees, extract
signals, route to correct CLI/subscription, enforce concurrency and rate limits

---

## 9. Infrastructure Security

### Mandatory security audit for infrastructure changes

Any code change to the following components should receive a security audit
before being applied:

- NanoClaw fork (container-runner, IPC, channels, auth, MCP tools)
- Worker manager (process spawning, credential handling)
- Browser automation (credential storage, session management)
- Any framework touching permissions or file access
- Global/group CLAUDE.md changes that affect capabilities
- Any new NanoClaw skill or MCP tool

### Audit focus areas

- Credential leaks (API keys, OAuth tokens exposed to containers or logs)
- IPC privilege escalation (non-main group writing files that main group executes)
- Container escape vectors (mounts that expose host filesystem beyond intended scope)
- Injection via external input (webhook payloads, messages, issue content used unsafely)
- Path traversal in group folder or worktree management
- Secret exposure in error messages, logs, or status reports

### Audit flow

```
Change proposed
    |
    v
Code written to a branch (not main)
    |
    v
Security audit dispatched (automated or manual)
    |
    v
Audit reports findings
    |
    +-- Clean -> Owner approves -> merge
    |
    +-- Issues found -> address -> re-audit -> repeat
```

No infrastructure code lands on main without passing a security audit.

---

## 10. Supporting Features

All implemented as scheduled tasks or coordinator behaviors.

### Daily briefing (cron)

Coordinator synthesizes overnight activity across all domains into one message.
Calendar-aware — delivered when you're available.

### Digest mode (travel / busy days)

When the calendar shows travel or busy periods, the agent switches to digest
mode: one morning message per day summarizing the last 24 hours. No further
messages unless you reply. Triggered automatically by calendar events or
manually.

### Notification triage (periodic poll)

Coordinator polls GitHub via `gh` CLI. Surfaces important items: CI failures,
community issues, PR status. Presents with recommended actions.

### Calendar-aware notification timing

The coordinator adjusts all agent behavior based on calendar state:

- Don't send interactive requests during meetings
- Batch non-urgent updates for after focus blocks
- Pause interactive work during travel (continue autonomous)
- Adjust notification frequency based on availability
- Trigger digest mode automatically during vacations

---

## 11. Technology Stack

```
Layer              Technology           Purpose
------------------------------------------------------------------
Messaging          Discord.js / etc.    Agent <-> channel communication
Host runtime       Node.js (NanoClaw)   Message routing, scheduling, IPC
Process manager    pm2 / systemd        Auto-restart, logging
Container runtime  Docker (WSL2)        Agent sandboxing
Agent SDK          Anthropic Agent SDK  Claude Code inside containers
Database           SQLite               Messages, sessions, tasks, state
Dev lifecycle      Structured pipeline  Shape -> implement -> audit -> walk
Browser automation Playwright           Web automation tasks
Calendar           Google Calendar API  Schedule awareness (via MCP)
VCS                Git + GitHub         Code hosting, issues, releases
```
