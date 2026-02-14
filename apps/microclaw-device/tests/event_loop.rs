use microclaw_device::{
    drivers,
    event_loop::{DeviceEventLoop, EventLoopConfig},
    pipeline::TouchPipeline,
    protocol::{Envelope, MessageId, MessageKind, TouchEventPayload, TransportMessage},
    renderer::NullRenderer,
    RuntimeMode, RuntimeState,
};

#[test]
fn loop_executes_touch_and_transport_into_outbound_commands() {
    let mut state = RuntimeState::new();
    let mut runtime_loop = DeviceEventLoop::new(EventLoopConfig {
        render_interval_ms: 100,
        offline_timeout_ms: 60_000,
        ..Default::default()
    });
    let mut renderer = NullRenderer::new();
    let mut pipeline = TouchPipeline::new();

    pipeline.push_event(TouchEventPayload {
        pointer_id: 1,
        phase: microclaw_protocol::TouchPhase::Down,
        x: 180,
        y: 150,
        pressure: None,
        raw_timestamp_ms: Some(123),
    });

    let hello = TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("hello")),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    };

    let out = runtime_loop.step(
        &mut state,
        &mut pipeline,
        std::slice::from_ref(&hello),
        100,
        &mut renderer,
    );

    assert!(matches!(state.mode(), RuntimeMode::Connected));
    assert_eq!(out.outbound.len(), 1);
    assert!(matches!(out.outbound[0].kind, MessageKind::Command));
    assert!(out.rendered);
}

#[test]
fn loop_reports_offline_when_heartbeat_stale() {
    let mut state = RuntimeState::new();
    let mut runtime_loop = DeviceEventLoop::new(EventLoopConfig {
        render_interval_ms: 100,
        offline_timeout_ms: 50,
        ..Default::default()
    });
    let mut renderer = NullRenderer::new();
    let mut pipeline = TouchPipeline::new();

    state.apply_transport_message(&TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("hb")),
        kind: MessageKind::Heartbeat,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(1),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    });
    let out = runtime_loop.step(&mut state, &mut pipeline, &[], 200, &mut renderer);

    assert!(out.offline_entered);
    assert!(matches!(state.mode(), RuntimeMode::Offline));
    assert!(out.ui_messages.contains(&"offline_timeout"));
}

#[cfg(not(feature = "esp"))]
#[test]
fn loop_drain_touch_driver_events_into_frame() {
    let mut state = RuntimeState::new();
    let mut runtime_loop = DeviceEventLoop::new(EventLoopConfig {
        render_interval_ms: 100,
        offline_timeout_ms: 60_000,
        ..Default::default()
    });
    let mut renderer = NullRenderer::new();
    let mut pipeline = TouchPipeline::new();
    let mut driver = drivers::host::HostTouchDriver::new();

    driver.push_payload(TouchEventPayload {
        pointer_id: 1,
        phase: microclaw_protocol::TouchPhase::Down,
        x: 180,
        y: 150,
        pressure: None,
        raw_timestamp_ms: None,
    });

    let hello = TransportMessage {
        envelope: Envelope::new("host", "microclaw-device", "boot", MessageId::new("hello")),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    };

    let out = runtime_loop.step_with_touch_driver(
        &mut state,
        &mut pipeline,
        Some(&mut driver),
        std::slice::from_ref(&hello),
        100,
        &mut renderer,
    );

    assert!(matches!(state.mode(), RuntimeMode::Connected));
    assert_eq!(out.outbound.len(), 1);
    assert!(matches!(out.outbound[0].kind, MessageKind::Command));
    assert!(matches!(out.ui_messages.last(), Some(&"emit_command")));
}
