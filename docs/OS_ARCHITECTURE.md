# NanoClaw OS — Architecture

## System Overview

NanoClaw is a single Node.js process that orchestrates multi-product company operations through governance-controlled AI agents running in isolated containers.

```
WhatsApp ─→ Host Process ─→ Container VM (agent)
             │                  │
             ├─ SQLite DB       ├─ Claude Agent SDK
             ├─ IPC Watcher     ├─ MCP Tools (gov + ext)
             ├─ Gov Loop        └─ Per-group CLAUDE.md
             └─ Ext Broker
```

## Database Schema

Single SQLite file at `store/messages.db`. Seven governance tables:

| Table | Purpose |
|-------|---------|
| `products` | Product registry (id, name, status, risk_level) |
| `gov_tasks` | Task lifecycle (state machine, optimistic locking via version) |
| `gov_activities` | Append-only audit log (transitions, approvals, evidence) |
| `gov_approvals` | Gate approvals (UNIQUE per task_id + gate_type) |
| `gov_dispatches` | Dispatch tracking (UNIQUE dispatch_key for idempotency) |
| `ext_capabilities` | Per-group provider access (L0-L3, deny-wins) |
| `ext_calls` | External call audit trail (HMAC params, status, product scoping) |

## Governance Kernel

**State Machine:** INBOX → TRIAGED → READY → DOING → REVIEW → APPROVAL → DONE (+ BLOCKED from any state)

**Key invariants:**
- Optimistic locking: `updateGovTask(id, expectedVersion, updates)` — prevents stale writes
- Idempotent dispatch: `tryCreateDispatch()` with UNIQUE(dispatch_key) — crash-safe
- Separation of powers: approver != executor (`checkApproverNotExecutor()`)
- Strict mode (`GOV_STRICT=1`): requires review summary for DOING→REVIEW

**Dispatch Loop** (`gov-loop.ts`):
1. READY + assigned_group → DOING (developer container)
2. REVIEW + gate != None → APPROVAL (gate approver container)

## External Access Broker

Host-side broker executes external API calls on behalf of containers. Containers never hold secrets.

**Access Levels:**
- L0: No access (default)
- L1: Read-only
- L2: Write (7-day auto-expiry)
- L3: Deploy/merge (7-day auto-expiry, two-man rule)

**Security:** HMAC-SHA256 params hashing, request signing, deny-wins precedence, backpressure, inflight lock, idempotency key.

## IPC Layer

File-based IPC between host and containers:
- `data/ipc/{group}/tasks/` — container→host requests
- `data/ipc/{group}/responses/` — host→container responses (atomic tmp+rename)
- `data/ipc/{group}/.ipc_secret` — per-group HMAC key

## Container Runtime

Apple Container Linux VMs with isolated filesystems:
- Read-only code mount
- Per-group writable data mount
- Session persistence in `groups/{name}/`
- No network access to host secrets

## Agent Roles

| Role | Group | Capabilities |
|------|-------|-------------|
| Main | `main` | Full governance control, all ext access, product management |
| Developer | `developer` | Execute assigned tasks, L1-L2 ext access (product-scoped) |
| Security | `security` | Gate approvals, read-only ext access |
