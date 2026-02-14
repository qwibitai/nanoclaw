use std::rc::Rc;

use slint::platform::software_renderer::{MinimalSoftwareWindow, Rgb565Pixel, RepaintBufferType};
use slint::platform::{Platform, PlatformError, PointerEventButton, WindowAdapter, WindowEvent};
use slint::LogicalPosition;

use crate::drivers::{DisplayDriver, Rect};
use microclaw_protocol::{TouchEventPayload, TouchPhase};

/// Slint platform adapter that bridges to our `DisplayDriver`.
///
/// Owns the `MinimalSoftwareWindow` and a full-resolution RGB565 framebuffer.
/// On each render cycle, Slint paints into the framebuffer and we flush the
/// dirty region to the display hardware.
pub struct MicroClawPlatform {
    window: Rc<MinimalSoftwareWindow>,
}

impl MicroClawPlatform {
    pub fn new() -> Self {
        let window = MinimalSoftwareWindow::new(RepaintBufferType::ReusedBuffer);
        window.set_size(slint::PhysicalSize::new(
            u32::from(crate::display::DISPLAY_WIDTH),
            u32::from(crate::display::DISPLAY_HEIGHT),
        ));
        Self { window }
    }

    pub fn window(&self) -> &Rc<MinimalSoftwareWindow> {
        &self.window
    }
}

impl Platform for MicroClawPlatform {
    fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, PlatformError> {
        Ok(self.window.clone())
    }
}

/// Render the Slint scene into the framebuffer and flush to display.
///
/// Returns `true` if pixels were actually drawn (Slint had pending changes).
pub fn render_to_display(
    window: &MinimalSoftwareWindow,
    display: &mut dyn DisplayDriver,
    framebuffer: &mut [Rgb565Pixel],
) -> bool {
    let width = display.width();
    let stride = usize::from(width);

    window.draw_if_needed(|renderer| {
        renderer.render(framebuffer, stride);
        let _ = display.flush_region(
            Rect {
                x: 0,
                y: 0,
                w: width,
                h: display.height(),
            },
            // SAFETY: Rgb565Pixel is repr(transparent) around u16
            unsafe {
                core::slice::from_raw_parts(
                    framebuffer.as_ptr() as *const u16,
                    framebuffer.len(),
                )
            },
        );
    })
}

/// Dispatch a touch event to the Slint window.
pub fn dispatch_touch(
    window: &MinimalSoftwareWindow,
    event: WindowEvent,
) {
    window.dispatch_event(event);
}

/// Convert a `TouchEventPayload` to a Slint `WindowEvent`.
///
/// Returns `None` for `Cancel` and `Unknown` phases which have no Slint equivalent.
pub fn touch_to_window_event(payload: &TouchEventPayload) -> Option<WindowEvent> {
    let position = LogicalPosition::new(f32::from(payload.x), f32::from(payload.y));

    match payload.phase {
        TouchPhase::Down => Some(WindowEvent::PointerPressed {
            position,
            button: PointerEventButton::Left,
        }),
        TouchPhase::Move => Some(WindowEvent::PointerMoved { position }),
        TouchPhase::Up => Some(WindowEvent::PointerReleased {
            position,
            button: PointerEventButton::Left,
        }),
        TouchPhase::Cancel | TouchPhase::Unknown => None,
    }
}
