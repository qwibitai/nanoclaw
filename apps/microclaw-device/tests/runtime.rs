use microclaw_device::{now_ms, protocol::*, AgentActivity, RuntimeAction, RuntimeMode, RuntimeState};
use microclaw_device::pipeline::{SwipeDetector, SwipeDirection};
use microclaw_device::ui::Scene;
use microclaw_protocol::TouchEventPayload;
use serde_json::json;

#[test]
fn accepts_hello_ack_and_moves_connected() {
    let mut state = RuntimeState::new();
    let msg = TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("m1")),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: json!({}),
    };

    let action = state.apply_transport_message(&msg);
    assert!(matches!(state.mode(), RuntimeMode::Connected));
    assert!(matches!(
        action,
        RuntimeAction::RaiseUiState {
            message: "connected"
        }
    ));
}

#[test]
fn command_frames_are_created_with_in_flight_tracking() {
    let mut state = RuntimeState::new();
    let cmd = state.emit_command(DeviceAction::StatusGet);
    assert_eq!(cmd.kind, MessageKind::Command);
    assert_eq!(state.in_flight_count(), 1);
    assert!(cmd.corr_id.is_some());
}

#[test]
fn duplicate_message_ids_are_rejected() {
    let mut state = RuntimeState::new();
    let mut msg = TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("dup-1")),
        kind: MessageKind::StatusDelta,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: json!({"connected":true}),
    };

    let first = state.apply_transport_message(&msg);
    assert!(matches!(
        first,
        RuntimeAction::RaiseUiState {
            message: "status_updated"
        }
    ));

    msg.envelope.seq = msg.envelope.seq.max(2);
    let second = state.apply_transport_message(&msg);
    assert!(matches!(
        second,
        RuntimeAction::RaiseUiState {
            message: "replay_or_duplicate_rejected"
        }
    ));
}

#[test]
fn touch_events_drive_scene_action() {
    let mut state = RuntimeState::new();

    let offscreen = TouchEventPayload {
        phase: microclaw_protocol::TouchPhase::Down,
        pointer_id: 1,
        x: 1,
        y: 1,
        pressure: None,
        raw_timestamp_ms: None,
    };
    assert!(matches!(
        state.apply_touch_event(&offscreen),
        RuntimeAction::None
    ));

    let on_screen = TouchEventPayload {
        phase: microclaw_protocol::TouchPhase::Down,
        pointer_id: 1,
        x: 150,
        y: 300,
        pressure: None,
        raw_timestamp_ms: None,
    };
    assert!(matches!(
        state.apply_touch_event(&on_screen),
        RuntimeAction::EmitCommand {
            action: microclaw_protocol::DeviceAction::Retry
        }
    ));
}

#[test]
fn status_snapshot_updates_wifi_state_and_mode() {
    let mut state = RuntimeState::new();
    let status = TransportMessage {
        envelope: Envelope::new(
            "host",
            "microclaw-device",
            "boot",
            MessageId::new("status-1"),
        ),
        kind: MessageKind::StatusSnapshot,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: json!({
            "wifi_ok": true,
            "host_reachable": true,
            "mode": "ready",
            "scene": "connected",
            "ota_state": "active"
        }),
    };

    let action = state.apply_transport_message(&status);
    assert!(matches!(
        action,
        RuntimeAction::RaiseUiState {
            message: "status_updated"
        }
    ));
    assert_eq!(state.status().mode.as_deref(), Some("ready"));
    assert_eq!(state.status().ota_state.as_deref(), Some("active"));
}

#[test]
fn unauthorized_host_messages_increment_safety_and_deny() {
    let mut state = RuntimeState::with_host_allowlist(["trusted-host"]);
    let status = TransportMessage {
        envelope: Envelope::new("evil-host", "microclaw-device", "boot", MessageId::new("x")),
        kind: MessageKind::HostCommand,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: json!({"action":"restart"}),
    };

    let action = state.apply_transport_message(&status);
    assert!(matches!(
        action,
        RuntimeAction::RaiseUiState {
            message: "command_denied_unauthorized_source"
        }
    ));
    assert_eq!(state.safety_fail_count(), 1);
    assert!(!state.safety_lockdown_check());
}

