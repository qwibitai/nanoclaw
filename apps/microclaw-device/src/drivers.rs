use crate::display::DisplayPoint;

use microclaw_protocol::{TouchEventPayload, TouchPhase};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

#[derive(Debug)]
pub enum DriverError {
    NotInitialized,
    Unsupported(&'static str),
    ChannelClosed,
    InvalidPayload(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayRotation {
    Portrait,
    Landscape,
    PortraitFlipped,
    LandscapeFlipped,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TouchTransform {
    pub swap_xy: bool,
    pub invert_x: bool,
    pub invert_y: bool,
}

impl TouchTransform {
    pub fn apply(&self, mut x: u16, mut y: u16, width: u16, height: u16) -> (u16, u16) {
        if self.swap_xy {
            std::mem::swap(&mut x, &mut y);
            std::mem::swap(&mut width, &mut height);
        }

        if self.invert_x {
            x = width.saturating_sub(1).saturating_sub(x);
        }

        if self.invert_y {
            y = height.saturating_sub(1).saturating_sub(y);
        }

        (x, y)
    }
}

pub trait DisplayDriver {
    fn init(&mut self) -> Result<(), DriverError>;
    fn deinit(&mut self) -> Result<(), DriverError>;
    fn width(&self) -> u16;
    fn height(&self) -> u16;
    fn rotation(&self) -> DisplayRotation {
        DisplayRotation::Portrait
    }
    fn set_brightness(&mut self, level: u8) -> Result<(), DriverError>;
    fn flush_region(&mut self, _region: Rect, _data: &[u16]) -> Result<(), DriverError>;
}

pub trait TouchDriver {
    fn init(&mut self) -> Result<(), DriverError>;
    fn deinit(&mut self) -> Result<(), DriverError>;
    fn set_transform(&mut self, _transform: TouchTransform) {}
    fn is_interrupt_pending(&mut self) -> bool {
        false
    }
    fn clear_interrupt(&mut self) {}
    fn read_event(&mut self) -> Option<TouchEventPayload>;
}

#[derive(Clone, Debug)]
pub struct HostTouchEvent {
    pub point: DisplayPoint,
    pub phase: TouchPhase,
    pub pressure: Option<u16>,
    pub pointer_id: u8,
    pub raw_timestamp_ms: Option<u64>,
}

#[cfg(not(feature = "esp"))]
pub mod host {
    use super::{DisplayDriver, DriverError, HostTouchEvent, Rect, TouchDriver, TouchTransform};
    use crate::display::{DISPLAY_HEIGHT, DISPLAY_WIDTH};
    use microclaw_protocol::TouchEventPayload;
    use std::collections::VecDeque;

    pub struct HostDisplayDriver {
        inited: bool,
        brightness: u8,
    }

    impl HostDisplayDriver {
        pub fn new() -> Self {
            Self {
                inited: false,
                brightness: 128,
            }
        }
    }

    impl DisplayDriver for HostDisplayDriver {
        fn init(&mut self) -> Result<(), DriverError> {
            self.inited = true;
            Ok(())
        }

        fn deinit(&mut self) -> Result<(), DriverError> {
            self.inited = false;
            Ok(())
        }

        fn width(&self) -> u16 {
            DISPLAY_WIDTH
        }

        fn height(&self) -> u16 {
            DISPLAY_HEIGHT
        }

        fn set_brightness(&mut self, level: u8) -> Result<(), DriverError> {
            if !self.inited {
                return Err(DriverError::NotInitialized);
            }
            self.brightness = level;
            Ok(())
        }

        fn flush_region(&mut self, _region: Rect, _data: &[u16]) -> Result<(), DriverError> {
            if !self.inited {
                return Err(DriverError::NotInitialized);
            }
            Ok(())
        }
    }

    pub struct HostTouchDriver {
        events: VecDeque<HostTouchEvent>,
    }

    impl HostTouchDriver {
        pub fn new() -> Self {
            Self {
                events: VecDeque::new(),
            }
        }

        pub fn push_host_event(&mut self, event: HostTouchEvent) {
            self.events.push_back(event);
        }

        pub fn push_payload(&mut self, payload: TouchEventPayload) {
            self.events.push_back(HostTouchEvent {
                point: crate::display::DisplayPoint {
                    x: payload.x,
                    y: payload.y,
                },
                phase: payload.phase,
                pressure: payload.pressure,
                pointer_id: payload.pointer_id,
                raw_timestamp_ms: payload.raw_timestamp_ms,
            });
        }
    }

    impl TouchDriver for HostTouchDriver {
        fn set_transform(&mut self, _transform: TouchTransform) {}

        fn is_interrupt_pending(&mut self) -> bool {
            !self.events.is_empty()
        }

        fn init(&mut self) -> Result<(), DriverError> {
            Ok(())
        }

        fn deinit(&mut self) -> Result<(), DriverError> {
            self.events.clear();
            Ok(())
        }

        fn read_event(&mut self) -> Option<TouchEventPayload> {
            self.events.pop_front().map(|event| TouchEventPayload {
                pointer_id: event.pointer_id,
                phase: event.phase,
                x: event.point.x,
                y: event.point.y,
                pressure: event.pressure,
                raw_timestamp_ms: event.raw_timestamp_ms,
            })
        }
    }
}

#[cfg(feature = "esp")]
pub mod esp {
    use super::{
        DisplayDriver, DisplayRotation, DriverError, Rect, TouchDriver, TouchTransform,
    };
    use crate::boards::{BoardConfig, WAVESHARE_1_85C_V3};
    use std::collections::VecDeque;
    use microclaw_protocol::TouchEventPayload;

    pub struct EspDisplayDriver {
        inited: bool,
        brightness: u8,
        rotation: DisplayRotation,
        config: BoardConfig,
        width: u16,
        height: u16,
    }

    impl EspDisplayDriver {
        pub fn new() -> Self {
            Self {
                inited: false,
                brightness: 128,
                rotation: DisplayRotation::Portrait,
                config: WAVESHARE_1_85C_V3,
                width: WAVESHARE_1_85C_V3.display.width,
                height: WAVESHARE_1_85C_V3.display.height,
            }
        }

        pub fn with_config(config: BoardConfig) -> Self {
            Self {
                inited: false,
                brightness: 128,
                rotation: config.rotation,
                width: config.display.width,
                height: config.display.height,
                config,
            }
        }

        pub fn config(&self) -> &BoardConfig {
            &self.config
        }
    }

    impl DisplayDriver for EspDisplayDriver {
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
            self.rotation
        }

        fn set_brightness(&mut self, _level: u8) -> Result<(), DriverError> {
            if !self.inited {
                return Err(DriverError::NotInitialized);
            }
            Ok(())
        }

        fn flush_region(&mut self, _region: Rect, _data: &[u16]) -> Result<(), DriverError> {
            if !self.inited {
                return Err(DriverError::NotInitialized);
            }
            Ok(())
        }
    }

    pub struct EspTouchDriver {
        inited: bool,
        irq_pending: bool,
        transform: TouchTransform,
        queue: VecDeque<TouchEventPayload>,
    }

    impl EspTouchDriver {
        pub fn new() -> Self {
            Self {
                inited: false,
                irq_pending: false,
                transform: TouchTransform::default(),
                queue: VecDeque::new(),
            }
        }

        pub fn trigger_irq_for_test(&mut self) {
            self.irq_pending = true;
        }

        pub fn inject_touch_event(&mut self, event: TouchEventPayload) {
            self.queue.push_back(event);
            self.irq_pending = true;
        }
    }

    impl TouchDriver for EspTouchDriver {
        fn init(&mut self) -> Result<(), DriverError> {
            self.inited = true;
            Ok(())
        }

        fn deinit(&mut self) -> Result<(), DriverError> {
            self.inited = false;
            self.queue.clear();
            Ok(())
        }

        fn set_transform(&mut self, transform: TouchTransform) {
            self.transform = transform;
        }

        fn is_interrupt_pending(&mut self) -> bool {
            self.irq_pending
        }

        fn clear_interrupt(&mut self) {
            self.irq_pending = false;
        }

        fn read_event(&mut self) -> Option<TouchEventPayload> {
            let mut event = self.queue.pop_front()?;
            let (transformed_x, transformed_y) = self.transform.apply(event.x, event.y, 360, 360);
            event.x = transformed_x.min(359);
            event.y = transformed_y.min(359);
            Some(event)
        }
    }

    #[allow(dead_code)]
    fn unsupported() -> DriverError {
        DriverError::Unsupported("esp backends are placeholders")
    }
}
