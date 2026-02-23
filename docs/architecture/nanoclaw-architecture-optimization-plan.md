# NanoClaw Architecture Optimization Plan (Apple Container First)

Last updated: 2026-02-23

## Purpose

This document captures a full-architecture optimization audit for NanoClaw, with Apple Container as the primary runtime target. It summarizes strengths, prioritizes weaknesses as `P0`/`P1`/`P2`, and explains the expected system benefit of each fix.

## Scope

- Runtime and orchestration: `src/index.ts`, `src/group-queue.ts`, `src/task-scheduler.ts`, `src/container-runner.ts`, `src/container-runtime.ts`
- Security and isolation: `src/mount-security.ts`, `src/env.ts`, `docs/reference/SECURITY.md`
- Messaging/data: `src/channels/whatsapp.ts`, `src/db.ts`
- Agent/worker runtimes: `container/agent-runner/src/index.ts`, `container/worker/runner/src/index.ts`
- Testing and policy enforcement: `vitest.config.ts`, `container/rules/*.md`, `docs/operations/roles-classification.md`

## Current Strengths

1. Strong group-isolation by mount design and per-group session/IPC directories.
2. External mount allowlist with realpath validation and blocked sensitive patterns.
3. Robust container lifecycle controls (startup check, orphan cleanup, timeout and stop verification).
4. Clear queue and scheduler architecture with centralized container concurrency control.
5. Deterministic container output streaming contract with markers and bounded logs.
6. Good host-side unit test baseline with broad coverage across core modules.

## Prioritized Optimization Backlog

| Priority | Status | Item | Why it matters | Key evidence | Expected benefit |
|---|---|---|---|---|---|
| P0 | Pending | Restrict secret exposure by role (remove `GITHUB_TOKEN` from untrusted non-worker groups; sanitize all git tokens in Bash hooks) | Current trust model marks non-main as untrusted but token scope remains broad; combined with bypass permissions this increases exfiltration risk | `docs/reference/SECURITY.md`, `src/container-runner.ts:475`, `container/agent-runner/src/index.ts:197`, `container/agent-runner/src/index.ts:456` | Major reduction in account/repo compromise blast radius |
| P0 | Completed (2026-02-23) | Replace timestamp-only cursor semantics with a monotonic ingest sequence cursor | `timestamp > cursor` with second-level message timestamps can drop same-second arrivals | `src/db.ts:326`, `src/db.ts:355`, `src/index.ts:58`, `src/index.ts:448` | Eliminates silent message loss, improves correctness |
| P1 | Completed (2026-02-23) | Replace retry-drop behavior with durable retry/dead-letter flow | After max retries, pending work can be dropped until a new user message arrives | `src/group-queue.ts:16`, `src/group-queue.ts:38`, `src/group-queue.ts:293` | Fewer stuck conversations, lower MTTR |
| P1 | Completed (2026-02-23) | Persist outbound WhatsApp queue across restart | Outbound queue is in-memory only today | `src/channels/whatsapp.ts:23`, `src/channels/whatsapp.ts:45`, `src/channels/whatsapp.ts:318` | Reliable response delivery across crash/reconnect |
| P1 | Pending | Remove always-on permission bypass or gate it by role/task class | Full bypass mode broadens accidental/dangerous tool execution scope | `container/agent-runner/src/index.ts:456` | Better least-privilege and containment |
| P1 | Pending | Narrow main-lane write scope on host mounts | Main lane currently has read-write project-root mount | `src/container-runner.ts:266`, `docs/reference/SECURITY.md:85` | Better host integrity and change safety |
| P1 | Completed (2026-02-23) | Make browser-test evidence enforceable in code contract, not only docs/rules | Current browser gate is largely process/policy-driven | `src/dispatch-validator.ts:95`, `src/dispatch-validator.ts:220`, `src/index.ts:315`, `src/jarvis-worker-dispatch.test.ts:235` | Higher QA reliability, fewer false handoffs |
| P2 | Completed (2026-02-23) | Add explicit container CPU/memory limits (Apple Container run args) | Runaway tasks can degrade host runtime | `src/config.ts:49`, `src/container-runner.ts:480` | Better runtime stability under load |
| P2 | Completed (2026-02-23) | Reduce `getAllTasks()` snapshot overhead per run | Every run writes full task snapshot | `src/index.ts:365`, `src/task-scheduler.ts:70` | Lower startup latency and I/O pressure |
| P2 | Completed (2026-02-23) | Expand automated tests for container-side runtime behavior | Host tests are strong; container runtime paths still need deeper automated coverage | `vitest.config.ts:5`, `container/worker/runner/src/lib.test.ts:1`, `src/container-runner.test.ts:221` | Earlier regression detection, lower production risk |
| P2 | Pending | Harden mount allowlist guardrails against permissive roots | Allowlist misconfiguration can become a high-impact risk | `src/mount-security.ts:282`, `src/mount-security.ts:297` | Improved defense against operator misconfiguration |
| P2 | Pending | Keep security docs and runtime behavior tightly synced | Documentation drift creates operational mistakes | `docs/reference/SECURITY.md`, `docs/operations/roles-classification.md` | Better operator reliability and incident response quality |

## Completion Log

### Completed in this pass (2026-02-23)

1. Monotonic ingest-sequence message cursor migration (`P0`).
2. Durable dead-letter retry flow for message processing (`P1`).
3. Persistent WhatsApp outbound queue with safe replay semantics (`P1`).
4. Explicit container CPU/memory run limits (`P2`).
5. Per-group task snapshot optimization for non-main runs (`P2`).
6. Expanded automated container/runtime test coverage (`P2`).
7. Browser-evidence contract enforcement at parser/validator layer (`P1`).

## Recommended Execution Order

### Phase 1 (Immediate)

1. Secret scope hardening by role and Bash hook token sanitization.
2. Cursor model correction (`ingest_seq` style message cursoring). ✅ Completed (2026-02-23)

### Phase 2 (Reliability)

1. Durable retry + dead-letter strategy for `MAX_RETRIES` exhaustion. ✅ Completed (2026-02-23)
2. Durable outbound message queue with replay on reconnect/restart. ✅ Completed (2026-02-23)

### Phase 3 (Safety + Enforceability)

1. Reduce permission bypass surface.
2. Reduce writable mount scope for main lane.
3. Enforce browser-evidence contract at parser/validator layer. ✅ Completed (2026-02-23)

### Phase 4 (Scale + Operability)

1. Container resource limits. ✅ Completed (2026-02-23)
2. Task snapshot optimization. ✅ Completed (2026-02-23)
3. Expanded test matrix for container-side runtimes. ✅ Completed (2026-02-23)
4. Allowlist guardrail hardening and docs drift checks.

## Success Metrics

- Message-loss incidents: `0` (no dropped same-second messages; no silent cursor skips)
- Retry exhaustion behavior: no silent drops; explicit dead-letter or auto-retry visibility
- Token exposure: non-worker untrusted lanes have no GitHub token access
- Browser QA compliance: UI-impacting runs blocked if evidence contract is missing
- Runtime stability: reduced host contention during parallel container workloads
- Mean time to detect regressions: improved via container-runtime-focused tests

## Notes

- This plan assumes Apple Container remains the default runtime path.
- Docker guidance is fallback only where concepts are runtime-agnostic (resource controls, read-only patterns).
- All changes should preserve current role model (`main`, `andy-developer`, `jarvis-worker-*`) unless explicitly redesigned.
