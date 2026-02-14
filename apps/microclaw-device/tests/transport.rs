use microclaw_device::{
    event_loop::{DeviceEventLoop, EventLoopConfig},
    now_ms,
    pipeline::TouchPipeline,
    protocol::{Envelope, MessageId, MessageKind},
    protocol::{TouchEventPayload, TransportMessage},
    renderer::NullRenderer,
    transport::{InMemoryTransport, TransportBus},
    RuntimeMode, RuntimeState,
};

#[test]
fn in_memory_transport_buffers_inbound_and_outbound_with_cap() {
    let mut transport = InMemoryTransport::with_queue_depth(2, 2);
    transport.set_connected(true);
    transport.push_inbound(TransportMessage {
        envelope: Envelope::new("host", "dev", "boot", MessageId::new("1")),
        kind: MessageKind::Hello,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: serde_json::json!({"kind":"discard"}),
    });
    transport.send_frame(TransportMessage {
        envelope: Envelope::new("host", "dev", "boot", MessageId::new("2")),
        kind: MessageKind::Hello,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    });
    transport.send_frame(TransportMessage {
        envelope: Envelope::new("host", "dev", "boot", MessageId::new("3")),
        kind: MessageKind::Hello,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    });
    transport.send_frame(TransportMessage {
        envelope: Envelope::new("host", "dev", "boot", MessageId::new("4")),
        kind: MessageKind::Hello,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    });

    assert_eq!(transport.inbound_depth(), 1);
    assert_eq!(transport.outbound_depth(), 2);
    assert_eq!(transport.transport_stats().dropped_outbound, 1);
}

#[test]
fn event_loop_dispatches_messages_via_transport() {
    let mut state = RuntimeState::new();
    let mut transport = InMemoryTransport::new();
    transport.set_connected(true);
    transport.push_inbound(TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("hello")),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(now_ms()),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    });

    let mut loop_state = DeviceEventLoop::new(EventLoopConfig {
        render_interval_ms: 50,
        offline_timeout_ms: 60_000,
        ..Default::default()
    });
    let mut pipeline = TouchPipeline::new();
    let mut renderer = NullRenderer::new();
    pipeline.push_event(TouchEventPayload {
        phase: microclaw_protocol::TouchPhase::Down,
        pointer_id: 1,
        x: 180,
        y: 150,
        pressure: None,
        raw_timestamp_ms: Some(now_ms()),
    });

    let out = loop_state.step_with_transport(
        &mut state,
        &mut pipeline,
        &mut transport,
        now_ms(),
        &mut renderer,
    );

    assert!(matches!(
        state.mode(),
        microclaw_device::RuntimeMode::Connected
    ));
    assert_eq!(transport.transport_stats().outbound_frames, 1);
    assert!(out.ui_messages.iter().any(|m| *m == "emit_command"));
    assert!(matches!(
        out.ui_messages.last(),
        Some(&"transport_step_completed")
    ));
}

#[test]
fn event_loop_reclaims_stale_inflight_for_safety() {
    let mut state = RuntimeState::new();
    let mut transport = InMemoryTransport::new();
    transport.set_connected(true);
    transport.push_inbound(TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("hello")),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(now_ms()),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    });
    let mut loop_state = DeviceEventLoop::new(EventLoopConfig {
        stale_inflight_ms: 1,
        ..Default::default()
    });
    let mut pipeline = TouchPipeline::new();
    let mut renderer = NullRenderer::new();

    state.emit_command(microclaw_protocol::DeviceAction::StatusGet);
    assert_eq!(state.in_flight_count(), 1);

    let out = loop_state.step_with_transport(
        &mut state,
        &mut pipeline,
        &mut transport,
        now_ms().saturating_add(10),
        &mut renderer,
    );

    assert_eq!(state.in_flight_count(), 0);
    assert!(out.stale_inflight_reclaimed > 0);
    assert!(out
        .ui_messages
        .iter()
        .any(|message| *message == "stale_inflight_reclaimed"));
    assert!(out
        .ui_messages
        .iter()
        .any(|message| *message == "transport_step_completed"));
}