#[test]
fn ota_start_marks_ota_in_progress() {
    let mut state = RuntimeState::new();
    let cmd = TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("ota-1")),
        kind: MessageKind::Command,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: json!({
            "action":"ota_start",
            "args":{"version":"1.2.3"}
        }),
    };

    let action = state.apply_transport_message(&cmd);
    assert!(matches!(
        action,
        RuntimeAction::RaiseUiState {
            message: "command_ota_start"
        }
    ));
    assert!(state.ota_in_progress());
    assert_eq!(state.ota_target_version(), Some("1.2.3"));
}

#[test]
fn stale_heartbeat_marks_offline_after_timeout() {
    let mut state = RuntimeState::new();
    state.apply_transport_message(&TransportMessage {
        envelope: Envelope::new(
            "host",
            "microclaw-device",
            "boot",
            MessageId::new("connect"),
        ),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: json!({}),
    });

    state.apply_transport_message(&TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("hb")),
        kind: MessageKind::Heartbeat,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(10),
        signature: None,
        nonce: None,
        payload: json!({}),
    });

    assert!(!state.mark_offline_if_stale(50, 100));
    assert!(matches!(
        state.mode(),
        microclaw_device::RuntimeMode::Connected
    ));

    assert!(state.mark_offline_if_stale(200, 100));
    assert!(matches!(
        state.mode(),
        microclaw_device::RuntimeMode::Offline
    ));
}

#[test]
fn stale_inflight_commands_are_reclaimed_with_safety_bump() {
    let mut state = RuntimeState::new();
    state.apply_transport_message(&TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("hello")),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    });

    let now = now_ms();
    let cmd = state.emit_command(microclaw_protocol::DeviceAction::StatusGet);
    assert_eq!(state.in_flight_count(), 1);
    assert!(cmd.issued_at.is_some());

    let reclaimed = state.reclaim_stale_inflight(now.saturating_add(10_000), 1);
    assert_eq!(reclaimed, 1);
    assert_eq!(state.in_flight_count(), 0);
    assert!(state.safety_fail_count() > 0);

    let cmd_result = state.emit_command(microclaw_protocol::DeviceAction::Restart);
    assert!(cmd_result.corr_id.is_some());
    assert_eq!(state.in_flight_count(), 1);
}

// --- Regression tests for bug fixes ---

#[test]
fn emit_command_does_not_reject_subsequent_inbound_messages() {
    // Bug: emit_command was bumping last_seq (shared with inbound dedup),
    // causing valid host messages to be rejected as "stale".
    let mut state = RuntimeState::new();

    // Accept initial hello (seq=1)
    state.apply_transport_message(&TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("hello")),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: json!({}),
    });

    // Emit several outbound commands (these should NOT affect inbound seq tracking)
    state.emit_command(DeviceAction::StatusGet);
    state.emit_command(DeviceAction::StatusGet);
    state.emit_command(DeviceAction::StatusGet);

    // Inbound message with seq=2 should still be accepted
    let action = state.apply_transport_message(&TransportMessage {
        envelope: {
            let mut e = Envelope::new("host", "microclaw-device", "boot", MessageId::new("hb-1"));
            e.seq = 2;
            e
        },
        kind: MessageKind::Heartbeat,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(100),
        signature: None,
        nonce: None,
        payload: json!({}),
    });
    // Must NOT be rejected as replay/stale
    assert!(
        !matches!(
            action,
            RuntimeAction::RaiseUiState {
                message: "replay_or_duplicate_rejected"
            }
        ),
        "inbound message rejected after emit_command bumped seq"
    );
    assert!(matches!(state.mode(), RuntimeMode::Connected));
}

