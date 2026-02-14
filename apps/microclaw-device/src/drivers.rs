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
    pub fn apply(&self, mut x: u16, mut y: u16, mut width: u16, mut height: u16) -> (u16, u16) {
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
        flush_calls: u64,
        init_calls: u64,
    }

    impl HostDisplayDriver {
        pub fn new() -> Self {
            Self {
                inited: false,
                brightness: 128,
                flush_calls: 0,
                init_calls: 0,
            }
        }

        pub fn init_calls(&self) -> u64 {
            self.init_calls
        }

        pub fn flush_calls(&self) -> u64 {
            self.flush_calls
        }
    }

    impl DisplayDriver for HostDisplayDriver {
        fn init(&mut self) -> Result<(), DriverError> {
            self.inited = true;
            self.init_calls = self.init_calls.saturating_add(1);
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
            let x_end = _region.x.saturating_add(_region.w);
            let y_end = _region.y.saturating_add(_region.h);
            let area = usize::from(_region.w).saturating_mul(usize::from(_region.h));
            if _region.w == 0
                || _region.h == 0
                || area != _data.len()
                || x_end > self.width()
                || y_end > self.height()
            {
                return Err(DriverError::InvalidPayload("invalid flush region"));
            }
            self.flush_calls = self.flush_calls.saturating_add(1);
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
    use super::{DisplayDriver, DisplayRotation, DriverError, Rect, TouchDriver, TouchTransform};
    use crate::boards::WAVESHARE_1_85C_V3;
    use microclaw_protocol::TouchEventPayload;
    use std::collections::VecDeque;
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[repr(C)]
    struct St77916Config {
        width: u16,
        height: u16,
        qspi_cs: u8,
        qspi_sclk: u8,
        qspi_sdo: u8,
        qspi_sdi: u8,
        backlight: u8,
        reset_gpio: u8,
    }

    #[repr(C)]
    struct St77916Rect {
        x: u16,
        y: u16,
        w: u16,
        h: u16,
    }

    #[repr(C)]
    struct Cst816Layout {
        sda: u8,
        scl: u8,
        irq: u8,
        reset_gpio: u8,
    }

    type Cst816IsrCallback = extern "C" fn(*mut c_void, u16, u16, u16, u8, u8);

    #[allow(improper_ctypes)]
    extern "C" {
        fn st77916_init(cfg: *const St77916Config, out_handle: *mut *mut c_void) -> i32;
        fn st77916_deinit(handle: *mut c_void) -> i32;
        fn st77916_set_rotation(handle: *mut c_void, rotation: u8) -> i32;
        fn st77916_set_brightness(handle: *mut c_void, level: u8) -> i32;
        fn st77916_flush(
            handle: *mut c_void,
            rect: *const St77916Rect,
            data: *const u16,
            len: usize,
        ) -> i32;
        fn cst816_init(layout: *const Cst816Layout, out_handle: *mut *mut c_void) -> i32;
        fn cst816_deinit(handle: *mut c_void) -> i32;
        fn cst816_set_irq_handler(
            handle: *mut c_void,
            irq_gpio: u8,
            user_ctx: *mut c_void,
            handler: Option<Cst816IsrCallback>,
        ) -> i32;
    }

    #[derive(Debug)]
    pub struct Cst816TouchEvent {
        pub x: u16,
        pub y: u16,
        pub pressure: u16,
        pub pointer_id: u8,
        pub pressed: bool,
    }

    #[derive(Clone)]
    pub struct Cst816IrqQueue {
        inner: Arc<Mutex<VecDeque<Cst816TouchEvent>>>,
    }

    impl Cst816IrqQueue {
        pub fn push_from_isr(&self, event: Cst816TouchEvent) {
            if let Ok(mut q) = self.inner.lock() {
                if q.len() >= 64 {
                    let _ = q.pop_front();
                }
                q.push_back(event);
            }
        }

        pub fn take_next(&self) -> Option<Cst816TouchEvent> {
            self.inner.lock().ok()?.pop_front()
        }
    }

    pub struct EspDisplayDriverBackend {
        handle: Option<*mut c_void>,
    }

    impl EspDisplayDriverBackend {
        pub fn new() -> Self {
            Self { handle: None }
        }
    }

    impl Default for EspDisplayDriverBackend {
        fn default() -> Self {
            Self::new()
        }
    }

    impl DisplayDriver for EspDisplayDriverBackend {
        fn init(&mut self) -> Result<(), DriverError> {
            let cfg = St77916Config {
                width: WAVESHARE_1_85C_V3.display.width,
                height: WAVESHARE_1_85C_V3.display.height,
                qspi_cs: WAVESHARE_1_85C_V3.display.qspi_cs.0,
                qspi_sclk: WAVESHARE_1_85C_V3.display.qspi_sclk.0,
                qspi_sdo: WAVESHARE_1_85C_V3.display.qspi_sdo.0,
                qspi_sdi: WAVESHARE_1_85C_V3.display.qspi_sdi.0,
                backlight: WAVESHARE_1_85C_V3.display.backlight.0,
                reset_gpio: WAVESHARE_1_85C_V3.display.reset.map_or(0xFF, |pin| pin.0),
            };
            let mut handle = ptr::null_mut();
            let rc = unsafe { st77916_init(&cfg, &mut handle) };
            if rc != 0 {
                return Err(DriverError::Unsupported("esp-lcd-st77916 init failed"));
            }
            self.handle = Some(handle);
            let _ = self.set_brightness(200);
            let _ = self.set_rotation(DisplayRotation::Portrait);
            Ok(())
        }

        fn deinit(&mut self) -> Result<(), DriverError> {
            if let Some(handle) = self.handle.take() {
                let rc = unsafe { st77916_deinit(handle) };
                if rc != 0 {
                    return Err(DriverError::Unsupported("esp-lcd-st77916 deinit failed"));
                }
            }
            Ok(())
        }

        fn width(&self) -> u16 {
            WAVESHARE_1_85C_V3.display.width
        }

        fn height(&self) -> u16 {
            WAVESHARE_1_85C_V3.display.height
        }

        fn rotation(&self) -> DisplayRotation {
            WAVESHARE_1_85C_V3.rotation
        }

        fn set_brightness(&mut self, level: u8) -> Result<(), DriverError> {
            let handle = self.handle.ok_or(DriverError::NotInitialized)?;
            let rc = unsafe { st77916_set_brightness(handle, level) };
            if rc != 0 {
                return Err(DriverError::Unsupported(
                    "esp-lcd-st77916 set_brightness failed",
                ));
            }
            Ok(())
        }

        fn flush_region(&mut self, region: Rect, data: &[u16]) -> Result<(), DriverError> {
            let handle = self.handle.ok_or(DriverError::NotInitialized)?;
            let area = usize::from(region.w).saturating_mul(usize::from(region.h));
            let x_end = region.x.saturating_add(region.w);
            let y_end = region.y.saturating_add(region.h);
            if region.w == 0
                || region.h == 0
                || area != data.len()
                || x_end > self.width()
                || y_end > self.height()
            {
                return Err(DriverError::InvalidPayload("invalid flush region"));
            }
            let rect = St77916Rect {
                x: region.x,
                y: region.y,
                w: region.w,
                h: region.h,
            };
            let rc = unsafe { st77916_flush(handle, &rect, data.as_ptr(), data.len()) };
            if rc != 0 {
                return Err(DriverError::Unsupported("esp-lcd-st77916 flush failed"));
            }
            Ok(())
        }
    }

    impl EspDisplayDriverBackend {
        fn set_rotation(&mut self, rotation: DisplayRotation) -> Result<(), DriverError> {
            let handle = self.handle.ok_or(DriverError::NotInitialized)?;
            let val = match rotation {
                DisplayRotation::Portrait => 0,
                DisplayRotation::Landscape => 1,
                DisplayRotation::PortraitFlipped => 2,
                DisplayRotation::LandscapeFlipped => 3,
            };
            let rc = unsafe { st77916_set_rotation(handle, val) };
            if rc != 0 {
                return Err(DriverError::Unsupported("esp-lcd-st77916 rotation failed"));
            }
            Ok(())
        }
    }

    pub struct EspDisplayDriver {
        backend: EspDisplayDriverBackend,
        inited: bool,
        brightness: u8,
        flush_calls: u64,
        init_calls: u64,
        last_region_area: Option<u32>,
        width: u16,
        height: u16,
        rotation: DisplayRotation,
    }

    impl EspDisplayDriver {
        pub fn new() -> Self {
            Self {
                backend: EspDisplayDriverBackend::new(),
                inited: false,
                brightness: 128,
                flush_calls: 0,
                init_calls: 0,
                last_region_area: None,
                width: WAVESHARE_1_85C_V3.display.width,
                height: WAVESHARE_1_85C_V3.display.height,
                rotation: WAVESHARE_1_85C_V3.rotation,
            }
        }

        pub fn init_calls(&self) -> u64 {
            self.init_calls
        }

        pub fn flush_calls(&self) -> u64 {
            self.flush_calls
        }

        pub fn last_region_area(&self) -> Option<u32> {
            self.last_region_area
        }
    }

    impl DisplayDriver for EspDisplayDriver {
        fn init(&mut self) -> Result<(), DriverError> {
            self.backend.init()?;
            self.inited = true;
            self.init_calls = self.init_calls.saturating_add(1);
            Ok(())
        }

        fn deinit(&mut self) -> Result<(), DriverError> {
            self.inited = false;
            self.backend.deinit()
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

        fn set_brightness(&mut self, level: u8) -> Result<(), DriverError> {
            if !self.inited {
                return Err(DriverError::NotInitialized);
            }
            self.backend.set_brightness(level)?;
            self.brightness = level;
            Ok(())
        }

        fn flush_region(&mut self, region: Rect, data: &[u16]) -> Result<(), DriverError> {
            if !self.inited {
                return Err(DriverError::NotInitialized);
            }
            self.backend.flush_region(region, data)?;
            let _ = self.brightness;
            self.flush_calls = self.flush_calls.saturating_add(1);
            self.last_region_area = Some(u32::from(region.w).saturating_mul(u32::from(region.h)));
            Ok(())
        }
    }

    pub struct EspTouchDriver {
        inited: bool,
        irq_pending: bool,
        transform: TouchTransform,
        queue: VecDeque<TouchEventPayload>,
        irq_bridge: Cst816IrqQueue,
        handle: Option<*mut c_void>,
    }

    impl EspTouchDriver {
        pub fn new() -> Self {
            Self {
                inited: false,
                irq_pending: false,
                transform: TouchTransform::default(),
                queue: VecDeque::new(),
                irq_bridge: Cst816IrqQueue {
                    inner: Arc::new(Mutex::new(VecDeque::new())),
                },
                handle: None,
            }
        }

        pub fn irq_bridge(&self) -> Cst816IrqQueue {
            self.irq_bridge.clone()
        }

        pub fn from_touch_payload_to_touch_event(sample: Cst816TouchEvent) -> TouchEventPayload {
            TouchEventPayload {
                pointer_id: sample.pointer_id,
                phase: if sample.pressed {
                    microclaw_protocol::TouchPhase::Move
                } else {
                    microclaw_protocol::TouchPhase::Up
                },
                x: sample.x,
                y: sample.y,
                pressure: Some(sample.pressure),
                raw_timestamp_ms: Some(now_ms_esp()),
            }
        }
    }

    impl TouchDriver for EspTouchDriver {
        fn init(&mut self) -> Result<(), DriverError> {
            let config = Cst816Layout {
                sda: WAVESHARE_1_85C_V3.touch.i2c_sda.0,
                scl: WAVESHARE_1_85C_V3.touch.i2c_scl.0,
                irq: WAVESHARE_1_85C_V3.touch.irq.0,
                reset_gpio: WAVESHARE_1_85C_V3.touch.reset.map_or(0xFF, |pin| pin.0),
            };
            let mut handle = ptr::null_mut();
            let rc = unsafe { cst816_init(&config as *const _, &mut handle as *mut _) };
            if rc != 0 {
                return Err(DriverError::Unsupported("cst816 init failed"));
            }
            self.handle = Some(handle);
            self.inited = true;

            // Pass a stable pointer to the Arc's inner allocation so `user_ctx` stays valid
            // even if `EspTouchDriver` is moved after init.
            let user_ctx = Arc::as_ptr(&self.irq_bridge.inner) as *mut c_void;
            let _ = unsafe {
                cst816_set_irq_handler(
                    handle,
                    WAVESHARE_1_85C_V3.touch.irq.0,
                    user_ctx,
                    Some(cst816_irq_handler),
                )
            };
            Ok(())
        }

        fn deinit(&mut self) -> Result<(), DriverError> {
            self.inited = false;
            self.queue.clear();
            self.irq_pending = false;
            if let Some(handle) = self.handle.take() {
                let rc = unsafe { cst816_deinit(handle) };
                if rc != 0 {
                    return Err(DriverError::Unsupported("cst816 deinit failed"));
                }
            }
            Ok(())
        }

        fn set_transform(&mut self, transform: TouchTransform) {
            self.transform = transform;
        }

        fn is_interrupt_pending(&mut self) -> bool {
            self.irq_pending
                || !self.queue.is_empty()
                || !self.irq_bridge.inner.lock().map_or(true, |q| q.is_empty())
        }

        fn clear_interrupt(&mut self) {
            self.irq_pending = false;
        }

        fn read_event(&mut self) -> Option<TouchEventPayload> {
            if self.irq_bridge.inner.lock().ok()?.is_empty() && self.queue.is_empty() {
                return None;
            }
            let raw = self
                .irq_bridge
                .take_next()
                .or_else(|| self.queue.pop_front())
                .map(Self::from_touch_payload_to_touch_event)?;
            let mut transformed = raw;
            let (x, y) = self.transform.apply(
                transformed.x,
                transformed.y,
                WAVESHARE_1_85C_V3.display.width,
                WAVESHARE_1_85C_V3.display.height,
            );
            transformed.x = x;
            transformed.y = y;
            Some(transformed)
        }
    }

    extern "C" fn cst816_irq_handler(
        user_ctx: *mut c_void,
        x: u16,
        y: u16,
        z: u16,
        pointer: u8,
        pressed: u8,
    ) {
        let Some(queue) =
            (unsafe { (user_ctx as *const Mutex<VecDeque<Cst816TouchEvent>>).as_ref() })
        else {
            return;
        };

        if let Ok(mut q) = queue.lock() {
            if q.len() >= 64 {
                let _ = q.pop_front();
            }
            q.push_back(Cst816TouchEvent {
                x,
                y,
                pressure: z,
                pointer_id: pointer,
                pressed: pressed != 0,
            });
        }
    }

    fn now_ms_esp() -> u64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(value) => value.as_millis() as u64,
            Err(_) => 0,
        }
    }
}
