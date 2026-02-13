# MicroClaw Host Design (Parity + Live-Ready)
Date: 2026-02-13
Status: validated

## Purpose
Define the v1 host architecture for MicroClaw with full NanoClaw core parity and a live‑ready runtime. This host is the primary system of record and must run even when some connectors are unavailable. Configuration uses TOML with environment overrides. Storage is SQLite on disk.

## Scope Decisions
- **Connectors enabled by default:** iMessage, Discord, Telegram, Email.
- **Missing credentials:** warn and skip only that connector; do not fail host boot.
- **Storage:** SQLite file on disk (durable bus + state).
- **Sandbox:** Apple Container + Docker backends with allowlist mounts and deny‑by‑default egress.

## Section 1 — Host Architecture and Boot Flow
`microclaw-host` is a single Rust binary with two modes: daemon (default) and foreground CLI. Both modes share the same pipeline: config -> store -> bus -> router -> scheduler -> sandbox -> connectors. Configuration loads from `config/microclaw.toml`, then applies env overrides (e.g., `MICROCLAW_DB_PATH`, `MICROCLAW_LOG_LEVEL`, `MICROCLAW_CONNECTORS_*`). On boot the host migrates the SQLite schema, opens a durable bus spool, and starts the scheduler loop. The router subscribes to bus events and applies policy: trigger gating, per‑group serialization, and tool routing. All tools execute inside the sandbox backend chosen by config. Connectors start in parallel; missing credentials are logged and skipped. Startup prints a status report (active connectors, skipped connectors, sandbox backend readiness). The host exposes a local control surface (CLI and optional localhost HTTP) for status and health checks.

## Section 2 — Full Parity Scope
“Full parity” targets NanoClaw core behavior:
- Trigger/formatting policy parity (per‑group trigger + formatting)
- Per‑group queue with global concurrency and retry/backoff
- Scheduler recurrence + persistence
- SQLite schema parity for groups/messages/tasks/state
- IPC authorization semantics
- Container sandbox policy (allowlist mounts, deny‑by‑default egress, secrets broker)
- Bus durability + replay + idempotency

Parity is contract‑tested in Rust. The host is considered parity‑complete when these tests pass and `microclaw-host run` boots with a clean status report.

## Section 3 — Data Flow and Error Handling
Inbound events from connectors normalize into a single Envelope and enter the bus. The router applies policy and emits actions (run tool, schedule task, or reply). The scheduler publishes due tasks back into the bus. Connector loops are isolated: failures back off and do not crash the host. Missing credentials only disable the affected connector. Sandbox backend failures are hard errors; the host must not run tools without isolation. Schema or migration errors also fail fast. Egress is denied by default unless explicitly allow‑listed. Queue overflow is bounded (drop oldest per‑group with warning, configurable).

Logs are structured (JSON), and policy/tool decisions are persisted to an audit table in SQLite. `microclaw-host status` reports queue depths, connector status, and last error per connector.

## Section 4 — Testing and Rollout
Contract tests cover parity semantics (trigger, routing, queue ordering, scheduler next‑run, IPC auth). Integration tests cover host boot, migrations, bus replay, and connector gating (warn and continue). A smoke test mode runs a synthetic inbound message through router -> output without real network calls. Rollout is staged: local run, status preflight, then enable connectors. Phase 2 introduces gateway WS bridging, but the host remains the canonical policy executor.

## Next Step
Create an implementation plan and execute via the autonomous plan loop, prioritizing host‑first wiring.