#[test]
fn transport_reconnect_uses_backoff_and_attempt_count() {
    let mut state = RuntimeState::new();
    let mut transport = InMemoryTransport::new();
    transport.set_connected(false);
    transport.set_reconnect_failures_until_success(1);
    let mut loop_state = DeviceEventLoop::new(EventLoopConfig {
        transport_reconnect_backoff_ms: 200,
        ..Default::default()
    });
    let mut pipeline = TouchPipeline::new();
    let mut renderer = NullRenderer::new();
    let start = now_ms();

    let out = loop_state.step_with_transport(
        &mut state,
        &mut pipeline,
        &mut transport,
        start,
        &mut renderer,
    );
    assert!(!out.transport_connected);
    assert!(transport.reconnect_attempts() >= 1);
    assert_eq!(transport.reconnect_attempts(), 1);
    assert!(matches!(
        state.mode(),
        microclaw_device::RuntimeMode::Offline
    ));

    let no_retry = loop_state.step_with_transport(
        &mut state,
        &mut pipeline,
        &mut transport,
        start.saturating_add(100),
        &mut renderer,
    );
    assert_eq!(transport.reconnect_attempts(), 1);
    assert!(no_retry
        .ui_messages
        .iter()
        .any(|message| *message == "transport_reconnect_failed"
            || *message == "transport_step_disconnected"));

    let out = loop_state.step_with_transport(
        &mut state,
        &mut pipeline,
        &mut transport,
        start.saturating_add(300),
        &mut renderer,
    );
    assert!(out.transport_connected);
    assert!(out
        .ui_messages
        .iter()
        .any(|message| *message == "transport_connected"));
    assert_eq!(transport.reconnect_attempts(), 2);
    assert!(matches!(
        state.mode(),
        microclaw_device::RuntimeMode::Connected
    ));
}

#[test]
fn transport_recovery_messages_preserved_in_loop_output() {
    // Bug: step_with_transport_driver was overwriting LoopOutput,
    // losing all messages from service_transport_recovery.
    let mut state = RuntimeState::new();
    let mut transport = InMemoryTransport::new();
    transport.set_connected(false);
    // Will fail first attempt, succeed second
    transport.set_reconnect_failures_until_success(0);

    let mut loop_state = DeviceEventLoop::new(EventLoopConfig {
        transport_reconnect_backoff_ms: 100,
        ..Default::default()
    });
    let mut pipeline = TouchPipeline::new();
    let mut renderer = NullRenderer::new();

    let out = loop_state.step_with_transport(
        &mut state,
        &mut pipeline,
        &mut transport,
        now_ms(),
        &mut renderer,
    );

    // Recovery message from service_transport_recovery must survive
    assert!(
        out.ui_messages
            .iter()
            .any(|m| *m == "transport_reconnect_success"),
        "recovery message lost: {:?}",
        out.ui_messages
    );
}

#[test]
fn reconnect_emits_snapshot_request_and_sets_pending_reconciliation() {
    let mut state = RuntimeState::new();
    let mut transport = InMemoryTransport::new();
    transport.set_connected(false);
    transport.set_reconnect_failures_until_success(0);

    let mut loop_state = DeviceEventLoop::new(EventLoopConfig {
        transport_reconnect_backoff_ms: 100,
        ..Default::default()
    });
    let mut pipeline = TouchPipeline::new();
    let mut renderer = NullRenderer::new();

    assert!(!state.pending_reconciliation());

    let out = loop_state.step_with_transport(
        &mut state,
        &mut pipeline,
        &mut transport,
        now_ms(),
        &mut renderer,
    );

    // Should have sent a SnapshotRequest after reconnecting
    assert!(
        out.ui_messages
            .iter()
            .any(|m| *m == "snapshot_request_sent"),
        "snapshot_request_sent not found: {:?}",
        out.ui_messages
    );
    assert!(state.pending_reconciliation());

    // SnapshotRequest should have been sent as an outbound frame
    assert!(
        transport.outbound_depth() >= 1,
        "expected at least 1 outbound frame (SnapshotRequest)"
    );
}

#[test]
fn status_snapshot_clears_pending_reconciliation() {
    let mut state = RuntimeState::new();

    // Emit a snapshot request to set pending_reconciliation
    let _req = state.emit_snapshot_request();
    assert!(state.pending_reconciliation());

    // Receiving a StatusSnapshot should clear the flag
    let snapshot = TransportMessage {
        envelope: Envelope::new("host", "device", "boot", MessageId::new("snap-1")),
        kind: MessageKind::StatusSnapshot,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(now_ms()),
        signature: None,
        nonce: None,
        payload: serde_json::json!({
            "wifi_ok": true,
            "host_reachable": true,
            "mode": "connected"
        }),
    };

    let action = state.apply_transport_message(&snapshot);
    assert!(!state.pending_reconciliation());
    assert!(matches!(
        action,
        microclaw_device::RuntimeAction::RaiseUiState {
            message: "status_updated"
        }
    ));
    assert!(matches!(state.mode(), RuntimeMode::Connected));
}

#[test]
fn status_delta_does_not_clear_pending_reconciliation() {
    let mut state = RuntimeState::new();
    let _req = state.emit_snapshot_request();
    assert!(state.pending_reconciliation());

    // A delta should NOT clear reconciliation (we need the full snapshot)
    let delta = TransportMessage {
        envelope: Envelope::new("host", "device", "boot", MessageId::new("delta-1")),
        kind: MessageKind::StatusDelta,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(now_ms()),
        signature: None,
        nonce: None,
        payload: serde_json::json!({"mode": "connected"}),
    };

    state.apply_transport_message(&delta);
    assert!(
        state.pending_reconciliation(),
        "StatusDelta should not clear pending_reconciliation"
    );
}
