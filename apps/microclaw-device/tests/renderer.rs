use microclaw_device::drivers::{DisplayDriver, DriverError, Rect};
use microclaw_device::drivers::host::HostDisplayDriver;
use microclaw_device::renderer::{DisplaySceneRenderer, SceneRenderer, SlintRenderer};
use microclaw_device::slint_platform::MicroClawPlatform;
use microclaw_device::{drivers::DisplayRotation, RuntimeMode, RuntimeState};
use microclaw_protocol::{Envelope, MessageId, MessageKind, TransportMessage};

struct ProbeDisplay {
    inited: bool,
    flush_calls: usize,
    last_region: Option<Rect>,
    last_frame_len: usize,
    brightness: Option<u8>,
    width: u16,
    height: u16,
    rotated: DisplayRotation,
}

impl ProbeDisplay {
    fn new() -> Self {
        Self::default()
    }

    fn default() -> Self {
        Self {
            inited: false,
            flush_calls: 0,
            last_region: None,
            last_frame_len: 0,
            brightness: None,
            width: 360,
            height: 360,
            rotated: DisplayRotation::Portrait,
        }
    }
}

impl DisplayDriver for ProbeDisplay {
    fn init(&mut self) -> Result<(), DriverError> {
        self.inited = true;
        Ok(())
    }

    fn deinit(&mut self) -> Result<(), DriverError> {
        self.inited = false;
        Ok(())
    }

    fn width(&self) -> u16 {
        self.width
    }

    fn height(&self) -> u16 {
        self.height
    }

    fn rotation(&self) -> DisplayRotation {
        self.rotated
    }

    fn set_brightness(&mut self, level: u8) -> Result<(), DriverError> {
        if !self.inited {
            return Err(DriverError::NotInitialized);
        }
        self.brightness = Some(level);
        Ok(())
    }

    fn flush_region(&mut self, region: Rect, data: &[u16]) -> Result<(), DriverError> {
        self.flush_calls = self.flush_calls.saturating_add(1);
        self.last_region = Some(region);
        self.last_frame_len = data.len();
        Ok(())
    }
}

#[test]
fn display_scene_renderer_paints_frames_for_scene_transitions() {
    let display = ProbeDisplay::new();
    let mut renderer = DisplaySceneRenderer::new(display);
    let mut state = RuntimeState::new();

    assert!(renderer.render(&state, 0));
    assert_eq!(renderer.stats().frames_requested, 1);
    assert_eq!(renderer.stats().scenes_rendered, 1);

    assert_eq!(renderer.render(&state, 1), false);
    assert_eq!(renderer.render(&state, 2), false);

    state.apply_transport_message(&TransportMessage {
        envelope: Envelope::new(
            "host",
            "microclaw-device",
            "boot",
            MessageId::new("connected"),
        ),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    });
    assert_eq!(state.mode(), &RuntimeMode::Connected);
    assert_eq!(renderer.render(&state, 3), true);
    assert_eq!(renderer.stats().scenes_rendered, 2);
}

#[test]
fn display_scene_renderer_tracks_flush_payload_size() {
    let display = ProbeDisplay::new();
    let mut renderer = DisplaySceneRenderer::new(display);
    let state = RuntimeState::new();
    renderer.render(&state, 0);
    assert!(renderer.stats().scenes_rendered >= 1);
    assert!(renderer.stats().scenes_rendered <= renderer.stats().frames_requested);
}

#[test]
fn slint_renderer_renders_scenes_and_tracks_transitions() {
    // set_platform can only be called once per process, so this single test
    // covers construction, scene changes, and touch dispatch.
    let platform = MicroClawPlatform::new();
    let window = platform.window().clone();
    slint::platform::set_platform(Box::new(platform)).expect("platform init");

    let display = HostDisplayDriver::new();
    let mut renderer = SlintRenderer::new(window.clone(), Box::new(display));
    let mut state = RuntimeState::new();

    // Initial render (Boot scene)
    let drew = renderer.render(&state, 0);
    assert!(drew, "first render should draw");
    assert_eq!(renderer.stats().frames_requested, 1);
    assert!(renderer.stats().scenes_rendered >= 1);

    // Transition to Connected -> Paired scene
    state.apply_transport_message(&TransportMessage {
        envelope: Envelope::new(
            "host",
            "microclaw-device",
            "boot",
            MessageId::new("connected"),
        ),
        kind: MessageKind::HelloAck,
        corr_id: None,
        ttl_ms: None,
        issued_at: Some(0),
        signature: None,
        nonce: None,
        payload: serde_json::json!({}),
    });
    assert_eq!(state.mode(), &RuntimeMode::Connected);

    let drew = renderer.render(&state, 100);
    assert!(drew, "scene transition should draw");

    // Touch dispatch doesn't panic
    let touch_event = slint::platform::WindowEvent::PointerPressed {
        position: slint::LogicalPosition::new(180.0, 145.0),
        button: slint::platform::PointerEventButton::Left,
    };
    microclaw_device::slint_platform::dispatch_touch(&window, touch_event);

    let release_event = slint::platform::WindowEvent::PointerReleased {
        position: slint::LogicalPosition::new(180.0, 145.0),
        button: slint::platform::PointerEventButton::Left,
    };
    microclaw_device::slint_platform::dispatch_touch(&window, release_event);

    // Touch conversion utility
    let payload = microclaw_protocol::TouchEventPayload {
        pointer_id: 0,
        phase: microclaw_protocol::TouchPhase::Down,
        x: 180,
        y: 145,
        pressure: None,
        raw_timestamp_ms: None,
    };
    let event = microclaw_device::slint_platform::touch_to_window_event(&payload);
    assert!(event.is_some(), "Down phase should produce a window event");

    let cancel_payload = microclaw_protocol::TouchEventPayload {
        pointer_id: 0,
        phase: microclaw_protocol::TouchPhase::Cancel,
        x: 0,
        y: 0,
        pressure: None,
        raw_timestamp_ms: None,
    };
    let event = microclaw_device::slint_platform::touch_to_window_event(&cancel_payload);
    assert!(event.is_none(), "Cancel phase should return None");
}
