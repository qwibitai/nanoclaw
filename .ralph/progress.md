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

## 2026-02-13T00:06:35Z S21 Secrets broker + audit logs
- Outcome: pass
- Commands:
  - cargo test -p microclaw-sandbox -> fail (SecretBroker/AuditEvent missing)
  - cargo test -p microclaw-sandbox -> pass
- Key diffs:
  - crates/microclaw-sandbox/src/lib.rs updated (AuditLog, SecretBroker)
  - crates/microclaw-sandbox/tests/secrets.rs added
- Notes:
  - Added allowlist-based secret broker with audit events

## 2026-02-13T00:07:49Z S22 iMessage connector
- Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (IMessageConnector missing)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - crates/microclaw-connectors/src/lib.rs updated (IMessageConnector helpers)
  - crates/microclaw-connectors/tests/imessage.rs added
- Notes:
  - Added AppleScript send + chat.db query builder

## 2026-02-13T00:08:46Z S23 Discord connector
- Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (DiscordConnector missing)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - crates/microclaw-connectors/src/lib.rs updated (DiscordConnector helpers)
  - crates/microclaw-connectors/tests/discord.rs added
- Notes:
  - Added Discord API URL + auth header helpers

## 2026-02-13T00:09:45Z S24 Telegram connector
- Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (TelegramConnector missing)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - crates/microclaw-connectors/src/lib.rs updated (TelegramConnector helpers)
  - crates/microclaw-connectors/tests/telegram.rs added
- Notes:
  - Added Telegram API sendMessage URL helper

## 2026-02-13T00:10:39Z S25 Email connector
- Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (EmailConnector missing)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - crates/microclaw-connectors/src/lib.rs updated (EmailConnector helpers)
  - crates/microclaw-connectors/tests/email.rs added
- Notes:
  - Added SMTP MAIL FROM + IMAP IDLE command helpers

## 2026-02-13T00:11:37Z S26 Device runtime WS + UI shell
- Outcome: pass
- Commands:
  - cargo test -p microclaw-device --features host -> fail (WS helpers missing)
  - cargo test -p microclaw-device --features host -> pass
- Key diffs:
  - apps/microclaw-device/src/lib.rs updated (ws url, backoff, ui title)
  - apps/microclaw-device/tests/ws.rs added
- Notes:
  - Added host-compile WS URL + backoff helpers for ESP-IDF runtime

## 2026-02-13T00:16:01Z S27 Sandbox execution runtime
- Outcome: pass
- Commands:
  - cargo test -p microclaw-sandbox -> fail (Executor/CommandResult missing)
  - cargo test -p microclaw-sandbox -> pass
- Key diffs:
  - crates/microclaw-sandbox/src/lib.rs updated (Executor, ProcessExecutor, AppleContainerRunner::run)
  - crates/microclaw-sandbox/tests/execution.rs added
  - crates/microclaw-sandbox/tests/apple_runner.rs updated
- Notes:
  - Added executor abstraction for real process execution

## 2026-02-13T00:16:59Z S28 Sandbox policy enforcement
- Outcome: pass
- Commands:
  - cargo test -p microclaw-sandbox -> fail (run_with_policy/egress missing)
  - cargo test -p microclaw-sandbox -> pass
- Key diffs:
  - crates/microclaw-sandbox/src/lib.rs updated (RunSpec egress hosts, run_with_policy)
  - crates/microclaw-sandbox/tests/policy_exec.rs added
- Notes:
  - Enforced mount allowlist + egress allowlist at runtime

## 2026-02-13T00:18:21Z S29 iMessage runtime integration
- Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (executor/message types missing)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - crates/microclaw-connectors/src/lib.rs updated (CommandExecutor, IMessageMessage, fetch_since)
  - crates/microclaw-connectors/Cargo.toml updated (rusqlite, tempfile)
  - crates/microclaw-connectors/tests/imessage_runtime.rs added
- Notes:
  - Added osascript send path + chat.db polling helper

## 2026-02-13T00:19:57Z S30 Discord runtime integration
- Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (Discord runtime deps/APIs missing)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - crates/microclaw-connectors/src/lib.rs updated (Discord REST send/fetch)
  - crates/microclaw-connectors/Cargo.toml updated (serde, serde_json, ureq, httpmock)
  - crates/microclaw-connectors/tests/discord_runtime.rs added
- Notes:
  - Added REST calls with mocked tests via httpmock

## 2026-02-13T00:21:02Z S31 Telegram runtime integration
- Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (Telegram runtime APIs missing)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - crates/microclaw-connectors/src/lib.rs updated (Telegram send/getUpdates)
  - crates/microclaw-connectors/tests/telegram_runtime.rs added
- Notes:
  - Added Telegram HTTP calls with mocked tests

## 2026-02-13T00:24:31Z S32 Email runtime integration
- Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (Email runtime deps/APIs missing)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - crates/microclaw-connectors/src/lib.rs updated (EmailMessage, smtp_send, imap connect)
  - crates/microclaw-connectors/Cargo.toml updated (lettre, imap, native-tls)
  - crates/microclaw-connectors/tests/email_runtime.rs added
