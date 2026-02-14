use std::rc::Rc;

use slint::platform::software_renderer::{MinimalSoftwareWindow, Rgb565Pixel};

use crate::drivers::{DisplayDriver, Rect};
use crate::runtime::RuntimeState;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderStats {
    pub frames_requested: u64,
    pub scenes_rendered: u64,
}

impl RenderStats {
    pub fn new() -> Self {
        Self {
            frames_requested: 0,
            scenes_rendered: 0,
        }
    }
}

impl Default for RenderStats {
    fn default() -> Self {
        Self::new()
    }
}

pub trait SceneRenderer {
    fn render(&mut self, state: &RuntimeState, now_ms: u64) -> bool;
    fn stats(&self) -> &RenderStats;
}

pub struct NullRenderer {
    current_scene: Option<crate::ui::Scene>,
    stats_: RenderStats,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SceneFramePlan {
    background: u16,
    accent: u16,
}

impl SceneFramePlan {
    fn for_scene(scene: crate::ui::Scene) -> Self {
        match scene {
            crate::ui::Scene::Boot => Self {
                background: 0x001F,
                accent: 0xF800,
            },
            crate::ui::Scene::Paired => Self {
                background: 0x07E0,
                accent: 0x001F,
            },
            crate::ui::Scene::Conversation => Self {
                background: 0xFFFF,
                accent: 0x0000,
            },
            crate::ui::Scene::Settings => Self {
                background: 0x4A49,
                accent: 0xFFFF,
            },
            crate::ui::Scene::Error => Self {
                background: 0xF800,
                accent: 0xFFFF,
            },
            crate::ui::Scene::Offline => Self {
                background: 0x5AEB,
                accent: 0xFFFF,
            },
        }
    }
}

impl NullRenderer {
    pub fn new() -> Self {
        Self {
            current_scene: None,
            stats_: RenderStats::new(),
        }
    }
}

impl Default for NullRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl SceneRenderer for NullRenderer {
    fn render(&mut self, state: &RuntimeState, _now_ms: u64) -> bool {
        self.stats_.frames_requested = self.stats_.frames_requested.saturating_add(1);
        let target = state.scene();
        if self.current_scene != Some(target) {
            self.current_scene = Some(target);
            self.stats_.scenes_rendered = self.stats_.scenes_rendered.saturating_add(1);
            return true;
        }
        false
    }

    fn stats(&self) -> &RenderStats {
        &self.stats_
    }
}

pub struct DisplaySceneRenderer<D: DisplayDriver> {
    display: D,
    current_scene: Option<crate::ui::Scene>,
    stats_: RenderStats,
    force_next_render: bool,
    framebuffer: Vec<u16>,
    queued_feedback: u16,
}

impl<D: DisplayDriver> DisplaySceneRenderer<D> {
    pub fn new(mut display: D) -> Self {
        let _ = display.init();
        let _ = display.set_brightness(128);
        let width = usize::from(display.width());
        let height = usize::from(display.height());
        let framebuffer = vec![0u16; width.saturating_mul(height)];
        Self {
            display,
            current_scene: None,
            stats_: RenderStats::new(),
            force_next_render: true,
            framebuffer,
            queued_feedback: 0,
        }
    }

    pub fn force_render_once(&mut self) {
        self.force_next_render = true;
    }

