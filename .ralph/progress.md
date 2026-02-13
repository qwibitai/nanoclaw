# Progress Log

## 2026-02-12T23:28:22Z S0 Initialize Ralph state + plan doc
- Outcome: pass
- Commands:
  - test -f .agents/tasks/prd-microclaw-phase1.json -> pass
  - test -f .ralph/progress.md -> pass
  - test -f docs/plans/2026-02-12-microclaw-phase1-implementation-plan.md -> pass
- Key diffs:
  - .agents/tasks/prd-microclaw-phase1.json added
  - .ralph/* initialized
  - docs/plans/2026-02-12-microclaw-phase1-implementation-plan.md tracked
- Notes:
  - Initialized Ralph loop state files

## 2026-02-12T23:29:39Z S3 Config crate defaults
- Outcome: pass
- Commands:
  - cargo test -p microclaw-config -> fail (package not found)
  - cargo test -p microclaw-config -> pass
- Key diffs:
  - Cargo.toml updated (workspace members)
  - crates/microclaw-config added
- Notes:
  - Added HostConfig default for apple backend

## 2026-02-12T23:30:54Z S4 Store schema + migrations
- Outcome: pass
- Commands:
  - cargo test -p microclaw-store -> fail (package not found)
  - cargo test -p microclaw-store -> fail (Store missing)
  - cargo test -p microclaw-store -> pass
- Key diffs:
  - Cargo.toml updated (workspace members)
  - crates/microclaw-store added
- Notes:
  - Added schema_version table and Store open_in_memory

## 2026-02-12T23:32:26Z S5 Queue per-group FIFO
- Outcome: pass
- Commands:
  - cargo test -p microclaw-queue -> fail (package not found)
  - cargo test -p microclaw-queue -> fail (GroupQueue missing)
  - cargo test -p microclaw-queue -> pass
- Key diffs:
  - Cargo.toml updated (workspace members)
  - crates/microclaw-queue added
- Notes:
  - Added bounded per-group FIFO queue

## 2026-02-12T23:33:30Z S6 Scheduler due logic
- Outcome: pass
- Commands:
  - cargo test -p microclaw-scheduler -> fail (package not found)
  - cargo test -p microclaw-scheduler -> fail (Scheduler/TaskSpec missing)
  - cargo test -p microclaw-scheduler -> pass (warning: unused id)
- Key diffs:
  - Cargo.toml updated (workspace members)
  - crates/microclaw-scheduler added
- Notes:
  - Minimal due() implementation; id field unused

## 2026-02-12T23:34:52Z S7 Bus idempotency
- Outcome: pass
- Commands:
  - cargo test -p microclaw-bus -> fail (package not found)
  - cargo test -p microclaw-bus -> fail (Bus missing)
  - cargo test -p microclaw-bus -> pass (warning: MessageId field unused)
- Key diffs:
  - Cargo.toml updated (workspace members)
  - crates/microclaw-bus added
- Notes:
  - Idempotency key uses device_id + Debug(message_id)

## 2026-02-12T23:35:58Z S8 Sandbox apple backend stub
- Outcome: pass
- Commands:
  - cargo test -p microclaw-sandbox -> fail (package not found)
  - cargo test -p microclaw-sandbox -> fail (AppleContainer missing)
  - cargo test -p microclaw-sandbox -> pass
- Key diffs:
  - Cargo.toml updated (workspace members)
  - crates/microclaw-sandbox added
- Notes:
  - Added ContainerBackend trait and AppleContainer stub

## 2026-02-12T23:36:59Z S9 Sandbox docker backend stub
- Outcome: pass
- Commands:
  - cargo test -p microclaw-sandbox -> fail (DockerBackend missing)
  - cargo test -p microclaw-sandbox -> pass
- Key diffs:
  - crates/microclaw-sandbox updated
- Notes:
  - Added DockerBackend stub

## 2026-02-12T23:38:13Z S10 Connector trait
- Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (package not found)
  - cargo test -p microclaw-connectors -> fail (Connector missing)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - Cargo.toml updated (workspace members)
  - crates/microclaw-connectors added
- Notes:
  - Added ConnectorId and Connector trait

## 2026-02-12T23:39:19Z S11 Device scaffold
- Outcome: pass
- Commands:
  - cargo test -p microclaw-device --features host -> fail (package outside workspace)
  - cargo test -p microclaw-device --features host -> pass
- Key diffs:
  - Cargo.toml updated (workspace members)
  - apps/microclaw-device added
- Notes:
  - Added lib.rs for boot_message to support tests

## 2026-02-12T23:41:22Z S12 Lockfile + ignore target
- Outcome: pass
- Commands:
  - git diff --exit-code Cargo.lock -> fail
  - rg -n "^target/$" .gitignore -> fail
  - git diff --exit-code Cargo.lock -> pass
  - rg -n "^target/$" .gitignore -> pass
- Key diffs:
  - Cargo.lock updated with workspace packages
  - .gitignore now ignores target/
- Notes:
  - Keeps worktree clean after Rust builds

## 2026-02-12T23:49:06Z S13 Core routing + trigger policy
- Outcome: pass
- Commands:
  - cargo test -p microclaw-core -> fail (missing trigger APIs)
  - cargo test -p microclaw-core -> pass
- Key diffs:
  - crates/microclaw-core/src/lib.rs updated
  - crates/microclaw-core/tests/trigger_policy.rs added
  - crates/microclaw-core/Cargo.toml updated (regex)
- Notes:
  - Ported createTriggerPattern and requiresTrigger gating from NanoClaw

## 2026-02-12T23:52:00Z S14 Store schema parity
- Outcome: pass
- Commands:
  - cargo test -p microclaw-store -> fail (schema_parity tests)
  - cargo test -p microclaw-store -> pass
- Key diffs:
  - crates/microclaw-store/src/lib.rs updated
  - crates/microclaw-store/migrations/0001_init.sql updated
  - crates/microclaw-store/tests/schema_parity.rs added
- Notes:
  - Added NanoClaw table parity and context_mode column

## 2026-02-12T23:54:19Z S15 Bus WAL + replay
- Outcome: pass
- Commands:
  - cargo test -p microclaw-bus -> fail (missing WAL APIs)
  - cargo test -p microclaw-bus -> pass
- Key diffs:
  - crates/microclaw-bus/src/lib.rs updated
  - crates/microclaw-bus/Cargo.toml updated (rusqlite, serde_json)
  - crates/microclaw-protocol updated (serde, as_str)
  - crates/microclaw-bus/tests/idempotent.rs updated
- Notes:
  - Added SQLite-backed bus_events table and replay

## 2026-02-12T23:59:37Z S16 Scheduler recurrence + persistence
- Outcome: pass
- Commands:
  - cargo test -p microclaw-scheduler -> fail (missing recurrence APIs/deps)
  - cargo test -p microclaw-scheduler -> pass
- Key diffs:
  - crates/microclaw-scheduler/src/lib.rs updated (ScheduleType, compute_next_run, due_tasks, update_task_after_run)
  - crates/microclaw-scheduler/Cargo.toml updated (chrono, cron, rusqlite, microclaw-store dev-dep)
  - crates/microclaw-scheduler/tests/recurrence.rs added
- Notes:
  - Added cron/interval scheduling with SQLite-backed due/replay helpers

## 2026-02-13T00:02:02Z S17 Queue concurrency + retry
- Outcome: pass
- Commands:
  - cargo test -p microclaw-queue -> fail (ExecutionQueue/RetryPolicy missing)
  - cargo test -p microclaw-queue -> pass
- Key diffs:
  - crates/microclaw-queue/src/lib.rs updated (ExecutionQueue, RetryPolicy)
  - crates/microclaw-queue/tests/concurrency.rs added
- Notes:
  - Added inflight limit, per-group serialization, retry with backoff

## 2026-02-13T00:03:01Z S18 Apple Container runner
- Outcome: pass
- Commands:
  - cargo test -p microclaw-sandbox -> fail (AppleContainerRunner missing)
  - cargo test -p microclaw-sandbox -> pass
- Key diffs:
  - crates/microclaw-sandbox/src/lib.rs updated (RunSpec, Mount, AppleContainerRunner)
  - crates/microclaw-sandbox/tests/apple_runner.rs added
- Notes:
  - Added Apple container CLI command builder with mounts + env

## 2026-02-13T00:04:03Z S19 Docker runner parity
- Outcome: pass
- Commands:
  - cargo test -p microclaw-sandbox -> fail (DockerRunner missing)
  - cargo test -p microclaw-sandbox -> pass
- Key diffs:
  - crates/microclaw-sandbox/src/lib.rs updated (DockerRunner + docker mount args)
  - crates/microclaw-sandbox/tests/docker_runner.rs added
- Notes:
  - Added Docker CLI command builder with mounts + env

## 2026-02-13T00:05:14Z S20 Mount allowlist + egress deny
- Outcome: pass
- Commands:
  - cargo test -p microclaw-sandbox -> fail (policy types missing)
  - cargo test -p microclaw-sandbox -> pass
- Key diffs:
  - crates/microclaw-sandbox/src/lib.rs updated (MountPolicy, EgressPolicy)
  - crates/microclaw-sandbox/tests/policy.rs added
- Notes:
  - Added deny-by-default egress and mount allowlist validation
