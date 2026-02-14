# MicroClaw Device Gap Audit

**Date:** 2026-02-13
**Branch:** `feature/microclaw-device-runtime-touch-transport`
**Audited against:** gap-remediation-master-plan, baseline-implementation-plan, display-touch-plan, gap3-reliability-security, gap5-voice-ui-transport-coupling

## Current State

43 host-mode tests passing. 12 source modules across `apps/microclaw-device/src/`. Protocol crate (`microclaw-protocol`) has typed envelopes, command/status/touch payloads, and transport message framing. Host crate (`microclaw-host`) is a scaffold struct with no runtime.

### Source Modules

| Module | Lines | Purpose |
|--------|-------|---------|
| `runtime.rs` | ~550 | State machine, message processing, safety, OTA tracking |
| `event_loop.rs` | ~310 | Frame loop, transport recovery, render scheduling |
| `transport.rs` | ~410 | TransportBus trait, InMemoryTransport, WsTransport (ESP) |
| `drivers.rs` | ~670 | Display/Touch driver traits, host stubs, ESP FFI + ISR bridge |
| `renderer.rs` | ~195 | SceneRenderer trait, NullRenderer, DisplaySceneRenderer |
| `pipeline.rs` | ~87 | TouchPipeline bounded queue |
| `display.rs` | ~32 | 360x360 geometry, circle validation |
| `ui.rs` | ~128 | Scene enum, HitTarget, touch-to-action mapping |
| `boards.rs` | ~72 | Waveshare 1.85C pin config |
| `lib.rs` | ~125 | Exports, BootPhase, ESP runtime (wifi, transport URL, allowlist) |
| `main.rs` | ~180 | Host and ESP entry points with boot phase logging |

### Test Coverage

| Test file | Count | Covers |
|-----------|-------|--------|
| runtime.rs | 14 | State transitions, seq dedup, TTL, touch, OTA, safety, boot failure |
| transport.rs | 5 | Buffer caps, transport dispatch, reconnect backoff, recovery messages |
| event_loop.rs | 3 | Touch+transport dispatch, offline timeout, driver drain |
| pipeline.rs | 3 | FIFO order, overflow drop, driver drain |
| renderer.rs | 2 | Scene transitions, flush payload |
| display.rs | 3 | Circle clamp validation |
| drivers.rs | 2 | Touch transform, board geometry |
| ui.rs | 3 | Scene-to-action mapping |
| boot.rs | 1 | Boot message |
| esp_stub.rs | 1 | Feature hint |
| ws.rs | 3 | URL builder, backoff, shell title |

---

## Workstream A — Display/Touch/GUI

### Done

- DisplayDriver + TouchDriver trait abstractions with host/ESP implementations
- Board pin constants (`WAVESHARE_1_85C_V3` with all GPIO assignments)
- Display geometry (360x360 circular viewport, safe radius 160px)
- TouchPipeline (32-event bounded FIFO, overflow drop, stale purge)
- TouchTransform (swap_xy, invert_x, invert_y coordinate mapping)
- Scene enum (Boot, Paired, Conversation, Settings, Error, Offline)
- HitTarget mapping per scene with touch-to-DeviceAction dispatch
- SceneRenderer trait + NullRenderer + DisplaySceneRenderer
- ESP FFI declarations for st77916 (init/deinit/flush/brightness/rotation)
- ESP FFI declarations for cst816 (init/deinit/irq_handler)
- ISR-to-task bridge via `Cst816IrqQueue` (Arc<Mutex<VecDeque>>)
- `idf_component.yml` declaring `esp_lcd_st77916` and `esp_lcd_touch_cst816s`

### Missing

| Gap | Impact | Effort |
|-----|--------|--------|
| On-device panel init validation | Cannot verify display/touch work on real hardware | Needs ESP toolchain + device |
| Calibration persistence (NVS save/load for TouchTransform) | Touch calibration lost on every reboot | Small — NVS read/write for transform struct |
| Gesture filtering / noise rejection | Raw touch events pass through unfiltered; noisy touches create spurious actions | Medium — debounce, minimum move threshold, multi-sample averaging |
| Dirty-rect partial updates | Every render is a full-screen redraw (360*360*2 = 253KB per frame) | Medium — track dirty regions, flush only changed rects |
| Real scene rendering (text, icons, layout) | DisplaySceneRenderer draws solid color fills only. No text, no UI content visible. | **Large** — requires GUI framework decision (Slint/LVGL/embedded-graphics + font) |
| Demo mode (`--demo-sim` profile) | No on-device hardware validation path without real host | Medium — synthetic data screens for touch/display/audio verification |

### Blocking Decision

**GUI framework choice has not been made.** The mockups specify text, status bars, labeled buttons, conversation history. Current renderer cannot display any of this. Options per `docs/GUI.md`:

1. **Slint** — declarative, Rust-native, but heavier runtime footprint
2. **LVGL (via bindings)** — battle-tested on ESP32, C-based with Rust bindings
3. **embedded-graphics + custom font** — minimal, no framework overhead, but manual layout
4. **egui/iced** — desktop-oriented, likely too heavy for ESP32-S3