#[test]
fn mark_boot_failure_preserves_safe_mode_when_threshold_exceeded() {
    // Bug: mark_boot_failure set SafeMode then immediately called
    // mark_offline_with_reason which overwrote it to Offline.
    let mut state = RuntimeState::new();

    // Trigger 3 boot failures (default boot_retry_limit is 3)
    state.mark_boot_failure(100, "fail-1");
    state.mark_boot_failure(200, "fail-2");
    state.mark_boot_failure(300, "fail-3");

    // After exceeding the limit, mode must be SafeMode, not Offline
    assert!(
        matches!(state.mode(), RuntimeMode::SafeMode(_)),
        "expected SafeMode after exceeding boot retry limit, got {:?}",
        state.mode()
    );
    assert_eq!(state.boot_failure_count(), 3);
}

#[test]
fn mark_boot_failure_below_threshold_goes_offline() {
    let mut state = RuntimeState::new();

    state.mark_boot_failure(100, "fail-1");
    // Below threshold (3), should go to Error then Offline
    assert!(
        matches!(state.mode(), RuntimeMode::Offline),
        "expected Offline below boot retry limit, got {:?}",
        state.mode()
    );
    assert_eq!(state.boot_failure_count(), 1);
}

#[test]
fn expired_ttl_messages_are_rejected() {
    let mut state = RuntimeState::new();
    // Message issued at t=0 with TTL of 100ms, but current time is well past that
    let msg = TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("old-1")),
        kind: MessageKind::Heartbeat,
        corr_id: None,
        ttl_ms: Some(100),
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: json!({}),
    };

    // now_ms() is always >> 100, so this message is expired
    let action = state.apply_transport_message(&msg);
    assert!(
        matches!(
            action,
            RuntimeAction::RaiseUiState {
                message: "message_expired_ttl"
            }
        ),
        "expected expired TTL rejection, got {:?}",
        action
    );
}

#[test]
fn messages_without_ttl_are_not_expired() {
    let mut state = RuntimeState::new();
    // No TTL set - should never expire
    let msg = TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("no-ttl")),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: json!({}),
    };

    let action = state.apply_transport_message(&msg);
    assert!(
        matches!(
            action,
            RuntimeAction::RaiseUiState {
                message: "connected"
            }
        ),
        "message without TTL should not be rejected"
    );
}

#[test]
fn agent_activity_transitions_scene() {
    let mut state = RuntimeState::new();
    // Connect first
    state.apply_transport_message(&TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("m-connect")),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    });
    assert_eq!(state.scene(), Scene::Paired);

    // Set thinking
    state.set_agent_activity(Some(AgentActivity::Thinking));
    assert_eq!(state.scene(), Scene::AgentThinking);

    // Set streaming
    state.set_agent_activity(Some(AgentActivity::Streaming {
        partial_text: String::new(),
    }));
    assert_eq!(state.scene(), Scene::AgentStreaming);

    // Set task progress
    state.set_agent_activity(Some(AgentActivity::TaskProgress {
        task_name: "Searching".to_string(),
        current: 3,
        total: 7,
        step_label: Some("Pattern matching".to_string()),
    }));
    assert_eq!(state.scene(), Scene::AgentTaskProgress);

    // Clear activity
    state.set_agent_activity(None);
    assert_eq!(state.scene(), Scene::Paired);
}

#[test]
fn swipe_gesture_detects_horizontal_swipe() {
    let mut detector = SwipeDetector::new();

    // Simulate swipe right: down at x=100, move to x=180, up
    assert_eq!(detector.on_down(100, 180), None);
    assert_eq!(detector.on_move(140, 180), None);
    assert_eq!(detector.on_up(180, 182), Some(SwipeDirection::Right));

    // Simulate swipe left: down at x=200, move to x=120, up
    assert_eq!(detector.on_down(200, 180), None);
    assert_eq!(detector.on_up(120, 178), Some(SwipeDirection::Left));

    // Too short horizontal movement (only 20px)
    assert_eq!(detector.on_down(100, 180), None);
    assert_eq!(detector.on_up(120, 180), None);

    // Too much vertical movement (diagonal)
    assert_eq!(detector.on_down(100, 100), None);
    assert_eq!(detector.on_up(180, 180), None);
}
