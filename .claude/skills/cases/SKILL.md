---
name: cases
description: Case management system for NanoClaw. Routes messages to isolated work items, tracks cost/time, supports kaizen feedback loop. Triggers on "cases", "case management", "work items", "workstream".
---

# Cases — Isolated Work Item Management for NanoClaw

Cases are discrete units of work, each with its own container, session, and (for dev cases) git worktree. Every case is like an employee at their own desk with one focus and one short-term memory.

## Concepts

### Case Types
- **work** — Using existing tooling to do useful work (research, analysis, writing, API calls). Gets a scratch directory.
- **dev** — Improving the tooling, harnesses, and workflows to make future work cases resolve faster with higher quality. Gets a git worktree.

### Case Lifecycle
```
SUGGESTED ──→ BACKLOG ──→ ACTIVE ──→ DONE ──→ REVIEWED ──→ PRUNED
    │                        │  ▲
    └─ (rejected)            ▼  │
                          BLOCKED
```

- **SUGGESTED** — Dev case proposed by an agent (from kaizen reflection or work case friction). Awaits user approval.
- **BACKLOG** — Approved but not yet started. Workspace created. Picked up when a slot opens.
- **ACTIVE** — Container assigned, agent working on it.
- **BLOCKED** — Waiting on user input, external dependency, or another case. Time tracking paused.
- **DONE** — Agent completed work, wrote conclusion + kaizen reflections. Awaiting user review.
- **REVIEWED** — User confirmed completion. Workspace can be pruned.
- **PRUNED** — Heavy files deleted, metadata preserved forever (cost, time, conclusion, commits).

### Kaizen Feedback Loop
When an agent marks a case as done, it must reflect on:
- Bugs, impediments, inefficiencies encountered
- What improvements would help: QoL features, bug fixes, cached knowledge, hooks, gates/reviews

Each reflection becomes a SUGGESTED dev case. Successful cases with user friction also generate suggestions. This creates a continuous improvement cycle: work cases → dev suggestions → better tooling → better work cases.

### Haiku Message Router
When a group has 2+ active cases, incoming messages are classified by Claude Haiku (fast, cheap ~$0.001/call) to determine which case they belong to. If no match, the user is asked whether to create a new case. Single active case = auto-route. Zero cases = normal processing.

### Case Naming
Cases are named with date-time prefix: `YYMMDD-HHMM-kebab-description`
Example: `260315-1430-fix-auth-flow`

### Telegram Integration
All agent replies in Telegram are prefixed with `[case: name]` so the user can track which case each message belongs to across interleaved conversations.

## What Was Added

### New Files
- `src/cases.ts` — Case model, DB operations, workspace management (worktrees + scratch dirs), lifecycle helpers, snapshot writing
- `src/case-router.ts` — Haiku-based message routing to cases

### Modified Files
- `src/db.ts` — Cases table schema (auto-created via `createCasesSchema`)
- `src/index.ts` — Case routing in message flow, case-aware session keys, case status command, time tracking per case
- `src/container-runner.ts` — Case workspace mounts (`/workspace/case`), case env vars (`NANOCLAW_CASE_ID/NAME/TYPE`)
- `src/ipc.ts` — Case lifecycle IPC handlers (mark_done, mark_blocked, mark_active, update_activity, suggest_dev)
- `container/agent-runner/src/ipc-mcp-stdio.ts` — Agent MCP tools (list_cases, case_mark_done with kaizen, case_mark_blocked, case_mark_active, case_suggest_dev)

### Database
- New `cases` table with full lifecycle metadata (auto-created on first run, no manual migration needed)

### Cost Tracking
Time per case is tracked automatically (wall-clock duration of each agent invocation). For detailed API cost tracking per case (per-model breakdown, input/output tokens), merge the `skill/usage-tracking` branch alongside this one — it integrates with cases via `addCaseCost()`.

### Container Environment
When a container runs in case context:
- `NANOCLAW_CASE_ID` — The case ID
- `NANOCLAW_CASE_NAME` — Human-readable case name
- `NANOCLAW_CASE_TYPE` — `dev` or `work`
- `/workspace/case` — The case's workspace (worktree or scratch dir)
- `active_cases.json` — Snapshot of all active cases in the IPC directory

## User Commands (in chat)
- `status` / `cases` / `tasks` — Show all active cases with status, cost, time, last message
- Reply to case routing prompt to create new cases or specify target

## Agent MCP Tools
- `list_cases` — View active cases
- `case_mark_done` — Complete a case with conclusion + kaizen reflections
- `case_mark_blocked` — Mark blocked with reason
- `case_mark_active` — Resume a blocked case
- `case_suggest_dev` — Suggest a tooling improvement from any case

## Configuration
No additional configuration needed. Cases use the existing `MAX_CONCURRENT_CONTAINERS` limit. The Haiku router uses the host's `ANTHROPIC_API_KEY` directly.