    pub fn queue_scene_action_indicator(&mut self) {
        self.queued_feedback = self.queued_feedback.saturating_add(1);
    }
}

impl<D: DisplayDriver> SceneRenderer for DisplaySceneRenderer<D> {
    fn render(&mut self, state: &RuntimeState, _now_ms: u64) -> bool {
        self.stats_.frames_requested = self.stats_.frames_requested.saturating_add(1);
        let target = state.scene();
        let show_feedback = self.queued_feedback > 0;
        self.queued_feedback = 0;
        if self.force_next_render || self.current_scene != Some(target) {
            let width = self.display.width();
            let height = self.display.height();
            let width_usize = usize::from(width);
            let height_usize = usize::from(height);
            let len = width_usize.saturating_mul(height_usize);

            if self.framebuffer.len() != len {
                self.framebuffer.resize(len, 0);
            }

            let plan = SceneFramePlan::for_scene(target);
            for px in self.framebuffer.iter_mut().take(len) {
                *px = plan.background;
            }
            if len >= 4 {
                self.framebuffer[0] = plan.accent;
                self.framebuffer[1] = plan.accent;
                self.framebuffer[len - 2] = plan.accent;
                self.framebuffer[len - 1] = plan.accent;
            }
            if show_feedback && len > width_usize.saturating_mul(2) + 2 {
                let start = width_usize + 1;
                self.framebuffer[start] = 0x7BEF;
                self.framebuffer[start + 1] = 0x7BEF;
                self.framebuffer[start + width_usize] = 0x7BEF;
                self.framebuffer[start + width_usize + 1] = 0x7BEF;
            }
            let _ = self.display.flush_region(
                Rect {
                    x: 0,
                    y: 0,
                    w: width,
                    h: height,
                },
                &self.framebuffer,
            );
            self.current_scene = Some(target);
            self.force_next_render = false;
            self.stats_.scenes_rendered = self.stats_.scenes_rendered.saturating_add(1);
            return true;
        }
        false
    }

    fn stats(&self) -> &RenderStats {
        &self.stats_
    }
}

fn scene_to_index(scene: crate::ui::Scene) -> i32 {
    match scene {
        crate::ui::Scene::Boot => 0,
        crate::ui::Scene::Paired => 1,
        crate::ui::Scene::Conversation => 2,
        crate::ui::Scene::Settings => 3,
        crate::ui::Scene::Error => 4,
        crate::ui::Scene::Offline => 5,
    }
}

slint::include_modules!();

pub struct SlintRenderer {
    window: Rc<MinimalSoftwareWindow>,
    app: MicroClawApp,
    display: Box<dyn DisplayDriver>,
    framebuffer: Vec<Rgb565Pixel>,
    current_scene: Option<crate::ui::Scene>,
    stats_: RenderStats,
}

impl SlintRenderer {
    pub fn new(window: Rc<MinimalSoftwareWindow>, mut display: Box<dyn DisplayDriver>) -> Self {
        let _ = display.init();
        let _ = display.set_brightness(128);
        let width = usize::from(display.width());
        let height = usize::from(display.height());
        let framebuffer = vec![Rgb565Pixel::default(); width.saturating_mul(height)];

        let app = MicroClawApp::new().expect("Failed to create MicroClawApp");

        Self {
            window,
            app,
            display,
            framebuffer,
            current_scene: None,
            stats_: RenderStats::new(),
        }
    }

    pub fn window(&self) -> &Rc<MinimalSoftwareWindow> {
        &self.window
    }

    pub fn app(&self) -> &MicroClawApp {
        &self.app
    }
}

impl SceneRenderer for SlintRenderer {
    fn render(&mut self, state: &RuntimeState, _now_ms: u64) -> bool {
        self.stats_.frames_requested = self.stats_.frames_requested.saturating_add(1);
        let target = state.scene();
        let scene_index = scene_to_index(target);

        // Update Slint property if scene changed
        if self.current_scene != Some(target) {
            self.app.set_current_scene(scene_index);
            self.window.request_redraw();
            self.current_scene = Some(target);
        }

        slint::platform::update_timers_and_animations();

        let drew = crate::slint_platform::render_to_display(
            &self.window,
            self.display.as_mut(),
            &mut self.framebuffer,
        );

        if drew {
            self.stats_.scenes_rendered = self.stats_.scenes_rendered.saturating_add(1);
        }
        drew
    }

    fn stats(&self) -> &RenderStats {
        &self.stats_
    }
}