- Notes:
  - Added SMTP send and IMAP connect/idle wrappers

## 2026-02-13T00:25:34Z S33 ESP-IDF runtime wiring
- Outcome: pass
- Commands:
  - cargo test -p microclaw-device --features host -> fail (esp_feature_hint missing)
  - cargo test -p microclaw-device --features host -> pass
- Key diffs:
  - apps/microclaw-device/Cargo.toml updated (esp-idf-svc optional)
  - apps/microclaw-device/src/lib.rs updated (esp feature hint, esp module)
  - apps/microclaw-device/tests/esp_stub.rs added
- Notes:
  - Added ESP feature-gated wiring (host builds unchanged)

## 2026-02-13T00:28:13Z S34 IMAP idle integration
- Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (imap_idle_timeout_secs missing)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - crates/microclaw-connectors/src/lib.rs updated (imap idle handle + timeout)
  - crates/microclaw-connectors/tests/email_idle.rs added
- Notes:
  - Switched IMAP idle to real handle with bounded timeout

## 2026-02-13T03:15:21Z S35 Scheduler warning cleanup
- Outcome: pass
- Commands:
  - cargo test -p microclaw-scheduler -> fail (TaskSpec::id missing)
  - cargo test -p microclaw-scheduler -> pass
- Key diffs:
  - crates/microclaw-scheduler/src/lib.rs updated (TaskSpec::id)
  - crates/microclaw-scheduler/tests/task_spec.rs added
- Notes:
  - Removed unused id warning by adding accessor
## 2026-02-13T03:30:16Z S36 ESP-IDF toolchain check - Outcome: blocked
- Commands:
  - cargo check -p microclaw-device --features esp -> fail (esp-idf-sys unsupported target aarch64-apple-darwin; ESP-IDF env missing)
  - cargo install espup -> pass
  - espup install --targets esp32s3 --std --log-level info -> hung (terminated)
- Key diffs:
  - .agents/tasks/prd-microclaw-phase1.json updated (S36 notes, meta.updatedAt)
- Notes:
  - Need xtensa-esp32s3-espidf target + ESP-IDF env; rerun espup install with sufficient time
## 2026-02-13T03:32:17Z S37 Phase1 completion PRD expansion - Outcome: pass
- Commands:
  - rg -n '"S38"' .agents/tasks/prd-microclaw-phase1.json -> pass
- Key diffs:
  - .agents/tasks/prd-microclaw-phase1.json updated (S37 done, S38-S43 added)
- Notes:
  - Added open stories for core parity, sandbox, connectors, device runtime
## 2026-02-13T03:34:30Z S38 Core router parity - Outcome: pass
- Commands:
  - cargo test -p microclaw-core -> fail (missing router exports)
  - cargo test -p microclaw-core -> pass
- Key diffs:
  - crates/microclaw-core/src/lib.rs updated (router formatting + channel trait)
  - crates/microclaw-core/tests/router.rs added
- Notes:
  - Added escape_xml, format_messages, strip_internal_tags, format_outbound, route_outbound, find_channel
## 2026-02-13T03:40:59Z S39 Bus persistence path - Outcome: pass
- Commands:
  - cargo test -p microclaw-bus -> fail (MAX(seq) NULL handling)
  - cargo test -p microclaw-bus -> pass
- Key diffs:
  - crates/microclaw-bus/src/lib.rs updated (open(path), seq assignment)
  - crates/microclaw-bus/Cargo.toml updated (rusqlite/serde_json/tempfile)
  - crates/microclaw-bus/tests/persistence.rs added
- Notes:
  - Bus now persists to file and assigns sequences when missing
## 2026-02-13T03:42:53Z S40 Store accessors parity - Outcome: pass
- Commands:
  - cargo test -p microclaw-store -> fail (syntax error, FK violation)
  - cargo test -p microclaw-store -> pass
- Key diffs:
  - crates/microclaw-store/src/lib.rs updated (registered_groups + message accessors)
  - crates/microclaw-store/tests/accessors.rs added
- Notes:
  - store_message now inserts chat row to satisfy FK
## 2026-02-13T03:44:05Z S44 Lockfile update - Outcome: pass
- Commands:
  - git diff --exit-code Cargo.lock -> fail
  - git diff --exit-code Cargo.lock -> pass
- Key diffs:
  - Cargo.lock updated (tempfile dep for microclaw-bus)
- Notes:
  - Lockfile kept in sync with crate updates
## 2026-02-13T04:09:58Z S36 ESP-IDF toolchain check - Outcome: blocked
- Commands:
  - espup install --targets esp32s3 --log-level info -> pass
  - cargo +esp check -p microclaw-device --features esp -Zbuild-std=std,panic_abort --target xtensa-esp32s3-espidf -> fail (time64 mismatch)
  - cargo +esp check with ESP_IDF_VERSION=release/v4.4 -> fail (ESP-IDF cmake build error)
  - pip install -r requirements.txt (filtered) -> pass
- Key diffs:
  - .agents/tasks/prd-microclaw-phase1.json updated (S36 notes)
