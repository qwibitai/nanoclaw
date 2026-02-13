use crate::drivers::TouchDriver;
use crate::pipeline::TouchPipeline;
use crate::renderer::SceneRenderer;
use crate::runtime::{RuntimeAction, RuntimeState};
use microclaw_protocol::TransportMessage;
use crate::pipeline::TOUCH_EVENT_STALE_MS;

#[derive(Clone, Debug)]
pub struct LoopOutput {
    pub outbound: Vec<TransportMessage>,
    pub ui_messages: Vec<&'static str>,
    pub rendered: bool,
    pub offline_entered: bool,
    pub in_safe_mode: bool,
}

impl LoopOutput {
    pub fn new() -> Self {
        Self {
            outbound: Vec::new(),
            ui_messages: Vec::new(),
            rendered: false,
            offline_entered: false,
            in_safe_mode: false,
        }
    }
}

#[derive(Debug)]
pub struct EventLoopConfig {
    pub render_interval_ms: u64,
    pub offline_timeout_ms: u64,
}

impl Default for EventLoopConfig {
    fn default() -> Self {
        Self {
            render_interval_ms: 250,
            offline_timeout_ms: 15_000,
        }
    }
}

pub struct DeviceEventLoop {
    config: EventLoopConfig,
    last_render_ms: Option<u64>,
    last_touch_ms: Option<u64>,
    scene_cache: Option<crate::ui::Scene>,
}

impl DeviceEventLoop {
    pub fn new(config: EventLoopConfig) -> Self {
        Self {
            config,
            last_render_ms: None,
            last_touch_ms: None,
            scene_cache: None,
        }
    }

    pub fn step<R: SceneRenderer>(
        &mut self,
        state: &mut RuntimeState,
        touch_pipeline: &mut TouchPipeline,
        inbound_transport: &[TransportMessage],
        now_ms: u64,
        renderer: &mut R,
    ) -> LoopOutput {
        self.step_with_touch_driver(
            state,
            touch_pipeline,
            None,
            inbound_transport,
            now_ms,
            renderer,
        )
    }

    pub fn step_with_touch_driver<R: SceneRenderer>(
        &mut self,
        state: &mut RuntimeState,
        touch_pipeline: &mut TouchPipeline,
        touch_driver: Option<&mut dyn TouchDriver>,
        inbound_transport: &[TransportMessage],
        now_ms: u64,
        renderer: &mut R,
    ) -> LoopOutput {
        let mut out = LoopOutput::new();
        let mut frame_dirty = false;

        for msg in inbound_transport {
            let action = state.apply_transport_message(msg);
            frame_dirty |= self.process_action(state, action, &mut out);
        }

        if let Some(driver) = touch_driver {
            let drained = touch_pipeline.drain_from_driver(driver);
            frame_dirty |= drained > 0;
        }
        touch_pipeline.purge_stale(now_ms, TOUCH_EVENT_STALE_MS, &mut self.last_touch_ms);

        while let Some(event) = touch_pipeline.next_frame() {
            let payload = microclaw_protocol::TouchEventPayload {
                pointer_id: 0,
                phase: event.phase,
                x: event.point.x,
                y: event.point.y,
                pressure: None,
                raw_timestamp_ms: None,
            };
            let action = state.apply_touch_event(&payload);
            frame_dirty |= self.process_action(state, action, &mut out);
            self.last_touch_ms = Some(now_ms);
        }

        if state.mark_offline_if_stale(now_ms, self.config.offline_timeout_ms) {
            frame_dirty = true;
            out.offline_entered = true;
            out.ui_messages.push("offline_timeout");
        }

        if state.safety_lockdown_check() {
            frame_dirty = true;
            out.in_safe_mode = true;
            out.ui_messages.push("safety_lockdown");
        }

        let target_scene = state.scene();
        let force_render = self.last_render_ms.map_or(true, |last| {
            now_ms.saturating_sub(last) >= self.config.render_interval_ms
        }) || self.scene_cache != Some(target_scene)
            || frame_dirty;
        if force_render {
            out.rendered = renderer.render(state, now_ms);
            self.last_render_ms = Some(now_ms);
            self.scene_cache = Some(target_scene);
        }

        if out.in_safe_mode {
            self.scene_cache = Some(target_scene);
        }

        out
    }

    fn process_action(
        &mut self,
        state: &mut RuntimeState,
        action: RuntimeAction,
        out: &mut LoopOutput,
    ) -> bool {
        match action {
            RuntimeAction::None => false,
            RuntimeAction::EmitAck { status, .. } => {
                out.ui_messages.push(status);
                false
            }
            RuntimeAction::EmitCommand { action } => {
                let cmd = state.emit_command(action);
                out.outbound.push(cmd);
                out.ui_messages.push("emit_command");
                true
            }
            RuntimeAction::RaiseUiState { message } => {
                out.ui_messages.push(message);
                true
            }
        }
    }
}