This decision gates all real UI work.

---

## Workstream B — Transport/UI Contract

### Done

- Protocol envelope with `v`, `seq`, `source`, `device_id`, `session_id`, `message_id`
- Anti-replay (seq monotonicity + message_id dedup with bounded map)
- TTL expiry enforcement (added this session)
- TransportBus trait with InMemoryTransport (host/test) and WsTransport (ESP)
- Reconnect with exponential backoff (capped 30s, configurable base)
- Command lifecycle: emit_command -> in_flight tracking -> CommandAck/CommandResult -> reclaim stale
- Separate inbound/outbound seq counters (fixed this session)

### Missing

| Gap | Impact | Effort |
|-----|--------|--------|
| **Host transport server** | Device has nowhere to connect. WsTransport targets a URL that doesn't exist. All end-to-end testing impossible. | **Large** — WebSocket listener in `microclaw-host` that speaks the protocol |
| State reconciliation on reconnect | After transport recovery, host and device don't sync missed state. Device may show stale data indefinitely. | Medium — "request full snapshot" message type + host handler |
| Signature/nonce verification | `signature` and `nonce` fields exist in TransportMessage but are never checked | Medium — HMAC or Ed25519 verification in apply_transport_message |
| Control/media lane split | Single transport channel for commands, status, and (future) audio frames | Medium-Large — separate bounded queues per lane with priority |

### Critical Path

The host transport server is the #1 blocker for the entire system. Without it:
- Device transport/reconnect code is only testable via InMemoryTransport mocks
- No end-to-end command round-trip is possible
- Voice gateway has no entry point
- OTA delivery has no source

---

## Workstream C — Reliability/Security/Operations

### Done

- Boot failure counting (3-strike threshold -> SafeMode)
- SafeMode correctly preserved after threshold (fixed this session)
- Safety lockdown (fail count -> safe mode transition)
- Host allowlist enforcement on inbound messages
- Boot phase logging (BootPhase enum with structured `[microclaw]` markers)
- Reconnect backoff with safe-mode blocking
- Stale in-flight command reclaim with safety counter bump

### Missing

| Gap | Impact | Effort |
|-----|--------|--------|
| **Persistent boot counters (NVS)** | Boot failure count resets to 0 on reboot — boot-loop detection is completely broken | Small — NVS read on boot, write on failure/success |
| Watchdog timer integration | If main loop hangs, nothing resets the device | Small — `esp_task_wdt_add()` in ESP main loop |
| OTA image staging + partition write | `ota_in_progress` is a flag with no backing implementation. No download, no flash, no verify. | Large — `esp_ota_ops` integration (write inactive slot, validate, switch boot target) |
| OTA signature verification | Accept any OTA payload without cryptographic verification | Medium — Ed25519 or RSA signature check on manifest + image hash |
| OTA health check + rollback | No post-OTA health validation. Bad firmware sticks. | Medium — N-heartbeat health gate before marking image valid |
| TLS cert configuration | `EspWebSocketClientConfig::default()` — no cert verification, no pinning | Small-Medium — configure CA cert bundle or pin in WsTransport |
| Device provisioning flow | No pairing challenge, no identity lifecycle, no session tokens | Large — challenge-response, cert/token exchange, NVS storage |
| Factory/config reset commands | No way to wipe device state or re-provision | Medium — NVS erase + state reset + mode transition |
| NVS secure storage for secrets | All config from env vars. Wifi password, host URL, allowlist all in plaintext env. | Medium — NVS encrypted partition for credentials |
| Persistent audit logging | Auth decisions in 16-entry in-memory VecDeque, lost on reboot | Medium — write to SD card or NVS with bounded rotation |

---

## Workstream D — Voice/Audio

### Done

- AudioPins in board config (I2S BCLK/WS/SD/DOUT pin assignments)

### Not Started (Entire Domain)

The voice subsystem is defined across 6 milestones in `gap5-voice-ui-transport-coupling.md`. Zero implementation exists.

Required modules (from plan):
- `voice/mod.rs` — module root
- `voice/state.rs` — authoritative voice state machine (Idle/Listening/Transcribing/Speaking/Failing/Fallback)
- `voice/pcm.rs` — capture/playback ring buffers, codec constants (PCM16@16kHz)
- `voice/buffering.rs` — bounded queue policy (100 input frames, 80 output frames, 2MB ASR cap)
- `voice/gateway_client.rs` — ASR/TTS RPC lifecycle to host gateway
- `voice/fallback.rs` — degraded mode policy (local command grammar, text-first reply, offline queue)
- `voice/modes.rs` — feature flags (voice_remote_asr, voice_remote_tts, voice_local_fallback)

Required protocol additions:
- `VoiceEvent`, `VoiceCommand`, `VoiceError`, `AudioFrame` types in `microclaw-protocol`
- `voice_version` field for stream versioning
- Queue pressure metadata (`pcm_in_queue`, `asr_inflight`, `tts_pending`)

