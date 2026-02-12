# MicroClaw Design (Host + Device Runtime)

Date: 2026-02-12
Status: validated with stakeholder

## Purpose
Define the architecture and phased plan for MicroClaw, a Rust-first system that replaces NanoClaw with a two-tier design:
- Tier A (host): Rust macro-agent on Mac mini/cloud with strict sandboxing.
- Tier B (device runtime): Rust ESP32-S3 terminal OS for UI, audio, and secure connectivity.

This design emphasizes performance, security, and embedded constraints, while preserving NanoClaw parity where required.

## Goals
- Rust-only implementation for host, connectors, gateway, and device runtime.
- Strong isolation via Apple Container and Docker backends on the host.
- Built-in message bus (no external broker) with durable host storage.
- Connectors for iMessage (blue bubbles), Discord, Telegram, and Email (IMAP/SMTP first, Gmail API later).
- Embedded-first runtime for ESP32-S3 using ESP-IDF (std) via esp-idf-svc.
- Maintain parity with NanoClaw core behavior in Phase 1 and harden by default.

## Non-Goals (Phase 1)
- WhatsApp support.
- General-purpose WASM plugin system.
- Full on-device LLM or tool execution.
- External broker (NATS/Redis/Kafka).

## Key Decisions
- Monorepo with shared crates for host and device.
- Built-in message bus (tokio channels + SQLite WAL durability on host).
- Connectors implemented as static Rust crates behind feature flags.
- iMessage integration via macOS Messages automation (AppleScript + chat.db tail).
- Sandbox isolation via Apple Container and Docker parity backends.
- ESP32-S3 runtime built with ESP-IDF (std) via esp-idf-svc.
- Phase ordering: 1) MicroClaw host + device runtime, 2) Terminal gateway, 3) Distillation/ML pipeline.

## Architecture Overview

### Binaries
- `microclaw-host`: main host binary (Mac mini/cloud).
- `microclaw-device`: ESP32-S3 runtime.
- `microclaw-gateway`: terminal gateway (Phase 2).

### Crates
- `microclaw-core`: domain types, routing, trigger logic, policy decisions.
- `microclaw-bus`: message bus abstraction + persistence adapters.
- `microclaw-store`: SQLite schema + migrations + queries (host).
- `microclaw-scheduler`: cron/interval/once scheduler with deterministic ordering.
- `microclaw-queue`: per-group serialization with bounded concurrency.
- `microclaw-sandbox`: container runner abstraction (Apple Container + Docker).
- `microclaw-connectors-*`: connector crates (imessage, discord, telegram, email).
- `microclaw-device`: ESP32-S3 runtime (UI/audio/ws/ota).

## Message Bus Design
- Strict, versioned envelope: `Envelope { v, seq, ts_ms, source, device_id, session_id, message_id, payload }`.
- Idempotency enforced by `message_id`.
- Host bus uses bounded channels + SQLite WAL spool for durability and replay.
- Device bus uses bounded in-memory queues + small offline flash ring buffer.
- Per-session ordering and replay on reconnect with `last_seen_seq`.

## Host Sandbox Model
- Mandatory container execution for tools with filesystem/network/command access.
- Apple Container + Docker backends; default is Apple Container on macOS.
- Default deny outbound network with per-tool/per-group allowlist.
- Secrets are brokered, not file-mounted by default.
- Audit log: allow/deny decisions, tool invocations, target hosts.

## Connectors

### iMessage (macOS)
- Send via AppleScript (`osascript`) to Messages app.
- Receive by tailing `~/Library/Messages/chat.db` and tracking `ROWID`.
- Requires Full Disk Access for the host binary.
- Periodic reconciliation to avoid false positives and handle restarts.

### Discord / Telegram
- Official APIs with rate limiting, reconnect backoff, and idempotent delivery.
- Connector publishes inbound to bus; outbound is queued with retry policy.

### Email
- IMAP IDLE (poll fallback) + SMTP for outbound (Phase 1).
- Gmail API as alternate connector in Phase 2+.

## Device Runtime (ESP32-S3)
- ESP-IDF via esp-idf-svc (Wi-Fi, TLS, WebSocket, NVS, OTA).
- LVGL UI, I2S audio, bounded ring buffers.
- Offline queue for outbound messages; replay on reconnect.
- TLS server verification pinned to gateway cert/CA.
- Optional TinyML routing hints in Phase 2.

## Phase 1: MicroClaw Host + Device Runtime (Parity + Hardening)
Deliverables:
- Rust host core parity (routing, queue, scheduler, policy).
- Built-in bus with durability and idempotency.
- Host sandbox (Apple Container + Docker backends).
- Connectors: iMessage, Discord, Telegram, Email (IMAP/SMTP).
- Device runtime: WS connectivity, UI rendering, offline queue, OTA.
- Contract tests to freeze behavior parity.

Acceptance checks (examples):
- Deterministic per-group ordering under concurrency.
- Policy allow/deny enforcement under default deny egress.
- Connector reconnection and idempotent send/recv.

## Phase 2: Terminal Gateway (WS + OTA + Auth)

### Gateway responsibilities
- WebSocket session termination for devices.
- HTTPS endpoints for OTA firmware and model bundles.
- Device registry, pairing, and cert lifecycle.
- Bridge device events to host bus with replay and ack.

### Auth and pairing
- mTLS required after pairing.
- Pairing flow: device shows code -> user claims -> gateway issues short-lived token -> device CSR -> gateway signs cert -> device stores in NVS.

### WS protocol
- `device.hello` includes `last_seen_seq`.
- Gateway replays missed events, then streams new ones.
- Idempotency via `message_id` with explicit ack.

### OTA
- Firmware and model manifests signed (ed25519).
- Device verifies signature + hash before activation.
- Staged rollout with percent-based gating per cohort.

## Phase 2: Distillation + Model Bundle OTA

### Distillation
- Teacher labels intent/route/confirmation using strict JSON schema.
- Dataset from synthetic grammar + real interaction traces.
- Multi-head classifier (intent + route + confirm) with PTQ int8; QAT if needed.

### Model bundle OTA
- Bundle includes signed manifest + model files + arena sizes.
- A/B slots on device; verify + self-test before activation.
- Canary rollout with rollback triggers on confirm misses, latency regressions, or crash loops.

## Deferred Risks (acknowledged)
- iMessage chat.db schema drift and Messages app automation fragility.
- Key rotation and revocation policy.
- Full threat model and compliance posture.

## Next Step
Create the implementation plan for Phase 1, then begin a multi-cycle execution loop with contract tests and parity checkpoints.
