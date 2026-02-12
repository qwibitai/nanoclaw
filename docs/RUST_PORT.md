# NanoClaw Rust Port Plan (Embedded-First)

## Scope and Objective
This document defines a practical migration from the current Node/TypeScript host to a Rust-first host optimized for constrained devices (low CPU, RAM, storage) with strict security defaults.

Primary goal: improve performance and security per watt without expanding product scope.

Out of scope for this plan:
- New channels or feature-platform expansion.
- Re-architecting user-facing behavior during parity phases.

## Current-State Constraints (as of 2026-02-12)

### Verified constraints that impact embedded readiness
- Host runtime is Node.js + TypeScript with a non-trivial dependency graph.
- Container execution path is effectively Apple Container-first in runtime code.
- Agent container entrypoint recompiles TypeScript (`npx tsc`) on each invocation.
- Message and scheduler orchestration use polling loops (`POLL_INTERVAL=2000ms`, `SCHEDULER_POLL_INTERVAL=60000ms`, IPC poll).
- Default `IDLE_TIMEOUT` and `CONTAINER_TIMEOUT` are both 30 minutes.
- `RegisteredGroup.trigger` exists in storage but message gating uses global `TRIGGER_PATTERN`.
- Credentials are filtered, then written to mounted files (`/workspace/env-dir/env`) visible in container.
- Container outbound network is unrestricted by default.
- Test reliability differs by Node version (CI Node 20; local failures observed on newer runtime).

### Why these are blockers for small devices
- Per-invocation compile and container cold start consume CPU and energy.
- Polling-heavy loops waste cycles at idle.
- Large runtime/dependency footprint increases storage and update cost.
- Broad egress and in-container credential visibility increase blast radius under prompt injection.
- Runtime/docs mismatches increase operational risk and debugging cost.

## Target Architecture: Rust Host

### Design principles
- Single static host binary.
- Security default-deny posture.
- Bounded memory and backpressure at every queue boundary.
- Preserve current behavior first; optimize second.

### Proposed crate layout
- `nanoclaw-core`: domain types, routing rules, trigger policy, authorization rules.
- `nanoclaw-store`: SQLite schema, migrations, typed queries.
- `nanoclaw-queue`: per-group serialized executor + global concurrency gate + retry/backoff.
- `nanoclaw-scheduler`: due-task engine and next-run computation.
- `nanoclaw-sandbox`: container backend abstraction, mount policy, egress policy, secret broker.
- `nanoclaw-channel-whatsapp`: WhatsApp adapter boundary.
- `nanoclaw-host`: binary wiring, config, telemetry, lifecycle management.

### Runtime model
- `tokio` async runtime.
- One actor/task per registered group with bounded mailbox.
- Global semaphore for max concurrent sandboxes.
- Event-driven wakeups where possible (channel events, queue signals) instead of fixed polling.
- Deterministic per-group ordering preserved.

### Sandbox abstraction
Define a backend trait with at least two implementations:
- Apple Container backend (parity path).
- Docker backend (Linux and broader embedded compatibility).

Trait responsibilities:
- Start task process with mount map and policy.
- Stream stdout/stderr and structured status.
- Enforce timeout and kill semantics.
- Apply network egress policy.
- Inject ephemeral credentials without filesystem exposure.

### Data and compatibility
- Keep SQLite file format and schema semantics compatible during parity.
- Keep IPC/tool authorization behavior equivalent.
- Keep group isolation semantics and main-group privilege model equivalent.

## Phased Migration Plan and Milestones

### Phase 0: Lock Behavior with Contract Tests
Goal: freeze current semantics before rewrite.

Deliverables:
- Black-box contract tests for routing, trigger behavior, queue ordering, scheduler due-task behavior, and IPC auth matrix.
- Golden fixtures for DB state transitions.

Exit criteria:
- Contracts pass on current TypeScript host in CI.
- Required behavior gaps documented (including current known mismatches).

Rollback:
- None required; no production-path change.

### Phase 1: Rust Store + Core Policy Libraries
Goal: implement reusable Rust domain and persistence components while TS host remains active.

Deliverables:
- `nanoclaw-core` and `nanoclaw-store` crates.
- Rust migration runner and query layer validated against current DB.
- Cross-check tool comparing TS and Rust query outputs on same fixture DB.