- Notes:
  - IDF v4.4 dependencies installed; build still fails in cmake/ninja step
## 2026-02-13T04:11:37Z S41 Sandbox runtime enforcement - Outcome: pass
- Commands:
  - cargo test -p microclaw-sandbox -> fail (generic param inference)
  - cargo test -p microclaw-sandbox -> pass
- Key diffs:
  - crates/microclaw-sandbox/src/lib.rs updated (network isolation default)
  - crates/microclaw-sandbox/tests/network.rs added
- Notes:
  - Docker/Apple runners now add --network=none when no egress hosts
## 2026-02-13T04:49:05Z S42 Connector runtime parity - Outcome: pass
- Commands:
  - cargo test -p microclaw-connectors -> fail (retry tests)
  - cargo test -p microclaw-connectors -> pass
- Key diffs:
  - crates/microclaw-connectors/src/lib.rs updated (retry/backoff + dedupe + retry wrappers)
  - tests added/updated: retry.rs, discord_runtime.rs, telegram_runtime.rs, email_runtime.rs, imessage_runtime.rs
- Notes:
  - Retry behavior is now deterministic via backoff metadata
## 2026-02-13T05:02:24Z S43 Device runtime ESP integration
- Outcome: pass
- Commands:
  - cargo +esp check -p microclaw-device --features esp -Zbuild-std=std,panic_abort --target xtensa-esp32s3-espidf -> fail (time64 mismatch under IDF v4.4)
  - cargo +esp check -p microclaw-device --features esp -Zbuild-std=std,panic_abort --target xtensa-esp32s3-espidf (ESP_IDF_VERSION=release/v5.1) -> fail (bootloader CMake cache mismatch)
  - cargo +esp check -p microclaw-device --features esp -Zbuild-std=std,panic_abort --target xtensa-esp32s3-espidf (ESP_IDF_VERSION=release/v5.1, esp-idf-svc 0.51) -> pass
- Key diffs:
  - apps/microclaw-device/Cargo.toml updated (esp-idf-svc 0.51)
  - Cargo.lock updated (esp-idf-sys/hal/svc/bindgen/embuild)
- Notes:
  - IDF v4.4 build required Python 3.11 env for construct==2.10.54; v5.1 build needed bootloader CMakeCache cleanup
## 2026-02-13T05:04:38Z S36 ESP-IDF toolchain check
- Outcome: pass
- Commands:
  - cargo +esp check -p microclaw-device --features esp (CARGO_BUILD_TARGET=xtensa-esp32s3-espidf) -> fail (missing core/std)
  - cargo +esp check -p microclaw-device --features esp (CARGO_BUILD_TARGET=xtensa-esp32s3-espidf, CARGO_UNSTABLE_BUILD_STD=std,panic_abort) -> pass
- Key diffs:
  - .agents/tasks/prd-microclaw-phase1.json updated (S36 done)
- Notes:
  - Build-std required for xtensa toolchain in this workspace
## 2026-02-13T05:06:09Z S45 Ignore ESP-IDF build artifacts
- Outcome: pass
- Commands:
  - rg -n "^\.embuild/" .gitignore -> fail
  - rg -n "^\.embuild/" .gitignore -> pass
- Key diffs:
  - .gitignore updated (.embuild/)
- Notes:
  - Keeps espup/IDF downloads out of git status
## 2026-02-13T05:07:09Z S46 Reproducible ESP check script
- Outcome: pass
- Commands:
  - test -x scripts/esp-check.sh -> fail
  - test -x scripts/esp-check.sh -> pass
- Key diffs:
  - scripts/esp-check.sh added (encapsulates ESP_IDF_VERSION + build-std)
- Notes:
  - Uses $HOME/export-esp.sh if available for toolchain setup
## 2026-02-13T05:08:00Z S47 ESP build reproducibility doc
- Outcome: pass
- Commands:
  - test -f docs/ESP_TOOLCHAIN.md -> fail
  - test -f docs/ESP_TOOLCHAIN.md -> pass
- Key diffs:
  - docs/ESP_TOOLCHAIN.md added (ESP v5.1 + build-std instructions)
- Notes:
  - Points to scripts/esp-check.sh for canonical flow
## 2026-02-13T05:11:46Z S48 Run host test suite
- Outcome: pass
- Commands:
  - cargo test -> pass
- Key diffs:
  - .agents/tasks/prd-microclaw-phase1.json updated (S48 done)
- Notes:
  - Full host test suite green after ESP dependency updates
## 2026-02-13T21:05:53Z S1 Host binary scaffold
- Outcome: pass
- Commands:
  - cargo test -p microclaw-host -> fail (package missing)
  - cargo test -p microclaw-host -> fail (Bus::new missing)
  - cargo test -p microclaw-host -> pass
- Key diffs:
  - Cargo.toml updated (workspace members)
  - apps/microclaw-host added (Cargo.toml, lib.rs, main.rs, tests)
  - .agents/tasks/prd-microclaw-host-parity.json updated
- Notes:
  - Host initializes in-memory store and bus