Required UI integration:
- `VoiceUiBinding` adapter mapping VoiceState to Scene and action affordances

Required host infrastructure:
- Voice gateway endpoints (`POST /voice/asr/stream`, `POST /voice/tts/stream`, `DELETE /voice/stream/:id`)
- Stream lifecycle auditing

Effort: **Multi-sprint.** This is the largest remaining feature domain.

---

## Workstream E — Validation/QA

### Done

- 43 host-mode unit tests across 11 test files
- Coverage: runtime state, transport, event loop, pipeline, renderer, display, drivers, UI, protocol

### Missing

| Gap | Impact | Effort |
|-----|--------|--------|
| Host-device integration tests | Can't test real protocol exchange | Blocked on host transport server |
| CI pipeline (GitHub Actions) | No automated build/test on push | Small — cargo test workflow for host features |
| ESP target build verification | Can't verify ESP compilation in CI | Medium — cross-compilation in CI with xtensa toolchain |
| HIL test harness | No on-device automated testing | Large — test runner, flash automation, serial assertion |
| Soak/stress tests | No long-running memory/queue drift validation | Medium — synthetic load generators with metric assertions |
| Security regression tests | No replay attack, cert mismatch, or privilege escalation tests | Medium — adversarial test fixtures |

---

## Conceptual Gaps (Architecture-Level)

### 1. The host doesn't exist

`microclaw-host` is a struct holding crate handles with no event loop, no transport server, no message routing. The device firmware has no counterpart to connect to. This is the single largest gap — everything downstream (integration tests, voice gateway, OTA delivery, provisioning) depends on a functioning host.

### 2. No rendering engine

The DisplaySceneRenderer fills the screen with solid colors. The UI mockups specify text, status bars, labeled buttons, conversation transcripts. Without a font renderer and layout system, the device screen shows nothing useful to a human. The GUI framework decision (Slint vs LVGL vs embedded-graphics) has not been made.

### 3. Boot-loop detection doesn't survive reboots

The entire boot-failure counting system (`boot_failure_count`, `boot_retry_limit`, safe-mode transition) only works within a single power cycle. On reboot, counters reset to 0. NVS persistence is required for this feature to function as designed.

### 4. Voice is an entire missing vertical

6 planned milestones, 7 planned modules, protocol extensions, UI bindings, and host gateway endpoints — all at 0% implementation. This represents roughly 40% of the planned device functionality.

### 5. No device identity or mutual authentication

The device connects to whatever URL is configured. The host allowlist is a string match on the `source` field — trivially spoofable over the wire. There's no mutual TLS, no provisioning challenge, no session tokens, no certificate exchange. The security model is placeholder-level.

### 6. OTA is bookkeeping without implementation

The runtime tracks OTA state (`ota_in_progress`, `ota_target_version`, `ota_error_reason`) and handles `OtaStart` commands, but there's no actual OTA: no image download, no partition switching (`esp_ota_ops`), no hash verification, no health check, no rollback. A real OTA command would set a flag and do nothing.

---

## Prioritized Next Steps

### Tier 1 — Critical path (enables everything else)

1. **Host transport server** — WebSocket listener in `microclaw-host` that sends HelloAck, heartbeats, routes commands, and serves status. Without this, the device has nowhere to connect.
2. **Persistent boot counters** — NVS read/write so boot-loop guard works across reboots.
3. **GUI framework decision + basic text rendering** — Pick framework and render at least boot status text on screen.

### Tier 2 — Required for real-device validation

4. ESP target build verification (CI or local toolchain)
5. TLS cert configuration for WsTransport
6. NVS storage for wifi/host config (replace env vars)
7. State reconciliation protocol (full snapshot request after reconnect)
8. Watchdog timer integration

### Tier 3 — Production hardening

9. OTA implementation (image staging, signature, health check, rollback)
10. Device provisioning/pairing flow
11. Signature/nonce verification on transport messages
12. Gesture filtering and dirty-rect rendering
13. Audit logging persistence

### Tier 4 — Full feature domains (multi-sprint each)

14. Voice subsystem (all 6 milestones)
15. Demo mode
16. HIL test infrastructure
17. Security regression test suite

---

## Bug Fixes Applied This Session

For reference, 6 bugs were found and fixed during this audit:

1. **`event_loop.rs`** — `step_with_transport_driver` overwrote LoopOutput, discarding transport recovery messages
2. **`runtime.rs`** — `emit_command` bumped shared `last_seq`, rejecting valid inbound host messages
3. **`transport.rs`** — WsTransport couldn't reconnect (dead socket handle never dropped)
4. **`main.rs`** — Use after move on `ws_url` in ESP path (compile error on ESP target)
5. **`runtime.rs`** — `mark_boot_failure` overwrote SafeMode with Offline
6. **`transport.rs`** — Duplicate `self.connected = ws.is_connected()` line

All fixes have regression tests. Total test count: 37 -> 43.