Exit criteria:
- Query parity for critical read/write paths.
- Migration integrity checks pass.

Rollback:
- Keep TS DB path as source of truth.

### Phase 2: Rust Queue + Scheduler (Shadow Mode)
Goal: run Rust queue/scheduler logic in shadow mode without sending user-visible outputs.

Deliverables:
- `nanoclaw-queue` and `nanoclaw-scheduler` crates.
- Shadow execution logs: expected dispatches vs TS dispatches.
- Drift report tooling.

Exit criteria:
- Dispatch parity above threshold for representative traffic windows.
- No unbounded queue growth under load tests.

Rollback:
- Disable shadow process; TS remains active path.

### Phase 3: Rust Host with Existing TS In-Container Runner
Goal: switch orchestrator to Rust while minimizing sandbox behavior change.

Deliverables:
- `nanoclaw-host` orchestrating channels, queue, scheduler, DB, and sandbox invocation.
- Adapter to run existing runner payload in container.
- Feature flag to switch host between TS and Rust.

Exit criteria:
- End-to-end parity tests pass.
- Staged canary groups complete without regression.

Rollback:
- Flip host feature flag back to TS.

### Phase 4: Replace Execution Layer + Remove Per-Run Compile
Goal: eliminate per-invocation TypeScript compile and support backend portability.

Deliverables:
- Finalized `nanoclaw-sandbox` API.
- Apple Container and Docker backends.
- Prebuilt runner artifacts or native runner path (no runtime `tsc`).

Exit criteria:
- Cold-start and first-token latency targets met.
- Docker backend validated on Linux target hardware.

Rollback:
- Keep old runner path behind compatibility flag until stable.

### Phase 5: Security Hardening Default-On
Goal: enforce strict secrets and egress model by default.

Deliverables:
- Secret broker (ephemeral injection, no mounted secret files).
- Default egress deny with allowlist/proxy.
- Structured audit logs for denied operations and policy decisions.

Exit criteria:
- Security checklist complete.
- Negative tests confirm expected denials.

Rollback:
- Temporary compatibility mode with explicit warning and TTL.

### Phase 6: Embedded Optimization + Cutover
Goal: finalize tuning and declare Rust host as default.

Deliverables:
- Embedded default profile (timeouts, concurrency, buffer caps).
- Performance report on target devices.
- Operational runbook for upgrades/rollback.

Exit criteria:
- Acceptance criteria met (functional, security, performance).
- Rust host set as default path.

Rollback:
- One-command fallback to previous stable host package.

## Security Hardening Checklist

### Credentials
- [ ] Remove secret file mounts from sandbox.
- [ ] Use short-lived credential tokens or brokered one-shot injection per run.
- [ ] Keep secrets in host memory only; zeroize buffers after use where practical.
- [ ] Never expose auth values in logs, traces, panic messages, or task result blobs.
- [ ] Add tests that attempt in-sandbox credential reads and assert denial.

### Egress controls
- [ ] Default outbound policy is deny.
- [ ] Support allowlist by host/domain/IP + port.
- [ ] Support explicit proxy mode for all outbound traffic.
- [ ] Record audit events for denied egress attempts.
- [ ] Make policy override explicit, time-bounded, and logged.

### Sandbox and policy
- [ ] Enforce read-only mounts by default for non-main groups.
- [ ] Validate mount paths after symlink resolution.
- [ ] Reject relative traversal and ambiguous container target paths.
- [ ] Keep container user non-root and filesystem permissions minimal.
- [ ] Enforce per-task CPU/memory/time limits at runtime backend level.
- [ ] Ensure IPC auth matrix parity with explicit deny-by-default rules.

### Supply chain and binary security
- [ ] Pin container base images and verify digests in CI.
- [ ] Use `cargo audit`/`cargo deny` in CI.
- [ ] Enable reproducible build settings where feasible.
- [ ] Sign release artifacts and publish checksums.

## Performance Tuning Guidance for Constrained Hardware

### Build and binary profile
- Compile with `--release`, `lto = "thin"`, `codegen-units = 1`, `panic = "abort"` (for release profile).
- Prefer `rusqlite` for minimal dependency/runtime overhead unless async DB contention proves material.
- Strip symbols in release artifacts intended for device deployment.

