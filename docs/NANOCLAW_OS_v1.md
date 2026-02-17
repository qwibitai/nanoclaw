# NanoClaw OS v1.0

> One process. One database. One human. Governance that doesn't sleep.

---

## 0. What This Is

NanoClaw is the **permanent Operating System** of the startup. Not a tool, not a framework — the substrate on which everything runs.

It replaces Mission Control (OpenClaw/Convex) as the source of truth for governance, agent orchestration, and external access control.

**Design constraint:** a solo founder must be able to sleep while agents execute, review, and gate-keep each other — with full audit trail and zero trust between containers.

---

## 1. Principles (Non-Negotiable)

1. **Fail-closed.** No capability = denied. No approval = blocked. No evidence = no DONE.
2. **Separation of powers.** The agent who writes cannot approve. The agent who approves cannot merge.
3. **Disk is memory.** Sessions, transcripts, decisions — if it's not written, it didn't happen.
4. **Containers are the trust boundary.** Agents see only what is mounted. Bash runs inside the VM, not on the host. Secrets never enter the container.
5. **Idempotency everywhere.** Dispatch is crash-safe. External calls are deduplicated. State transitions use optimistic locking.
6. **Three agents, not ten.** main (coordinator), developer (executor), security (gatekeeper). Specialize later, govern now.

---

## 2. Architecture

```
Host (single Node.js process)
├── Orchestration Kernel
│   ├── State Machine (INBOX → TRIAGED → READY → DOING → REVIEW → APPROVAL → DONE)
│   ├── Gate Enforcement (Security → security, RevOps/Claims/Product → main)
│   ├── Dispatch Loop (idempotent, crash-safe, optimistic locking)
│   └── Audit Trail (gov_activities — append-only)
├── External Access Broker
│   ├── Capability Model (L0–L3, per-group, deny-wins, auto-expire)
│   ├── HMAC Request Signing (per-group .ipc_secret)
│   ├── Two-Man Rule (L3 requires 2+ approvals from different groups)
│   └── Inflight Lock + Backpressure
├── IPC Layer (file-based, atomic writes, per-group namespace)
└── Container Runtime (Apple Container Linux VMs)
    ├── Per-group mounts (/workspace/group, /workspace/ipc)
    ├── Session persistence (Claude Code SDK, auto-memory)
    ├── Conversation archive (PreCompact hook → conversations/)
    └── MCP Tools (gov_*, ext_*, send_message, schedule_task)
```

**Database:** SQLite (single file, WAL mode, no external dependencies).

---

## 3. Agents

| Agent | Folder | Can Create | Can Execute | Can Approve | Ext Access |
|-------|--------|-----------|-------------|-------------|------------|
| **main** (Flux, COO) | `main` | Yes | Yes | Any gate | L1–L3 |
| **developer** (Friday) | `developer` | No | Yes | No | L1–L2 |
| **security** (Sentinel) | `security` | No | No | Security gate | L1 |

**Cross-agent context:** dispatch prompts include the full activity log, gate approvals, and ext_call summary from prior agents. The receiving agent knows what happened before it.

**Memory layers:**
- Session resume (SQLite → SDK `resume` option)
- Conversation archive (PreCompact → `conversations/*.md`)
- CLAUDE.md + USER.md (always loaded)
- Auto-memory (SDK persists preferences in `.claude/`)

---

## 4. Governance

### Task States
```
INBOX → TRIAGED → READY → DOING → REVIEW → APPROVAL → DONE
                                ↘ BLOCKED (from any state)
                    REVIEW ← DOING (rework)
              REVIEW ← APPROVAL (changes requested)
```

### Gates
- **Security** → approved by `security` group (stop-the-line authority)
- **RevOps / Claims / Product** → approved by `main` (founder delegates)

### Rules
- Approver != executor (enforced by system)
- DONE requires: gate approved (or overridden), DoD complete, docs updated (for SECURITY/FEATURE)
- Override: main only, creates P0 follow-up, requires reason + risk acceptance

### Dispatch
- **READY + assigned_group** → auto-transition to DOING, spawn developer container
- **REVIEW + gate != None** → auto-transition to APPROVAL, spawn approver container
- Idempotent via `UNIQUE(dispatch_key)` — crash-safe, no duplicate execution

---

## 5. External Access

| Level | Name | Description | Expiry |
|-------|------|-------------|--------|
| L0 | None | Default — no access | — |
| L1 | Read | List repos, read issues, query logs | None |
| L2 | Write | Create issues, open PRs, push branches | 7 days |
| L3 | Production | Merge PRs, deploy | 7 days + two-man rule |

**Security model:**
- Host executes, container requests (credentials never enter VM)
- Deny-wins: `denied_actions` checked before `allowed_actions`
- HMAC-SHA256 request signing (per-group secret)
- Inflight lock (one execution per request_id)
- Backpressure (max 5 pending per group, fail-closed)
- Broker coupling: L2+ with `task_id` requires task in DOING/APPROVAL + correct group

**Providers v0:** GitHub (16 actions), Cloud Logs (3 actions).

---

## 6. What Stays vs What Changes

| Permanent | Variable |
|-----------|----------|
| State machine + gates | Number of agent groups |
| Audit trail | Product-specific pods |
| Capability model | Provider integrations |
| Separation of powers | Cadence intensity |
| Fail-closed defaults | WIP limits |

---

## 7. What's Not Here (Yet)

- **Memory embedding guard** (L0–L3 classification + PII sanitization) — Milestone 2
- **Model escalation policy** (cost/balanced/frontier tiers) — when multi-model matters
- **Specialist agents** (RevOps, QA, Research, Design, etc.) — when the product demands it
- **Real-time UI** — governance correctness > dashboard

None of these block v1. The OS works without them.

---

## 8. Migration from Mission Control

| Mission Control | NanoClaw | Status |
|----------------|----------|--------|
| Convex (cloud, real-time) | SQLite (local, single-file) | Migrated |
| 10 agent roles | 3 core agents | Sufficient |
| HTTP API | File-based IPC | Migrated |
| Heartbeat polling | Dispatch loop (10s) | Migrated |
| Memory embedding | Not yet | Milestone 2 |
| OpenClaw process isolation | Apple Container VMs | Upgraded |

**Convex stays available** for external UI if needed. NanoClaw is the source of truth.

---

*316 tests. 0 failures. Governance that runs while you sleep.*
