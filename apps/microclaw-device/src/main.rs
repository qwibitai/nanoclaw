#[cfg(feature = "esp")]
use microclaw_device::renderer::DisplaySceneRenderer;
#[cfg(not(feature = "esp"))]
use microclaw_device::renderer::SceneRenderer;
#[cfg(not(feature = "esp"))]
use microclaw_device::transport::{InMemoryTransport, TransportBus};
#[cfg(feature = "esp")]
use microclaw_device::{
    drivers::esp::{EspDisplayDriver, EspTouchDriver},
    transport::{TransportBus, WsTransport},
};
use microclaw_device::{
    event_loop::{DeviceEventLoop, EventLoopConfig},
    now_ms,
    pipeline::TouchPipeline,
    protocol::{Envelope, MessageId, MessageKind, TouchEventPayload, TransportMessage},
    BootPhase, RuntimeMode, RuntimeState,
};
#[cfg(feature = "esp")]
use std::time::Duration;

#[cfg(not(feature = "esp"))]
fn parse_host_allowlist() -> Vec<String> {
    std::env::var("MICROCLAW_HOST_ALLOWLIST")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|host| !host.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[cfg(feature = "esp")]
fn parse_host_allowlist() -> Vec<String> {
    microclaw_device::esp_runtime::host_allowlist_from_env()
}

#[cfg(not(feature = "esp"))]
fn main() {
    use microclaw_device::drivers::host::HostDisplayDriver;
    use microclaw_device::renderer::SlintRenderer;
    use microclaw_device::slint_platform::MicroClawPlatform;

    BootPhase::Start.log();
    println!("{}", microclaw_device::boot_message());

    let allowlist = parse_host_allowlist();
    let mut state = if allowlist.is_empty() {
        RuntimeState::new()
    } else {
        RuntimeState::with_host_allowlist(allowlist)
    };
    state.set_device_id("device");
    let mut loop_state = DeviceEventLoop::new(EventLoopConfig {
        render_interval_ms: 250,
        offline_timeout_ms: 4_000,
        ..Default::default()
    });
    let mut pipeline = TouchPipeline::new();

    BootPhase::TransportInit.log();
    let mut transport = InMemoryTransport::new();
    transport.set_connected(true);
    transport.push_inbound(TransportMessage {
        envelope: Envelope::new(
            "host",
            "microclaw-device",
            "boot",
            MessageId::new("boot-hello"),
        ),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: Some(4_000),
        issued_at: Some(now_ms()),
        signature: None,
        nonce: None,
        payload: serde_json::json!({"device_id":"microclaw-device"}),
    });
    BootPhase::TransportReady.log();

    // Initialize Slint platform and renderer
    BootPhase::DisplayInit.log();
    let platform = MicroClawPlatform::new();
    let window = platform.window().clone();
    slint::platform::set_platform(Box::new(platform)).expect("Slint platform init failed");

    let display = HostDisplayDriver::new();
    let mut renderer = SlintRenderer::new(window, Box::new(display));
    BootPhase::DisplayReady.log();
    BootPhase::UiSceneReady.log();

    if let Some(point) = microclaw_device::display::clamp_and_validate_touch(180, 145) {
        pipeline.push_event(TouchEventPayload {
            pointer_id: 1,
            phase: microclaw_device::protocol::TouchPhase::Down,
            x: point.x,
            y: point.y,
            pressure: None,
            raw_timestamp_ms: Some(now_ms()),
        });
    }

    BootPhase::BootComplete.log();
    for tick in 0..5u64 {
        let now = now_ms().saturating_add(tick * 20);
        let out = loop_state.step_with_transport(
            &mut state,
            &mut pipeline,
            &mut transport,
            now,
            &mut renderer,
        );

        if matches!(state.mode(), RuntimeMode::Offline) {
            println!("offline at tick {tick}");
        }
        println!(
            "tick={tick} scene={:?} mode={:?} commands={} rendered={}",
            state.scene(),
            state.mode(),
            out.outbound.len(),
            out.rendered
        );
    }

    println!(
        "boot_failures={} in_flight={} rendered_frames={} outbound_frames={} transport_outbound_depth={}",
        state.boot_failure_count(),
        state.in_flight_count(),
        renderer.stats().scenes_rendered,
        transport.transport_stats().outbound_frames,
        transport.outbound_depth()
    );
}

#[cfg(feature = "esp")]
fn main() {
    BootPhase::Start.log();
    println!("{}", microclaw_device::boot_message());
    println!(
        "{} - using ESP feature hooks",
        microclaw_device::esp_feature_hint()
    );
    esp_idf_svc::sys::link_patches();
    let _ = esp_idf_svc::log::EspLogger::initialize_default();

    BootPhase::WifiInit.log();
    if let Err(error) = microclaw_device::esp_runtime::init_wifi() {
        BootPhase::Failed("wifi_init").log();
        println!("wifi init failed: {error:?}");
    } else {
        BootPhase::WifiReady.log();
    }

    let device_id =
        std::env::var("MICROCLAW_DEVICE_ID").unwrap_or_else(|_| "microclaw-device".to_string());

    let allowlist = parse_host_allowlist();
    let mut state = if allowlist.is_empty() {
        RuntimeState::new()
    } else {
        RuntimeState::with_host_allowlist(allowlist)
    };
    state.set_device_id(device_id.clone());
    let mut loop_state = DeviceEventLoop::new(EventLoopConfig {
        render_interval_ms: 250,
        offline_timeout_ms: 8_000,
        transport_reconnect_backoff_ms: 500,
        ..Default::default()
    });
    let mut pipeline = TouchPipeline::new();

    BootPhase::TransportInit.log();
    let ws_url =
        microclaw_device::esp_runtime::resolve_transport_url(&device_id).unwrap_or_else(|| {
            BootPhase::Failed("transport_url_not_configured").log();
            String::new()
        });
    let ws_url_empty = ws_url.is_empty();
    let mut transport = WsTransport::new(ws_url, device_id.clone());
    transport.set_connected(!ws_url_empty);
    BootPhase::TransportReady.log();

    BootPhase::DisplayInit.log();
    let display = EspDisplayDriver::new();
    let mut touch = EspTouchDriver::new();
    let mut renderer = DisplaySceneRenderer::new(display);
    BootPhase::DisplayReady.log();

    BootPhase::TouchInit.log();
    if let Err(error) = touch.init() {
        BootPhase::Failed("touch_init").log();
        println!("touch init failed: {error:?}");
    } else {
        BootPhase::TouchIrqReady.log();
    }

    BootPhase::UiSceneReady.log();
    BootPhase::BootComplete.log();

    loop {
        let now = now_ms();
        let _ = loop_state.step_with_transport_driver(
            &mut state,
            &mut pipeline,
            &mut transport,
            Some(&mut touch),
            now,
            &mut renderer,
        );
        std::thread::sleep(Duration::from_millis(16));
    }
}
