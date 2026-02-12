# NanoClaw Agent Guide: Audit, Gaps, and Rust Port Plan

## Purpose
This file is for engineers/agents working on this repository.
It captures a verified audit of the current system, what is working, what is not, and how to port to a Rust-first architecture optimized for embedded devices (small CPU/RAM/storage) with strong security.

## Audit Snapshot (verified on 2026-02-12)
Commands executed in this workspace:
- `npm ci`
- `npm run typecheck`
- `npm run build`
- `npm test`
- `npm run format:check`

### What this system is
NanoClaw is a single-process Node/TypeScript host that:
- Ingests WhatsApp events (`@whiskeysockets/baileys`)
- Stores state/messages/tasks in SQLite (`better-sqlite3`)
- Runs Claude Agent SDK inside isolated containers
- Uses file-based IPC between host and in-container agent runner
- Supports scheduled tasks and per-group isolation boundaries

Core modules:
- `src/index.ts`: orchestrator loops + startup
- `src/channels/whatsapp.ts`: WhatsApp I/O and metadata sync
- `src/container-runner.ts`: container lifecycle + mounts + output parsing
- `src/group-queue.ts`: per-group queue and global concurrency limits
- `src/ipc.ts`: tool IPC authorization and task operations
- `src/task-scheduler.ts`: due-task dispatch
- `src/db.ts`: SQLite schema and state access

### What works (confirmed)
- Typecheck: passes.
- Build: passes.
- Unit/integration-style tests: 4/7 suites pass, 91 tests pass.
  - Passing suites include formatting/routing/db/ipc-authorization coverage.
- Security controls that are implemented are covered in tests:
  - IPC authorization rules for task and group operations.
  - Mount allowlist validation logic and path checks.
- Queue/scheduler architecture is coherent: per-group serialization and global concurrency limits exist.

### What seems not to work (or is mismatched)
1. Test runner incompatibility in this environment:
- `npm test` fails 3 suites (`container-runner.test.ts`, `group-queue.test.ts`, `channels/whatsapp.test.ts`) before executing tests due to `Failed to resolve entry for package "fs"` in Vitest.
- CI uses Node 20 (`.github/workflows/test.yml`); local run here used Node 24.1.0. This appears environment/version-sensitive.

2. Formatting drift:
- `npm run format:check` fails on 15 files.

3. Runtime/docs mismatch (important):
- README says Apple Container or Docker support.
- Host runtime code is hardcoded to Apple Container CLI (`container` command) in `src/index.ts` and `src/container-runner.ts`.
- No first-class Docker execution path exists in current source.

4. Group trigger field not actually honored:
- `RegisteredGroup.trigger` is persisted but message gating uses global `TRIGGER_PATTERN` from `ASSISTANT_NAME`, not per-group trigger string.

5. Container cold-start overhead is high:
- `container/Dockerfile` entrypoint recompiles TypeScript on every invocation (`npx tsc --outDir /tmp/dist`) before starting the runner.
- This is expensive for embedded devices.

6. Credential exposure tradeoff remains unresolved:
- Auth vars are filtered, but mounted into container (`/workspace/env-dir/env`), so in-container agent code can still read them.

7. Network egress is broad:
- Containerized agent has unrestricted outbound network by default.
- For hostile prompt contexts, this is a security risk.

## Embedded Readiness Assessment
Current architecture is good for clarity but not optimized for constrained hardware.

Observed footprint indicators:
- `node_modules`: ~144 MB
- compiled host `dist`: ~580 KB
- TypeScript source (`src` + container runner): ~7k LOC

Main embedded blockers:
- Node runtime + heavy dependency graph
- Full container VM lifecycle per invocation
- per-run TypeScript compilation inside container
- polling-heavy loops with generous default timeouts (30 min)

## Rust Port Strategy (pragmatic, security/perf first)
Reference considered: [IronClaw](https://github.com/nearai/ironclaw).
Use it as pattern input, not as a drop-in architecture (it is broader and heavier than NanoClaw’s target).

### Target principles
- Keep NanoClaw small: avoid framework-scale expansion.
- Prefer static binaries and minimal runtime dependencies.
- Preserve strict isolation boundaries and explicit mount policy.
- Make insecure states impossible by default.

### Recommended migration path
1. Freeze behavior with contract tests (before rewrite)
- Snapshot current message routing, task scheduling, IPC auth, and DB behavior.
- Add black-box tests around host logic first.

2. Port host core first (keep channel/runner bridge temporarily)
- Implement Rust services for:
  - DB access + migrations (SQLite via `rusqlite` or `sqlx`)
  - group queue + retry backoff
  - scheduler
  - IPC auth/dispatch
- Keep existing TypeScript in-container runner temporarily to reduce blast radius.

3. Replace process loops with async runtime
- Use `tokio` tasks and channels instead of polling loops where practical.
- Keep deterministic ordering per group with bounded queues.

4. Replace container execution layer
- Introduce a Rust runner abstraction:
  - Apple Container backend (short term parity)
  - Docker backend (for Linux and broader embedded use)
- Remove per-run TypeScript compile step entirely.

5. Harden security model during port
- Add egress allowlist/proxy support by default.
- Move credentials to brokered runtime injection (never filesystem-visible in sandbox).
- Add structured audit logs for task actions and denied operations.

6. Optimize for constrained devices
- Default lower concurrency and tighter timeouts.
- Add bounded log/output buffers and task quotas.
- Introduce optional no-container mode only for explicitly trusted single-user local setups.

## Rust crate layout (proposed)
- `nanoclaw-core`: domain types, routing, trigger checks, policy rules
- `nanoclaw-store`: SQLite schema + queries + migrations
- `nanoclaw-scheduler`: cron/interval/once task engine
- `nanoclaw-queue`: per-group execution queue + retry/backoff
- `nanoclaw-sandbox`: container abstraction + mount/egress policy
- `nanoclaw-channel-whatsapp`: WhatsApp integration boundary
- `nanoclaw-host`: binary wiring modules together

## What to borrow from IronClaw vs avoid
Borrow:
- Stronger typed config and explicit module boundaries
- Sandbox manager abstraction
- Security-first posture around tools and outbound calls

Avoid (for this repo’s goals):
- Multi-channel platform sprawl
- Large feature matrix before core parity
- Heavy database/service footprint unless required by actual usage

## Immediate high-impact fixes before any port
1. Fix runtime/docs mismatch: either implement Docker backend or update docs to Apple-Container-only.
2. Make per-group trigger behavior real (use `group.trigger`, not just global name).
3. Fix Vitest compatibility on modern Node (or pin supported runtime explicitly).
4. Remove per-invocation `tsc` compile in container entrypoint.
5. Add security option for outbound network allowlisting.

## Definition of Done for embedded-ready Rust milestone
- Single Rust host binary with equivalent core behavior.
- End-to-end tests for message flow, IPC auth, and scheduler pass.
- Cold start and task latency measurably lower than current TS host.
- Memory and CPU profile documented on target embedded hardware.
- Credential handling and egress policy audited and enforced by default.