### Runtime defaults (embedded profile)
- Reduce global container concurrency default (example: `max_concurrent = min(2, logical_cores - 1)`, floor 1).
- Reduce idle/container timeouts from 30 minutes to workload-appropriate values.
- Bound all in-memory queues; reject or defer beyond hard limits.
- Bound stdout/stderr capture and task result size with truncation markers.
- Use event-driven signaling over fixed polling where possible.

### SQLite tuning
- Enable WAL mode.
- Set `synchronous = NORMAL` (or stricter when required).
- Configure `busy_timeout` to avoid spin retries.
- Add/verify indexes for due-task lookup and recent-message scans.
- Run `PRAGMA optimize` on controlled cadence.

### Container startup optimization
- Remove runtime compilation path entirely.
- Use prebuilt runner artifacts and cache-friendly container layers.
- Consider optional warm pool of paused runner contexts only if memory budget permits.
- Keep mount count and mount metadata small and deterministic.

### Power-aware operations
- Coalesce non-urgent work when device is thermally constrained.
- Prefer backoff with jitter over tight retry loops.
- Keep logging level conservative in steady state.

## Verification and Benchmark Plan

### Functional verification
- Contract suite for:
  - Message routing and trigger semantics.
  - Per-group serialization and retry behavior.
  - Scheduler due-task execution and next-run computation.
  - IPC auth matrix (main vs non-main permissions).
- Cross-implementation replay harness: run same recorded message/task timeline against TS and Rust, then diff outputs and DB state.

### Security verification
- Mount traversal and symlink attack tests.
- Credential exfiltration tests from sandbox.
- Egress policy deny/allow tests.
- Fuzzing for IPC command parser and policy evaluator.

### Performance benchmark matrix
Run on at least:
- Apple Silicon laptop baseline.
- Linux ARM target (example: 4-core ARM, 4 GB RAM).

Scenarios:
- Cold start to first streamed token.
- Warm task latency.
- Burst dispatch across multiple groups.
- Idle power/CPU draw.
- Long-run stability (24h+) with scheduled tasks.

Metrics to collect:
- p50/p95/p99 task latency.
- CPU time per completed task.
- RSS and peak memory.
- Container startup time.
- Task throughput under bounded concurrency.
- Denied policy events and false-positive/false-negative rate.

### Acceptance criteria (Rust embedded milestone)
- Functional parity: contract tests pass with no P0 behavior regressions.
- Security: secrets are not filesystem-visible in sandbox by default; egress deny-by-default enforced.
- Performance:
  - Cold start latency improved by >= 40% vs current TS baseline on same hardware.
  - Steady-state CPU time per task improved by >= 25%.
  - Host RSS stays within configured embedded budget (define per target; recommended initial budget <= 120 MB).
- Reliability: 24h soak test passes without crash, deadlock, or unbounded queue growth.

## Risks and Fallback Strategy

### Key risks
- WhatsApp integration parity risk if channel behavior diverges.
- Container backend parity risk across Apple Container and Docker semantics.
- Hidden behavior coupling in current polling loops and cursor advancement.
- Security regressions during transition from mounted secrets to brokered secrets.
- Benchmark variance across hardware causing misleading optimization conclusions.

### Mitigations
- Keep behavior contract tests as release gates.
- Use feature flags for each major subsystem cutover.
- Canary rollout per group before global switch.
- Keep deterministic structured logs for incident replay.
- Freeze schema changes during high-risk migration phases.

### Fallback/rollback plan
- Maintain dual-host capability during migration window:
  - `host_impl = ts | rust` runtime selection.
- Maintain sandbox compatibility mode only as temporary escape hatch.
- On regression:
  1. Flip host to previous stable implementation.
  2. Preserve DB and message cursors; do not destructive-migrate.
  3. Export incident bundle (logs, config, benchmark snapshot).
  4. Patch forward and re-run parity and soak gates before re-enable.

## Delivery Checklist
- [ ] `docs/RUST_PORT.md` reviewed and approved.
- [ ] Contract test plan committed.
- [ ] Benchmark harness and baseline results committed.
- [ ] Security hardening tasks tracked with owners and target dates.
- [ ] Cutover and rollback runbooks validated in staging.
